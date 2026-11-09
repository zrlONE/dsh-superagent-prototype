/** Workflow: an independent reviewer for ready tickets, CI-fix and review round limits, and a watchdog for stuck assignments. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { latestAssignment, latestReport, liveTicket, runningAssignment, ticketStage, type Assignment, type Ticket, type Trigger }
  from '../core/index.ts'
import type { EngineForExecutor, Executor } from '../core/index.ts'
import type { HealthEntry } from '../infra/health.ts'
import { KV, type WorkflowState } from '../kv.ts'
import { projectFor, type Settings } from '../policy.ts'
import { pullsOf } from '../sources/github-pull.ts'
import type { Store } from './store.ts'
import { reviewerSessionId, type Sessions } from './sessions.ts'
import type { ReviewVerdict } from './tools/reviewer.ts'

const now = (): string => new Date().toISOString()

/** Host dependencies used by `Workflow`. */
export interface WorkflowHost {
  /** Cordis context used to stop reviewer Sessions on shutdown. */
  readonly context: Context
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'settings' | 'get' | 'set' | 'atomic'>
  /** Reports an exhausted ticket as failed, and notes review changes to its writer. */
  readonly engine: Pick<EngineForExecutor, 'report' | 'note'>
  /** Stops an assignment the watchdog or a round limit ends. */
  readonly executor: Pick<Executor, 'stop'>
  readonly sessions: Pick<Sessions, 'ensure' | 'prompt' | 'relay'>
  readonly health: HealthEntry
  readonly lifetime: AbortSignal
  closing(): boolean
  paused(): boolean
  now?(): string
}

/** The latest activity time of a running assignment: its start, delivery, idle end, report and latest Input. */
export function lastActivity(ticket: Pick<Ticket, 'inputs'>, assignment: Assignment): string {
  const times = [assignment.startedAt, assignment.deliveredAt, assignment.idleAt, assignment.report?.at,
    ...ticket.inputs.map(input => input.at)].filter((at): at is string => typeof at === 'string' && Number.isFinite(Date.parse(at)))
  return times.sort().at(-1) ?? assignment.createdAt
}
/** The running assignment of a working ticket whose last activity is older than `timeoutMinutes`. */
export function watchdogDue(ticket: Ticket, at: string, timeoutMinutes: number): Assignment | undefined {
  if (ticketStage(ticket).stage !== 'working') return undefined
  const assignment = runningAssignment(ticket)
  if (!assignment) return undefined
  const since = Date.parse(lastActivity(ticket, assignment))
  return Number.isFinite(since) && Date.parse(at) - since >= timeoutMinutes * 60_000 ? assignment : undefined
}
/** Distinct CI-failure Triggers that reached a ticket; each is one automatic fix round. */
export function ciFailures(ticket: Pick<Ticket, 'inputs'>, triggerOf: (id: string) => Trigger | undefined): number {
  return new Set(ticket.inputs.flatMap(input => {
    if (input.kind !== 'trigger') return []
    const trigger = triggerOf(input.triggerId)
    return trigger && trigger.meta.ci === true && /^CI failed\b/.test(trigger.text) ? [trigger.id] : []
  })).size
}
/** A ready report with an open pull request that no review round has covered yet. */
export function reviewDue(ticket: Ticket, state: WorkflowState): boolean {
  const report = latestReport(ticket)
  return !!report && report.state === 'ready' && pullsOf(ticket, true).length > 0 && state.lastReviewedAt !== report.at
}
/** The prompt of one review round: the request, the writer's report, and the verdict the reviewer must record. */
export function reviewPrompt(ticket: Ticket, request: string, repository: string, pr: number, summary: string, round: number, maxRounds: number): string {
  return [`You are the independent reviewer for ticket ${ticket.id}: ${ticket.title}.`,
    `Project repository: ${repository || 'unknown'}. Pull request: #${pr} (branch ${ticket.execution?.name ?? 'unknown'}).`,
    `Review round ${round} of ${maxRounds}.`,
    `Request:\n${request.slice(0, 4000)}`,
    `The writer's latest report:\n${summary.slice(0, 2000)}`,
    'Inspect the checkout in the current directory and the pull request (`gh pr diff <number>`), run the project\'s tests, and judge only whether the change fulfils the request without unrelated or risky changes.',
    'Do not modify files, commit, push, or open a pull request.',
    'End by calling workflow_review exactly once with verdict approve or changes, a summary, and concrete issues.'].join('\n\n')
}

