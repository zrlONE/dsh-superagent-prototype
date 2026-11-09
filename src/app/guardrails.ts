/** Proactive alerts for work that needs a person, and token budgets that stop runaway spending. */
import type { EngineForExecutor, Executor, Ticket } from '../core/index.ts'
import { key, latestReport, liveTicket, runningAssignment } from '../core/index.ts'
import type { HealthEntry } from '../infra/health.ts'
import { KV, type AlertState, type DailyAlertState, type UsageTotals } from '../kv.ts'
import type { Settings } from '../policy.ts'
import { workerSessionId } from '../executor/dsh.ts'
import type { Outbox } from './outbox.ts'
import { reviewerSessionId } from './sessions.ts'
import type { Store } from './store.ts'
import type { UsageMeter } from './usage.ts'

/** All tokens a Usage record or snapshot bucket reports: input, output, cache reads/writes and reasoning. */
export const tokensOf = (usage: Pick<UsageTotals, 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning'> | undefined): number =>
  usage ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite + usage.reasoning : 0
const chinese = (text: string): boolean => /\p{Script=Han}/u.test(text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)

/** Host dependencies used by `Guardrails`. */
export interface GuardrailsHost {
  readonly store: Pick<Store, 'settings' | 'tickets' | 'triggers' | 'get' | 'set' | 'atomic'>
  readonly outbox: Pick<Outbox, 'send' | 'status'>
  readonly usage: Pick<UsageMeter, 'session' | 'snapshot'>
  /** Reports a Ticket that is over its token budget as failed. */
  readonly engine: Pick<EngineForExecutor, 'report'>
  /** Stops the assignment a budget limit ends. */
  readonly executor: Pick<Executor, 'stop'>
  readonly health: HealthEntry
  closing(): boolean
  paused(): boolean
  /** Pauses processing once a daily budget is exceeded. */
  pause(): void
  now?(): string
}

/**
 * Watches open Tickets for work that needs a person and for token budgets. Alerts are posted into the Ticket's own
 * conversations so the person sees them where the request was written; each alert is recorded per Ticket so a repeated
 * pass does not post it again. A Ticket over its budget is reported failed and stopped; a day over its budget pauses
 * processing and alerts through the most recently updated open Ticket.
 */
export class Guardrails {
  private ticking = false
  constructor(private readonly host: GuardrailsHost) {}
  private at(): string { return this.host.now?.() ?? new Date().toISOString() }
  private state(ticketId: string): AlertState { return this.host.store.get(KV.alerts.ticket(ticketId)) ?? {} }
  private save(ticketId: string, state: AlertState): void { this.host.store.set(KV.alerts.ticket(ticketId), state) }
  /** A Ticket's worker and reviewer tokens; subagent Sessions are not attributed to it. */
  ticketTokens(ticketId: string): number {
    return tokensOf(this.host.usage.session(workerSessionId(ticketId))) + tokensOf(this.host.usage.session(reviewerSessionId(ticketId)))
  }
  private say(ticket: Ticket, zh: string, en: string): string {
    const request = this.host.store.triggers.get(ticket.origin.triggerId)?.text ?? ticket.title
    return chinese(request) ? zh : en
  }
  /** One guardrails pass: daily budget, then each open Ticket's budget and alerts. Cheap while both features are off. */
  tick(): void {
    if (this.ticking || this.host.closing()) return
    const settings = this.host.store.settings()
    const { alerts, budget } = settings.guardrails
    if (!alerts.enabled && !budget.dailyTokens && !budget.ticketTokens) {
      this.host.health.set({ state: 'ready', detail: 'Guardrails are off', at: this.at() })
      return
    }
    this.ticking = true
    try {
      if (this.daily(settings)) {
        this.host.health.set({ state: 'error', detail: 'The daily token budget is exceeded; processing is paused', at: this.at() })
        return
      }
      let over = false
      for (const ticket of this.host.store.tickets.open()) {
        if (!liveTicket(ticket)) continue
        if (budget.ticketTokens && this.budget(ticket, settings)) { over = true; continue }
        this.report(ticket, settings)
        this.attention(ticket, settings)
        this.delivery(ticket, settings)
      }
      this.host.health.set(over ? { state: 'error', detail: 'A Ticket is over its token budget', at: this.at() }
        : { state: 'ready', detail: 'Guardrails are watching open Tickets', at: this.at() })
    } catch (error) {
      this.host.health.set({ state: 'error', detail: `Guardrails failed: ${String(error).slice(0, 400)}`, at: this.at() })
    } finally { this.ticking = false }
  }
  /** Alert once per day/limit when today's tokens exceed the daily budget, and pause processing once. */
  private daily(settings: Settings): boolean {
    const limit = settings.guardrails.budget.dailyTokens
    if (!limit) return false
    const used = tokensOf(this.host.usage.snapshot().today)
    if (used < limit) return false
    const day = this.at().slice(0, 10)
    const previous = this.host.store.get(KV.alerts.daily)
    const state: DailyAlertState = { day, limit, tokens: used, paused: previous?.day === day ? previous.paused : false }
    if (previous?.day !== day || previous.limit !== limit) this.dailyAlert(settings, used, limit, day)
    if (!state.paused && !this.host.paused()) {
      state.paused = true
      try { this.host.pause() } catch { /* The pause is retried on the next pass; health reports the budget either way. */ }
    }
    this.host.store.set(KV.alerts.daily, state)
    return true
  }
  private dailyAlert(settings: Settings, used: number, limit: number, day: string): void {
    if (!settings.guardrails.alerts.enabled || !settings.guardrails.alerts.budget) return
    const ticket = [...this.host.store.tickets.open()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
    if (!ticket) return
    // The alert language follows the request that produced the most recent open Ticket.
    this.send(ticket, `daily:${day}:${limit}`, this.say(ticket,
      `今日 token 已超过预算（${used}/${limit}），处理已暂停。提高预算或等待次日。`,
      `Today's token budget is exceeded (${used}/${limit}); processing is paused. Raise the budget or wait for the next day.`))
  }
  /** Report and stop one Ticket over its token budget, alerting once per limit. */
  private budget(ticket: Ticket, settings: Settings): boolean {
    const limit = settings.guardrails.budget.ticketTokens
    if (!limit) return false
    const used = this.ticketTokens(ticket.id)
    if (used < limit) return false
    const state = this.state(ticket.id), marker = String(limit)
    if (state.budget !== marker) {
      const summary = `Token budget exceeded: ${used}/${limit} tokens across this Ticket's worker and reviewer. The Ticket was stopped; raise the budget or decide the remaining work.`
      try { this.host.store.atomic(() => this.host.engine.report(ticket.id, { state: 'failed', summary })) }
      catch { /* The assignment may already have ended; the alert still hands the Ticket to a person. */ }
      const assignment = runningAssignment(ticket)
      if (assignment) try { this.host.executor.stop(ticket, assignment, 'budget') } catch { /* Already stopped. */ }
      if (settings.guardrails.alerts.enabled && settings.guardrails.alerts.budget) this.send(ticket, `budget:${marker}`, this.say(ticket,
        `工单 ${ticket.id} 已超过 token 预算（${used}/${limit}），已停止。提高预算后重试，或由人接手剩余工作。`,
        `Ticket ${ticket.id} is over its token budget (${used}/${limit}) and was stopped. Raise the budget and retry, or decide the remaining work.`))
      state.budget = marker
      this.save(ticket.id, state)
    }
    return true
  }
  /** Alert once for a failed or blocked report. */
  private report(ticket: Ticket, settings: Settings): void {
    if (!settings.guardrails.alerts.enabled || !settings.guardrails.alerts.failures) return
    const report = latestReport(ticket)
    if (!report || (report.state !== 'failed' && report.state !== 'blocked')) return
    const marker = `${report.state}:${report.at}`, state = this.state(ticket.id)
    if (state.report === marker) return
    this.send(ticket, `report:${marker}`, this.say(ticket,
      `工单 ${ticket.id} ${report.state === 'failed' ? '失败' : '被阻塞'}，需要人工处理：${report.summary}`,
      `Ticket ${ticket.id} ${report.state === 'failed' ? 'failed' : 'is blocked'} and needs a person: ${report.summary}`))
    state.report = marker
    this.save(ticket.id, state)
  }
  /** Alert once for the current question a worker asks a person. */
  private attention(ticket: Ticket, settings: Settings): void {
    if (!settings.guardrails.alerts.enabled || !settings.guardrails.alerts.attention || !ticket.attention) return
    // The main Session may already answer the question through the ordinary attention reply; do not post it twice.
    if (this.host.outbox.status(key('attention-reply', ticket.attention.id))) return
    const marker = ticket.attention.id, state = this.state(ticket.id)
    if (state.attention === marker) return
    this.send(ticket, `attention:${marker}`, this.say(ticket,
      `工单 ${ticket.id} 需要你回复：${ticket.attention.question}`,
      `Ticket ${ticket.id} needs your answer: ${ticket.attention.question}`))
    state.attention = marker
    this.save(ticket.id, state)
  }
  /** Alert once for an Input that could not reach the worker. */
  private delivery(ticket: Ticket, settings: Settings): void {
    if (!settings.guardrails.alerts.enabled || !settings.guardrails.alerts.failures || !ticket.delivery) return
    const marker = ticket.delivery.at, state = this.state(ticket.id)
    if (state.delivery === marker) return
    this.send(ticket, `delivery:${marker}`, this.say(ticket,
      `工单 ${ticket.id} 的输入未能送达 worker：${ticket.delivery.error}`,
      `An Input could not reach ticket ${ticket.id}'s worker: ${ticket.delivery.error}`))
    state.delivery = marker
    this.save(ticket.id, state)
  }
  /** Post into every conversation the Ticket started in; the Outbox deduplicates a retried message by id. */
  private send(ticket: Ticket, marker: string, text: string): void {
    for (const channel of ticket.channels) {
      // Feishu messages have a word limit; a Report summary can be much longer than an alert needs.
      const body = channel.source === 'feishu' && text.length > 240 ? `${text.slice(0, 239)}…` : text
      this.host.outbox.send({ id: key('alert', ticket.id, marker, channel.source, JSON.stringify(channel.address)),
        channel, text: body, kind: 'notice', ticketId: ticket.id })
    }
  }
}
