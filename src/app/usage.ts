/** Token usage metering from managed Sessions, persisted per Session for the standalone dashboard. */
import { KV, type UsageRecord, type UsageTotals } from '../kv.ts'
import type { Store } from './store.ts'

const now = (): string => new Date().toISOString()
const empty = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 })
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
const add = (into: UsageTotals, usage: UsageTotals): void => {
  into.input += usage.input; into.output += usage.output; into.cacheRead += usage.cacheRead; into.cacheWrite += usage.cacheWrite
  into.reasoning += usage.reasoning; into.calls += usage.calls
}
export interface UsageSession extends UsageRecord { sessionId: string }
/** Aggregated usage for the dashboard: every Session, totals, today's total, the last days, and per-model totals. */
export interface UsageSnapshot {
  sessions: UsageSession[]
  totals: UsageTotals
  today: UsageTotals
  byDay: { day: string; totals: UsageTotals }[]
  byModel: { provider: string; model: string; totals: UsageTotals }[]
  todayByModel: { provider: string; model: string; totals: UsageTotals }[]
}
/** Host dependencies used by `UsageMeter`. */
export interface UsageMeterHost {
  readonly store: Pick<Store, 'get' | 'set' | 'keys'>
  now?(): string
}

/**
 * Accumulates the `usage` of each `assistant/message` Session event into a durable per-Session record. A replayed event
 * with a sequence at or below the recorded one is ignored, so reopening a Session does not count it again.
 */
export class UsageMeter {
  private readonly cache = new Map<string, UsageRecord>()
  constructor(private readonly host: UsageMeterHost) {}
  /** Count one Session event; every other event type is ignored. */
  observe(sessionId: string, event: { type: string; time?: number; seq?: number; data?: unknown }): void {    if (event.type !== 'assistant/message') return
    const data = record(event.data)
    const usage = record(data?.usage)
    if (!usage) return
    const source = record(record(data?.message)?.source)
    const counted = { input: count(usage.inputTokens), output: count(usage.outputTokens), cacheRead: count(usage.cacheReadTokens),
      cacheWrite: count(usage.cacheWriteTokens), reasoning: count(usage.reasoningTokens), calls: 1 }
    if (!counted.input && !counted.output && !counted.cacheRead && !counted.cacheWrite && !counted.reasoning) return
    const current = this.read(sessionId)
    if (event.seq !== undefined && current.lastSeq !== undefined && event.seq <= current.lastSeq) return
    const at = new Date(event.time ?? Date.parse(this.host.now?.() ?? now()))
    const day = Number.isFinite(at.getTime()) ? at.toISOString().slice(0, 10) : (this.host.now?.() ?? now()).slice(0, 10)
    const next: UsageRecord = { ...current, byDay: { ...current.byDay, [day]: current.byDay[day] ?? empty() },
      updatedAt: at.toISOString(), ...event.seq !== undefined ? { lastSeq: event.seq } : {} }
    add(next, counted)
    add(next.byDay[day]!, counted)
    if (typeof source?.provider === 'string') next.provider = source.provider
    if (typeof source?.model === 'string') next.model = source.model
    this.cache.set(sessionId, next)
    this.host.store.set(KV.usage.session(sessionId), next)
  }
  /** Count the historical events of a Session loaded from persistence, without double-counting live or replayed ones. */
  seed(sessionId: string, events: Iterable<{ type: string; time?: number; seq?: number; data?: unknown }>): void {
    for (const event of events) this.observe(sessionId, event)
  }
  /** Add usage reported outside a Session event, such as a CLI run's final token counts. */
  add(sessionId: string, provider: string, model: string, usage: UsageTotals): void {
    if (!usage.input && !usage.output && !usage.cacheRead && !usage.cacheWrite && !usage.reasoning) return
    const current = this.read(sessionId)
    const at = new Date(this.host.now?.() ?? now())
    const day = at.toISOString().slice(0, 10)
    const next: UsageRecord = { ...current, byDay: { ...current.byDay, [day]: current.byDay[day] ?? empty() }, updatedAt: at.toISOString() }
    add(next, usage)
    add(next.byDay[day]!, usage)
    if (provider) next.provider = provider
    if (model) next.model = model
    this.cache.set(sessionId, next)
    this.host.store.set(KV.usage.session(sessionId), next)
  }
  /** The accumulated record of one Session, or undefined when it has no usage. */
  session(sessionId: string): UsageRecord | undefined {
    return this.cache.get(sessionId) ?? this.host.store.get(KV.usage.session(sessionId))
  }
  /** A snapshot of all persisted Session usage for the dashboard. */
  snapshot(): UsageSnapshot {
    const sessions: UsageSession[] = this.host.store.keys(KV.usage.session).flatMap(key => {
      const value = this.host.store.get(key)
      return value ? [{ sessionId: key.slice(KV.usage.session.prefix.length), ...value }] : []
    })
    const totals = empty(), today = empty()
    const day = (this.host.now?.() ?? now()).slice(0, 10)
    const byDay = new Map<string, UsageTotals>(), byModel = new Map<string, { provider: string; model: string; totals: UsageTotals }>()
    const todayByModel = new Map<string, { provider: string; model: string; totals: UsageTotals }>()
    for (const session of sessions) {
      add(totals, session)
      for (const [date, usage] of Object.entries(session.byDay)) {
        const bucket = byDay.get(date) ?? empty()
        add(bucket, usage); byDay.set(date, bucket)
        if (date === day) add(today, usage)
      }
      const provider = session.provider ?? 'unknown', model = session.model ?? 'unknown', key = `${provider}/${model}`
      const bucket = byModel.get(key) ?? { provider, model, totals: empty() }
      add(bucket.totals, session); byModel.set(key, bucket)
      if (session.byDay[day]) {
        const todayBucket = todayByModel.get(key) ?? { provider, model, totals: empty() }
        add(todayBucket.totals, session.byDay[day]); todayByModel.set(key, todayBucket)
      }
    }
    return { sessions, totals, today, byDay: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, usage]) => ({ day: date, totals: usage })),
      byModel: [...byModel.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)),
      todayByModel: [...todayByModel.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)) }
  }
  private read(sessionId: string): UsageRecord {
    const current = this.cache.get(sessionId) ?? this.host.store.get(KV.usage.session(sessionId))
    return current ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0, byDay: {}, updatedAt: now() }
  }
}