/**
 * Watches open Tickets and drives the review loop: a ready report with a pull request starts a reviewer Session; the
 * reviewer's `workflow_review` verdict either approves, sends concrete changes back to the writer, or fails the ticket when
 * the round limit is reached. It counts CI-failure fix rounds against the same limit and stops an assignment whose last
 * activity is older than the watchdog timeout.
 */
export class Workflow {
  private ticking = false
  constructor(private readonly host: WorkflowHost) {}
  private at(): string { return this.host.now?.() ?? now() }

  /** One workflow pass: watchdog, CI rounds, then a review for a newly ready report. Cheap while disabled. */
  async tick(): Promise<void> {
    if (this.ticking || this.host.closing() || this.host.paused()) return
    const settings = this.host.store.settings()
    if (!settings.workflow.enabled) {
      this.host.health.set({ state: 'ready', detail: 'Workflow is off; enable it in Execution settings', at: this.at() })
      return
    }
    this.ticking = true
    try {
      for (const ticket of this.host.store.tickets.open()) {
        if (!liveTicket(ticket)) { this.forget(ticket.id); continue }
        const state = this.state(ticket.id)
        if (settings.workflow.watchdog) this.watch(ticket, state, settings)
        this.observeCi(ticket, state, settings)
        await this.startReview(ticket, state, settings)
        this.save(ticket.id, state)
      }
      this.host.health.set({ state: 'ready', detail: 'Workflow is watching open Tickets', at: this.at() })
    } catch (error) {
      this.host.health.set({ state: 'error', detail: `Workflow failed: ${String(error).slice(0, 400)}`, at: this.at() })
    } finally { this.ticking = false }
  }

