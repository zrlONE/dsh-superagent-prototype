import { describe, expect, it } from 'vitest'
import { SettingsSchema } from '../src/policy.ts'
import { KV, type WorkflowState } from '../src/kv.ts'
import { Workflow, ciFailures, lastActivity, reviewDue, reviewPrompt, watchdogDue } from '../src/app/workflow.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 't1', title: 'Fix the copy', decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: 'v1',
    basis: { via: 'addressed' }, actor: { source: 'github', id: 'alice' }, scope: '' }, channels: [], assignments: [], inputs: [],
  undelivered: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  origin: { triggerId: 'tr1', triggerIds: ['tr1'] }, ...overrides,
} as Ticket)
const assignment = (overrides: Record<string, unknown> = {}) => ({ id: 'a1', state: 'running', createdAt: '2026-01-01T00:00:00Z',
  startedAt: '2026-01-01T00:00:00Z', ...overrides }) as never
const ci = (id: string, text = 'CI failed 1/1 on PR #2 at abc1234: test'): Trigger => ({ id, source: 'github', threads: [], actor: { source: 'github', id: '' },
  human: false, at: '2026-01-01T00:00:00Z', text, meta: { ci: true } })

describe('workflow decisions', () => {
  it('counts only CI-failure Triggers, once each', () => {
    const triggers = new Map([['tr1', ci('tr1')], ['tr2', ci('tr2', 'CI passed 1/1 on PR #2')], ['tr3', ci('tr3')]])
    const value = ticket({ inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'tr1', at: '' }, { id: 'i2', kind: 'trigger', triggerId: 'tr2', at: '' },
      { id: 'i3', kind: 'trigger', triggerId: 'tr3', at: '' }, { id: 'i4', kind: 'trigger', triggerId: 'tr1', at: '' }] })
    expect(ciFailures(value, id => triggers.get(id))).toBe(2)
    expect(ciFailures(ticket(), () => undefined)).toBe(0)
  })
  it('is due for a ready report with an open pull request that this report has not covered', () => {
    const follows = [{ thread: 'github:2', own: true }]
    const ready = ticket({ follows, assignments: [assignment({ report: { state: 'ready', summary: 'done', at: '2026-01-01T01:00:00Z' } })] })
    expect(reviewDue(ready, { reviewRound: 0, ciRound: 0, status: 'idle' })).toBe(true)
    expect(reviewDue(ready, { reviewRound: 1, ciRound: 0, status: 'approved', lastReviewedAt: '2026-01-01T01:00:00Z' })).toBe(false)
    expect(reviewDue(ticket({ assignments: [assignment({ report: { state: 'failed', summary: 'x', at: '2026-01-01T01:00:00Z' } })] }), { reviewRound: 0, ciRound: 0, status: 'idle' })).toBe(false)
    expect(reviewDue(ticket({ assignments: [assignment({ report: { state: 'ready', summary: 'done', at: '2026-01-01T01:00:00Z' } })] }), { reviewRound: 0, ciRound: 0, status: 'idle' })).toBe(false)
  })
  it('uses the latest activity, and stops a working assignment older than the timeout', () => {
    const a = assignment({ startedAt: '2026-01-01T00:00:00Z', idleAt: '2026-01-01T02:00:00Z' })
    const value = ticket({ assignments: [a] })
    expect(lastActivity(value, a)).toBe('2026-01-01T02:00:00Z')
    expect(watchdogDue(value, '2026-01-01T02:30:00Z', 60)).toBeUndefined()
    expect(watchdogDue(value, '2026-01-01T03:01:00Z', 60)).toBe(a)
    // A ready ticket is waiting for a person, not stuck in an assignment.
    expect(watchdogDue(ticket({ assignments: [assignment({ report: { state: 'ready', summary: 'x', at: '2026-01-01T02:00:00Z' } })] }),
      '2026-01-01T04:00:00Z', 60)).toBeUndefined()
  })
  it('tells the reviewer the request, repository, round and verdict to record', () => {
    const prompt = reviewPrompt(ticket(), 'Make the copy clearer', 'acme/widgets', 2, 'The writer says it is done.', 2, 3)
    expect(prompt).toContain('acme/widgets')
    expect(prompt).toContain('Make the copy clearer')
    expect(prompt).toContain('Review round 2 of 3')
    expect(prompt).toContain('workflow_review')
  })
})

