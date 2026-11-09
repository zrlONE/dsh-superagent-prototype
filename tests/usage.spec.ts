import { describe, expect, it } from 'vitest'
import { KV } from '../src/kv.ts'
import { UsageMeter } from '../src/app/usage.ts'

const store = (entries = new Map<string, unknown>()) => ({
  get: <V>(key: string) => entries.get(key) as V | undefined,
  set: <V>(key: string, value: V | undefined) => { if (value === undefined) entries.delete(key); else entries.set(key, value) },
  keys: <V>(family: { prefix: string }) => [...entries.keys()].filter(key => key.startsWith(family.prefix)) as never,
}) as never
const event = (seq: number, time: number, usage: Record<string, number>, provider = 'p', model = 'm') => ({
  type: 'assistant/message', seq, time, data: { usage, message: { source: { provider, model } } },
})

describe('usage meter', () => {
  it('accumulates assistant-message usage per Session and day, and ignores replayed sequences', () => {
    const entries = new Map<string, unknown>()
    const meter = new UsageMeter({ store: store(entries), now: () => '2026-01-02T12:00:00Z' })
    meter.observe('worker-t1', event(1, Date.parse('2026-01-02T01:00:00Z'), { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10, reasoningTokens: 5 }))
    meter.observe('worker-t1', event(1, Date.parse('2026-01-02T01:00:00Z'), { inputTokens: 100, outputTokens: 20 }))
    const record = meter.session('worker-t1')!
    expect(record).toMatchObject({ input: 100, output: 20, cacheRead: 30, cacheWrite: 10, reasoning: 5, calls: 1, provider: 'p', model: 'm', lastSeq: 1 })
    expect(record.byDay['2026-01-02']).toMatchObject({ input: 100, calls: 1 })
    expect(entries.get(KV.usage.session('worker-t1'))).toMatchObject({ input: 100 })
  })
  it('snapshots totals, today, days and models, including a second model on the same Session', () => {
    const entries = new Map<string, unknown>()
    const meter = new UsageMeter({ store: store(entries), now: () => '2026-01-03T12:00:00Z' })
    meter.observe('worker-t1', event(1, Date.parse('2026-01-02T01:00:00Z'), { inputTokens: 100, outputTokens: 20 }, 'p', 'm'))
    meter.observe('worker-t1', event(2, Date.parse('2026-01-03T01:00:00Z'), { inputTokens: 50, outputTokens: 10 }, 'p', 'm2'))
    meter.observe('reviewer-t1', event(1, Date.parse('2026-01-03T02:00:00Z'), { inputTokens: 7, outputTokens: 3 }, 'q', 'n'))
    const snapshot = meter.snapshot()
    expect(snapshot.sessions).toHaveLength(2)
    expect(snapshot.totals).toMatchObject({ input: 157, output: 33, calls: 3 })
    expect(snapshot.today).toMatchObject({ input: 57, output: 13 })
    expect(snapshot.byDay).toEqual([{ day: '2026-01-02', totals: expect.objectContaining({ input: 100 }) },
      { day: '2026-01-03', totals: expect.objectContaining({ input: 57 }) }])
    expect(snapshot.byModel.map(row => [row.provider, row.model, row.totals.input])).toEqual([['p', 'm2', 150], ['q', 'n', 7]])
    expect(snapshot.todayByModel.map(row => [row.model, row.totals.input])).toEqual([['m2', 50], ['n', 7]])
  })
  it('ignores events without token usage or of another type', () => {
    const meter = new UsageMeter({ store: store() })
    meter.observe('s', { type: 'user/message', time: 0, data: {} })
    meter.observe('s', { type: 'assistant/message', time: 0, data: { usage: { inputTokens: 0, outputTokens: 0 } } })
    expect(meter.session('s')).toBeUndefined()
    expect(meter.snapshot().sessions).toEqual([])
  })
})
