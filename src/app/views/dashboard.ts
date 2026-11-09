/** Dashboard view: cross-project Tickets, agent Sessions, workflow state, and token usage for the standalone board. */
import { canRetry, latestReport, ticketStage } from '../../core/index.ts'
import { workerSessionId } from '../../executor/dsh.ts'
import { KV, type UsageTotals, type WorkflowState } from '../../kv.ts'
import { activeProjectOf, projectFor, projectsOf } from '../../policy.ts'
import type { Health } from '../../sources/host.ts'
import { reviewerSessionId } from '../sessions.ts'
import type { Store } from '../store.ts'
import type { UsageSnapshot } from '../usage.ts'
import { preview } from './text.ts'

/** Host dependencies used by `dashboardView`. */
export interface DashboardHost {
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'settings' | 'get'>
  readonly usage: UsageSnapshot
  readonly health: Record<string, Health>
  readonly masterId: string
  /** The live DSH status of a Session, when loaded. */
  status(sessionId: string): string | undefined
}
/** The token totals of one Session, zero when it has used no model calls. */
const zero = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 })
const sessionOf = (usage: UsageSnapshot, sessionId: string) => usage.sessions.find(session => session.sessionId === sessionId)
const totalsOf = (usage: UsageSnapshot, sessionId: string): UsageTotals => sessionOf(usage, sessionId) ?? zero()
const plus = (a: UsageTotals, b: UsageTotals): UsageTotals => ({ input: a.input + b.input, output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, reasoning: a.reasoning + b.reasoning, calls: a.calls + b.calls })

/**
 * Builds the standalone dashboard's data: every project with its work, open and recently ended Tickets with their
 * project, agent Sessions, workflow state and token usage, the agents behind them, and the usage totals.
 */
export function dashboardView(host: DashboardHost) {
  const { store, usage } = host
  const settings = store.settings()
  const projects = projectsOf(settings)
  const active = activeProjectOf(settings)
  const rows = store.tickets.list().sort((a, b) => Number(!!a.ended) - Number(!!b.ended) || b.updatedAt.localeCompare(a.updatedAt))
  const recent = rows.filter(ticket => !ticket.ended).concat(rows.filter(ticket => ticket.ended).slice(0, 20))
  const tickets = recent.map(ticket => {
    const trigger = store.triggers.get(ticket.origin.triggerId)
    const repository = typeof trigger?.meta.repository === 'string' ? trigger.meta.repository : ''
    const project = projectFor(settings, repository || undefined)
    const stage = ticketStage(ticket)
    const report = latestReport(ticket)
    const workflow = store.get(KV.workflow.state(ticket.id)) as WorkflowState | undefined
    const workerId = workerSessionId(ticket.id), reviewerId = reviewerSessionId(ticket.id)
    const worker = sessionOf(usage, workerId), reviewer = sessionOf(usage, reviewerId)
    const workerUsage = worker ?? zero(), reviewerUsage = reviewer ?? zero()
    return {
      id: ticket.id, title: ticket.title, project: { id: project.id, name: project.name, repository: project.repository || repository },
      state: ticket.ended ? 'ended' as const : 'open' as const, stage: stage.stage, action: 'action' in stage ? stage.action : undefined, summary: preview(report?.summary ?? '', 240),
      url: trigger?.url, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt, open: !ticket.ended,
      actions: { retry: !ticket.ended && canRetry(ticket), stop: !ticket.ended },
      workflow: workflow ? { status: workflow.status, reviewRound: workflow.reviewRound, ciRound: workflow.ciRound,
        verdict: workflow.review?.verdict, summary: workflow.review?.summary ? preview(workflow.review.summary, 200) : undefined } : undefined,
      agents: [
        { role: 'worker' as const, sessionId: workerId, status: host.status(workerId), provider: worker?.provider, model: worker?.model, usage: workerUsage },
        ...(workflow && (workflow.reviewerSessionId || workflow.review)
          ? [{ role: 'reviewer' as const, sessionId: reviewerId, status: host.status(reviewerId), provider: reviewer?.provider, model: reviewer?.model, usage: reviewerUsage }]
          : []),
      ],
      tokens: plus(workerUsage, reviewerUsage),
    }
  })
  const projectRows = projects.map(project => {
    const items = tickets.filter(ticket => ticket.project.id === project.id)
    return { id: project.id, name: project.name, repository: project.repository, active: project.id === active.id, enabled: project.enabled,
      open: items.filter(ticket => ticket.open).length, working: items.filter(ticket => ticket.stage === 'working').length,
      review: items.filter(ticket => ticket.stage === 'person' && ticket.action === 'review').length,
      failed: items.filter(ticket => ticket.stage === 'person' && ticket.action === 'failed').length,
      tokens: items.reduce((sum, ticket) => plus(sum, ticket.tokens), zero()) }
  })
  const agents = [
    { role: 'orchestrator' as const, sessionId: host.masterId, ticketId: undefined, status: host.status(host.masterId),
      usage: totalsOf(usage, host.masterId) },
    ...tickets.flatMap(ticket => ticket.agents.map(agent => ({ ...agent, ticketId: ticket.id }))),
  ]
  return {
    at: new Date().toISOString(), paused: settings.paused, activeProject: active.id,
    workflow: { enabled: settings.workflow.enabled, maxRounds: settings.workflow.maxRounds, watchdog: settings.workflow.watchdog,
      timeoutMinutes: settings.workflow.timeoutMinutes },
    health: host.health, projects: projectRows, tickets, agents, usage: usage as UsageSnapshot,
  }
}
export type DashboardView = ReturnType<typeof dashboardView>
export type DashboardTicket = DashboardView['tickets'][number]