describe('Workflow verdicts', () => {
  const build = (maxRounds = 3) => {
    const state = new Map<string, unknown>()
    const notes: string[] = [], relays: string[] = [], reports: { state: string; summary: string }[] = []
    const value = ticket({ follows: [{ thread: 'github:2', own: true }],
      assignments: [assignment({ report: { state: 'ready', summary: 'done', at: '2026-01-01T01:00:00Z' } })] })
    const settings = SettingsSchema.parse({ workflow: { enabled: true, maxRounds } })
    const host = {
      context: { agents: { get: () => undefined } } as never,
      store: { tickets: { get: () => value }, triggers: { get: () => undefined }, settings: () => settings,
        get: (key: string) => state.get(key), set: (key: string, entry: unknown) => { state.set(key, entry) }, atomic: <T>(work: () => T) => work() } as never,
      engine: { report: (_id: string, report: { state: string; summary: string }) => { reports.push(report); return value },
        note: (_id: string, text: string) => { notes.push(text); return value } } as never,
      executor: { stop: () => {} } as never,
      sessions: { ensure: async () => ({}) as never, prompt: async () => {}, relay: (_id: string, text: string) => { relays.push(text) } } as never,
      health: { set: () => {}, get: () => undefined } as never,
      lifetime: new AbortController().signal, closing: () => false, paused: () => false, now: () => '2026-01-01T01:00:00Z',
    }
    const workflow = new Workflow(host)
    const reviewing = (round: number): WorkflowState => ({ reviewRound: round, ciRound: 0, status: 'reviewing', reviewerSessionId: 'reviewer-t1' })
    const seed = (round: number) => state.set(KV.workflow.state('t1'), reviewing(round))
    const saved = () => state.get(KV.workflow.state('t1')) as WorkflowState
    return { workflow, notes, relays, reports, seed, saved }
  }
  it('sends requested changes back to the writer as an Input note', () => {
    const { workflow, notes, relays, seed, saved } = build(3)
    seed(1)
    expect(workflow.review('t1', 'reviewer-t1', { verdict: 'changes', summary: 'The typo remains.', issues: ['Fix line 3'] }))
      .toMatchObject({ recorded: true, verdict: 'changes', round: 1, remaining: 2 })
    expect(notes[0]).toContain('Reviewer requested changes')
    expect(notes[0]).toContain('Fix line 3')
    expect(relays[0]).toContain('requested changes')
    expect(saved()).toMatchObject({ status: 'changes', review: { verdict: 'changes' } })
  })
  it('approves without waking the writer', () => {
    const { workflow, notes, relays, seed, saved } = build()
    seed(1)
    expect(workflow.review('t1', 'reviewer-t1', { verdict: 'approve', summary: 'Looks right.', issues: [] }))
      .toMatchObject({ recorded: true, verdict: 'approve' })
    expect(notes).toEqual([])
    expect(relays[0]).toContain('approved')
    expect(saved().status).toBe('approved')
  })
  it('fails the ticket when the reviewer requests changes in the last round', () => {
    const { workflow, notes, reports, seed, saved } = build(1)
    seed(1)
    workflow.review('t1', 'reviewer-t1', { verdict: 'changes', summary: 'Still wrong.', issues: [] })
    expect(notes).toEqual([])
    expect(reports[0]).toMatchObject({ state: 'failed' })
    expect(saved().status).toBe('failed')
  })
  it('ignores a verdict from a Session that is not the active reviewer, or for a finished round', () => {
    const { workflow, seed, saved } = build()
    seed(1)
    expect(workflow.review('t1', 'reviewer-other', { verdict: 'approve', summary: 'x', issues: [] }))
      .toMatchObject({ recorded: false })
    workflow.review('t1', 'reviewer-t1', { verdict: 'approve', summary: 'x', issues: [] })
    expect(workflow.review('t1', 'reviewer-t1', { verdict: 'changes', summary: 'y', issues: [] }))
      .toMatchObject({ recorded: false })
    expect(saved().review?.verdict).toBe('approve')
  })
})

