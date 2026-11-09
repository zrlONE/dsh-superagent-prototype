import { describe, expect, it } from 'vitest'
import { KV } from '../src/kv.ts'
import { SettingsSchema } from '../src/policy.ts'
import { dashboardView } from '../src/app/views/dashboard.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'
import type { UsageSnapshot } from '../src/app/usage.ts'

const settings = SettingsSchema.parse({
  projects: [{ id: 'alpha', name: 'Alpha', repository: 'acme/alpha' }, { id: 'beta', name: 'Beta', repository: 'acme/beta' }],
  activeProject: 'alpha',
  workflow: { enabled: true, maxRounds: 2 },
})
const trigger = { id: 'tr1', source: 'github', threads: [{ source: 'github', id: '2' }], actor: { source: 'github', id: 'alice' },
  human: true, at: '2026-01-01T00:00:00Z', text: 'Fix the copy', url: 'https://github.com/acme/alpha/issues/1', meta: { repository: 'acme/alpha', number: 1 } } as Trigger
const ticket = {
  id: 't1', title: 'Fix the copy', decisionId: 'd1', origin: { triggerId: 'tr1', triggerIds: ['tr1'] },
  mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'addressed' }, actor: { source: 'github', id: 'alice' }, scope: '' },
  channels: [], follows: [{ thread: 'github:2', own: true }], inputs: [], undelivered: [], createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T01:00:00Z',
  assignments: [{ id: 'a1', state: 'running', createdAt: '2026-01-01T00:00:00Z', startedAt: '2026-01-01T00:00:00Z',
    report: { state: 'ready', summary: 'Done and tests pass.', at: '2026-01-01T01:00:00Z' } }],
} as unknown as Ticket
const totals = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 1 })
const usage: UsageSnapshot = {
  sessions: [
    { sessionId: 'worker-t1', provider: 'p', model: 'm', ...totals(100, 20), byDay: { '2026-01-01': totals(100, 20) }, updatedAt: '' },
    { sessionId: 'reviewer-t1', provider: 'p', model: 'm', ...totals(10, 5), byDay: { '2026-01-01': totals(10, 5) }, updatedAt: '' },
    { sessionId: 'orchestrator-1', provider: 'p', model: 'm', ...totals(7, 3), byDay: { '2026-01-01': totals(7, 3) }, updatedAt: '' },
  ],
  totals: totals(117, 28), today: totals(117, 28), byDay: [{ day: '2026-01-01', totals: totals(117, 28) }],
  byModel: [{ provider: 'p', model: 'm', totals: totals(117, 28) }], todayByModel: [{ provider: 'p', model: 'm', totals: totals(117, 28) }],
}
const store = {
  settings: () => settings,
  tickets: { list: () => [ticket], open: () => [ticket], get: () => ticket },
  triggers: { get: (id: string) => id === 'tr1' ? trigger : undefined },
  get: (key: string) => key === KV.workflow.state('t1') ? { reviewRound: 1, ciRound: 0, status: 'approved',
    reviewerSessionId: 'reviewer-t1', review: { verdict: 'approve', summary: 'Looks right.', issues: [], at: '', round: 1 } } : undefined,
} as never

describe('dashboard view', () => {
  it('joins Tickets to their project, agent Sessions, workflow state and token usage', () => {
    const view = dashboardView({ store, usage, health: { runtime: { state: 'ready', detail: '' } }, masterId: 'orchestrator-1',
      status: id => id === 'worker-t1' ? 'running' : id === 'reviewer-t1' ? 'idle' : undefined })
    expect(view.projects.map(project => [project.id, project.active, project.review, project.tokens.input])).toEqual([
      ['alpha', true, 1, 110], ['beta', false, 0, 0]])
    expect(view.tickets[0]).toMatchObject({ id: 't1', stage: 'person', action: 'review', project: { id: 'alpha' },
      workflow: { status: 'approved', reviewRound: 1, verdict: 'approve' }, tokens: { input: 110, output: 25 } })
    expect(view.tickets[0]!.agents.map(agent => [agent.role, agent.status, agent.model, agent.usage.input])).toEqual([
      ['worker', 'running', 'm', 100], ['reviewer', 'idle', 'm', 10]])
    expect(view.agents.map(agent => [agent.role, agent.sessionId, agent.ticketId])).toEqual([
      ['orchestrator', 'orchestrator-1', undefined], ['worker', 'worker-t1', 't1'], ['reviewer', 'reviewer-t1', 't1']])
    expect(view.usage.totals.input).toBe(117)
    expect(view.workflow).toMatchObject({ enabled: true, maxRounds: 2 })
  })
  it('lists recent ended Tickets after open ones and leaves them out of a project\'s open count', () => {
    const ended = { ...ticket, id: 't0', ended: { at: '2026-01-02T00:00:00Z', by: 'executor', outcome: 'completed' },
      updatedAt: '2026-01-02T00:00:00Z' } as unknown as Ticket
    const view = dashboardView({ store: { ...(store as object), tickets: { list: () => [ended, ticket], open: () => [ticket], get: () => ticket } } as never,
      usage, health: {}, masterId: 'orchestrator-1', status: () => undefined })
    expect(view.tickets.map(item => [item.id, item.state])).toEqual([['t1', 'open'], ['t0', 'ended']])
    expect(view.projects[0]!.open).toBe(1)
  })
})