  /** A reviewer's verdict for `ticketId`; called by the reviewer Session's `workflow_review` tool. */
  review(ticketId: string, sessionId: string, verdict: ReviewVerdict): { recorded: boolean; verdict?: string; round?: number; remaining?: number; reason?: string } {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket)) return { recorded: false, reason: 'The ticket ended' }
    const state = this.state(ticketId)
    if (state.status !== 'reviewing' || state.reviewerSessionId !== sessionId) return { recorded: false, reason: 'No review of this round is active' }
    if (state.review?.round === state.reviewRound) return { recorded: false, reason: 'This review round already has a verdict' }
    const settings = this.host.store.settings()
    const at = this.at()
    state.review = { ...verdict, at, round: state.reviewRound }
    const remaining = settings.workflow.maxRounds - state.reviewRound
    if (verdict.verdict === 'approve') {
      state.status = 'approved'
      this.relay(ticket, `Reviewer approved ticket ${ticket.id} (round ${state.reviewRound}/${settings.workflow.maxRounds}): ${verdict.summary}`)
    } else {
      state.status = 'changes'
      if (remaining <= 0) {
        this.fail(ticket, runningAssignment(ticket), `Reviewer requested changes in the last of ${settings.workflow.maxRounds} review rounds; a person must decide.\n\n${verdict.summary}`)
        state.status = 'failed'
      } else {
        // A note is an Input: it wakes the writer, which fixes the issues and reports ready again.
        try {
          this.host.store.atomic(() => this.host.engine.note(ticket.id, `Reviewer requested changes (round ${state.reviewRound}/${settings.workflow.maxRounds}). Fix these issues and report ready again:\n\n${verdict.summary}${verdict.issues.length ? `\n\n- ${verdict.issues.join('\n- ')}` : ''}`))
        } catch (error) { this.host.health.set({ state: 'error', detail: `Could not send review changes: ${String(error)}`, at }) }
        this.relay(ticket, `Reviewer requested changes for ticket ${ticket.id} (round ${state.reviewRound}/${settings.workflow.maxRounds}): ${verdict.summary}`)
      }
    }
    this.save(ticketId, state)
    return { recorded: true, verdict: verdict.verdict, round: state.reviewRound, remaining }
  }

  /** Stop every reviewer Session when the host stops. */
  shutdown(): void {
    for (const ticket of this.host.store.tickets.open()) {
      this.host.context.agents.get(reviewerSessionId(ticket.id) as SessionId)?.cancel({ kind: 'user' }, { keepInbox: true })
    }
  }

  private state(ticketId: string): WorkflowState {
    return this.host.store.get(KV.workflow.state(ticketId)) ?? { reviewRound: 0, ciRound: 0, status: 'idle' }
  }
  private save(ticketId: string, state: WorkflowState): void {
    if (!this.host.store.tickets.get(ticketId)) { this.forget(ticketId); return }
    this.host.store.set(KV.workflow.state(ticketId), state)
  }
  private forget(ticketId: string): void {
    if (this.host.store.get(KV.workflow.state(ticketId))) this.host.store.set(KV.workflow.state(ticketId), undefined)
  }
  private trigger(ticket: Ticket): Trigger | undefined { return this.host.store.triggers.get(ticket.origin.triggerId) }
  private repository(ticket: Ticket): string {
    const repository = this.trigger(ticket)?.meta.repository
    return typeof repository === 'string' ? repository : ''
  }
  private relay(ticket: Ticket, text: string): void {
    try { this.host.sessions.relay(`workflow-${ticket.id}-${this.at()}`, text) } catch { /* The main Session may be closing. */ }
  }

  /** Stop a working ticket whose last activity is older than the timeout. */
  private watch(ticket: Ticket, state: WorkflowState, settings: Settings): void {
    const assignment = watchdogDue(ticket, this.at(), settings.workflow.timeoutMinutes)
    if (!assignment) return
    state.watchdogAt = this.at()
    state.status = 'failed'
    this.fail(ticket, assignment, `The workflow watchdog stopped this assignment: no activity for ${settings.workflow.timeoutMinutes} minutes.`)
  }
  /** Count distinct CI-failure inputs; fail once they exceed the fix-round limit. */
  private observeCi(ticket: Ticket, state: WorkflowState, settings: Settings): void {
    const failures = ciFailures(ticket, id => this.host.store.triggers.get(id))
    if (failures <= state.ciRound) return
    state.ciRound = failures
    if (failures > settings.workflow.maxRounds) {
      if (state.status !== 'failed') this.fail(ticket, runningAssignment(ticket),
        `CI failed ${failures} times, more than the ${settings.workflow.maxRounds} automatic fix rounds; a person must decide.`)
      state.status = 'failed'
    } else this.relay(ticket, `CI failure ${failures}/${settings.workflow.maxRounds} for ticket ${ticket.id}; the writer is fixing it.`)
  }
  /** Start an independent reviewer for a ready report with an open pull request. */
  private async startReview(ticket: Ticket, state: WorkflowState, settings: Settings): Promise<void> {
    if (!reviewDue(ticket, state) || state.status === 'reviewing') return
    const report = latestReport(ticket)!
    if (state.reviewRound >= settings.workflow.maxRounds) {
      if (state.status !== 'failed') this.fail(ticket, runningAssignment(ticket),
        `The ${settings.workflow.maxRounds} review rounds are used up; a person must decide.`)
      state.status = 'failed'
      return
    }
    const round = state.reviewRound + 1
    const sessionId = reviewerSessionId(ticket.id)
    const project = projectFor(settings, this.repository(ticket) || undefined)
    const model = settings.workflow.reviewerModel ?? project.model ?? settings.executor.model
    state.reviewRound = round
    state.lastReviewedAt = report.at
    state.status = 'reviewing'
    state.reviewerSessionId = sessionId
    try {
      await this.host.sessions.ensure(sessionId, ticket.execution?.directory ?? '', `Review: ${ticket.title}`, 'reviewer', model)
      const prompt = reviewPrompt(ticket, this.trigger(ticket)?.text ?? '', this.repository(ticket), pullsOf(ticket, true).at(-1)!,
        report.summary, round, settings.workflow.maxRounds)
      await this.host.sessions.prompt(sessionId, `review:${ticket.id}:${round}`, prompt, 'queue')
      this.relay(ticket, `Review round ${round}/${settings.workflow.maxRounds} started for ticket ${ticket.id}.`)
    } catch (error) {
      // Let the next pass retry the round instead of leaving the ticket waiting on a Session that never started.
      state.lastReviewedAt = undefined
      state.status = 'idle'
      throw error
    }
  }
  /** Report a ticket failed and stop its assignment, handing it to a person. */
  private fail(ticket: Ticket, assignment: Assignment | undefined, summary: string): void {
    try { this.host.store.atomic(() => { this.host.engine.report(ticket.id, { state: 'failed', summary }) }) }
    catch { /* The assignment ended; the relay below still tells the main Session. */ }
    if (assignment) {
      try { this.host.executor.stop(ticket, assignment, 'workflow') } catch { /* Already stopped. */ }
    }
    this.relay(ticket, summary)
  }
  /** The current workflow state of a ticket, for views and tests. */
  stateOf(ticketId: string): WorkflowState { return this.state(ticketId) }
  /** The latest assignment of a ticket, for views and tests. */
  assignmentOf(ticket: Ticket): Assignment | undefined { return latestAssignment(ticket) }
}