describe('Workflow ticks', () => {
  const build = (value: Ticket, settings = SettingsSchema.parse({ workflow: { enabled: true, maxRounds: 2, timeoutMinutes: 10 } }),
    triggers: Map<string, Trigger> = new Map()) => {
    const state = new Map<string, unknown>()
    const ensured: unknown[][] = [], prompts: { id: string; text: string }[] = [], reports: { state: string; summary: string }[] = []
    const stops: string[] = []
    const host = {
      context: { agents: { get: () => undefined } } as never,
      store: { tickets: { get: () => value, open: () => [value] }, triggers: { get: (id: string) => triggers.get(id) }, settings: () => settings,
        get: (key: string) => state.get(key), set: (key: string, entry: unknown) => { state.set(key, entry) }, atomic: <T>(work: () => T) => work() } as never,
      engine: { report: (_id: string, report: { state: string; summary: string }) => { reports.push(report); return value },
        note: () => value } as never,
      executor: { stop: (_ticket: Ticket, assignment: { id: string }) => { stops.push(assignment.id) } } as never,
      sessions: { ensure: async (...args: unknown[]) => { ensured.push(args); return {} as never }, prompt: async (id: string, _request: string, text: string) => { prompts.push({ id, text }) },
        relay: () => {} } as never,
      health: { set: () => {}, get: () => undefined } as never,
      lifetime: new AbortController().signal, closing: () => false, paused: () => false, now: () => '2026-01-01T03:00:00Z',
    }
    const workflow = new Workflow(host)
    return { workflow, ensured, prompts, reports, stops, state, saved: () => state.get(KV.workflow.state('t1')) as WorkflowState }
  }
  it('starts one reviewer Session per new ready report and gives its prompt to the reviewer', async () => {
    const value = ticket({ follows: [{ thread: 'github:2', own: true }], execution: { name: 'fix-copy', directory: '/tmp/t', assignment: '' },
      assignments: [assignment({ report: { state: 'ready', summary: 'Done and tests pass.', at: '2026-01-01T01:00:00Z' } })] })
    const { workflow, ensured, prompts, saved } = build(value)
    await workflow.tick()
    expect(ensured[0]).toEqual(['reviewer-t1', '/tmp/t', 'Review: Fix the copy', 'reviewer', null])
    expect(prompts[0]?.id).toBe('reviewer-t1')
    expect(prompts[0]?.text).toContain('workflow_review')
    expect(saved()).toMatchObject({ reviewRound: 1, status: 'reviewing', lastReviewedAt: '2026-01-01T01:00:00Z' })
    // The same ready report does not start a second review while the first is still running.
    await workflow.tick()
    expect(ensured).toHaveLength(1)
  })
  it('fails a ticket whose CI failures exceed the fix-round limit', async () => {
    const value = ticket({ assignments: [assignment({ startedAt: '2026-01-01T02:55:00Z' })],
      inputs: [1, 2, 3].map(index => ({ id: `i${index}`, kind: 'trigger' as const, triggerId: `tr${index}`, at: '2026-01-01T02:56:00Z' })) })
    const triggers = new Map([1, 2, 3].map(index => [`tr${index}`, ci(`tr${index}`)]))
    const { workflow, reports, stops, state } = build(value, undefined, triggers)
    await workflow.tick()
    expect(reports[0]).toMatchObject({ state: 'failed' })
    expect(stops).toEqual(['a1'])
    expect((state.get(KV.workflow.state('t1')) as WorkflowState)).toMatchObject({ ciRound: 3, status: 'failed' })
  })
  it('stops an assignment with no activity past the watchdog timeout', async () => {
    const value = ticket({ assignments: [assignment({ startedAt: '2026-01-01T02:00:00Z' })] })
    const { workflow, reports, stops } = build(value)
    await workflow.tick()
    expect(reports[0]).toMatchObject({ state: 'failed' })
    expect(reports[0]?.summary).toContain('watchdog')
    expect(stops).toEqual(['a1'])
  })
})
