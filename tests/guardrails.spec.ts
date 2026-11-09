import { describe, expect, it } from 'vitest'
import { SettingsSchema } from '../src/policy.ts'
import { Guardrails, tokensOf } from '../src/app/guardrails.ts'
import type { OutboundMessage, Ticket } from '../src/core/index.ts'
import type { UsageTotals } from '../src/kv.ts'

const totals = (input: number, output = 0, cacheRead = 0): UsageTotals =>
  ({ input, output, cacheRead, cacheWrite: 0, reasoning: 0, calls: 1 })
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 't1', title: '修复文案', decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: 'v1',
    basis: { via: 'addressed' }, actor: { source: 'github', id: 'alice' }, scope: '' },
  channels: [{ source: 'github', thread: 'github:1', address: { number: '1', repository: 'acme/widgets' } }],
  assignments: [], inputs: [], undelivered: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  origin: { triggerId: 'tr1', triggerIds: ['tr1'] }, ...overrides,
} as Ticket)
const assignment = (report?: { state: string; summary: string; at: string }) =>
  ({ id: 'a1', state: 'running', createdAt: '2026-01-01T00:00:00Z', startedAt: '2026-01-01T00:00:00Z', ...report ? { report } : {} }) as never
const configured = (guardrails: unknown) => SettingsSchema.parse({ guardrails })

function build(value: Ticket, options: { settings?: ReturnType<typeof SettingsSchema.parse>; usage?: Record<string, UsageTotals>;
  today?: UsageTotals; paused?: boolean; attentionReply?: boolean } = {}) {
  const state = new Map<string, unknown>(), messages: OutboundMessage[] = [], reports: { state: string; summary: string }[] = []
  const stops: string[] = [], health: { state: string; detail: string }[] = []
  const settings = options.settings ?? configured({ alerts: { enabled: true }, budget: {} })
  let pauses = 0
  const host = {
    store: { settings: () => settings, tickets: { open: () => [value] },
      triggers: { get: (id: string) => id === 'tr1' ? { id, text: '请修复这个文案问题' } : undefined },
      get: (key: string) => state.get(key), set: (key: string, entry: unknown) => { state.set(key, entry) },
      atomic: <T>(work: () => T) => work() } as never,
    outbox: { send: (message: OutboundMessage) => { messages.push(message) },
      status: () => options.attentionReply ? 'pending' : undefined } as never,
    usage: { session: (id: string) => options.usage?.[id], snapshot: () => ({ today: options.today ?? totals(0) }) } as never,
    engine: { report: (_id: string, report: { state: string; summary: string }) => { reports.push(report); return value } } as never,
    executor: { stop: (_ticket: Ticket, item: { id: string }) => { stops.push(item.id) } } as never,
    health: { set: (entry: { state: string; detail: string }) => { health.push(entry) } } as never,
    closing: () => false, paused: () => options.paused ?? false, pause: () => { pauses++ },
    now: () => '2026-01-02T12:00:00Z',
  }
  return { guardrails: new Guardrails(host), messages, reports, stops, health, pauses: () => pauses }
}

describe('guardrail token totals', () => {
  it('counts every reported token kind and treats a missing record as zero', () => {
    expect(tokensOf(totals(10, 5, 3))).toBe(18)
    expect(tokensOf(undefined)).toBe(0)
  })
})

describe('Guardrails alerts', () => {
  it('posts one attention alert into the Ticket channel and repeats only for a new question', () => {
    const value = ticket({ attention: { id: 'q1', question: '按钮用哪个颜色？' } })
    const { guardrails, messages } = build(value)
    guardrails.tick()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ kind: 'notice', ticketId: 't1', channel: { source: 'github' } })
    expect(messages[0]?.text).toContain('按钮用哪个颜色？')
    guardrails.tick()
    expect(messages).toHaveLength(1)
    // A new attention question has a new id and is a new alert.
    const next = ticket({ attention: { id: 'q2', question: '标题保持原样吗？' } })
    const second = build(next)
    second.guardrails.tick()
    expect(second.messages).toHaveLength(1)
    expect(second.messages[0]?.text).toContain('标题保持原样吗？')
  })

  it('posts a failed report once with its summary', () => {
    const value = ticket({ assignments: [assignment({ state: 'failed', summary: 'Tests failed on main.', at: '2026-01-02T11:00:00Z' })] })
    const { guardrails, messages } = build(value)
    guardrails.tick()
    expect(messages).toHaveLength(1)
    expect(messages[0]?.text).toContain('失败')
    expect(messages[0]?.text).toContain('Tests failed on main.')
    guardrails.tick()
    expect(messages).toHaveLength(1)
  })

  it('honours the failure and attention switches', () => {
    const value = ticket({ attention: { id: 'q1', question: '颜色？' },
      assignments: [assignment({ state: 'blocked', summary: 'Need access.', at: '2026-01-02T11:00:00Z' })] })
    const { guardrails, messages } = build(value, { settings: configured({ alerts: { enabled: true, failures: false, attention: false } }) })
    guardrails.tick()
    expect(messages).toEqual([])
  })

  it('does not duplicate an attention reply the main Session already queued', () => {
    const value = ticket({ attention: { id: 'q1', question: '颜色？' } })
    const { guardrails, messages } = build(value, { attentionReply: true })
    guardrails.tick()
    expect(messages).toEqual([])
  })

  it('sends nothing while alerts are off', () => {
    const value = ticket({ attention: { id: 'q1', question: '颜色？' },
      assignments: [assignment({ state: 'failed', summary: 'No.', at: '2026-01-02T11:00:00Z' })] })
    const { guardrails, messages, health } = build(value, { settings: SettingsSchema.parse({}) })
    guardrails.tick()
    expect(messages).toEqual([])
    expect(health.at(-1)).toMatchObject({ state: 'ready', detail: 'Guardrails are off' })
  })
})

describe('Guardrails budgets', () => {
  it('reports and stops a Ticket over its worker and reviewer token budget, once', () => {
    const value = ticket({ assignments: [assignment()] })
    const { guardrails, messages, reports, stops } = build(value, {
      settings: configured({ alerts: { enabled: true }, budget: { ticketTokens: 100 } }),
      usage: { 'worker-t1': totals(80), 'reviewer-t1': totals(30) },
    })
    guardrails.tick()
    expect(reports[0]).toMatchObject({ state: 'failed' })
    expect(reports[0]?.summary).toContain('110/100')
    expect(stops).toEqual(['a1'])
    expect(messages).toHaveLength(1)
    expect(messages[0]?.text).toContain('超过 token 预算')
    guardrails.tick()
    expect(reports).toHaveLength(1)
    expect(messages).toHaveLength(1)
  })

  it('pauses processing once when today\'s tokens exceed the daily budget', () => {
    const value = ticket()
    const { guardrails, messages, health, pauses } = build(value, {
      settings: configured({ alerts: { enabled: true }, budget: { dailyTokens: 100 } }),
      today: totals(120),
    })
    guardrails.tick()
    expect(pauses()).toBe(1)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.text).toContain('今日 token 已超过预算')
    expect(health.at(-1)).toMatchObject({ state: 'error' })
    guardrails.tick()
    expect(pauses()).toBe(1)
    expect(messages).toHaveLength(1)
  })
})
