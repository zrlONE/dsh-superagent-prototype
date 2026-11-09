// @vitest-environment jsdom
// The standalone board's rendering logic, driven by a fake management API response.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const html = readFileSync(join(import.meta.dirname, '..', 'dashboard', 'index.html'), 'utf8')
const body = /<body>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/g, '')
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 }
const payload = {
  at: '2026-01-01T01:00:00Z', paused: false, activeProject: 'alpha',
  workflow: { enabled: true, maxRounds: 2, watchdog: true, timeoutMinutes: 60 },
  health: { runtime: { state: 'ready', detail: '' }, github: { state: 'error', detail: 'poll failed' } },
  projects: [{ id: 'alpha', name: 'Alpha', repository: 'acme/alpha', active: true, enabled: true, open: 1, working: 0, review: 1, failed: 0,
    tokens: { ...zero, input: 1100, output: 25 } }],
  tickets: [{ id: 't1', title: 'Fix the copy', project: { id: 'alpha', name: 'Alpha', repository: 'acme/alpha' }, state: 'open',
    stage: 'person', action: 'review', open: true, summary: 'Done and tests pass.', url: 'https://github.com/acme/alpha/pull/2',
    actions: { retry: false, stop: true },
    createdAt: '', updatedAt: '2026-01-01T01:00:00Z', tokens: { ...zero, input: 1100, output: 25 },
    workflow: { status: 'approved', reviewRound: 1, ciRound: 0, verdict: 'approve', summary: 'Looks right.' },
    agents: [{ role: 'worker', sessionId: 'worker-t1', status: 'idle', provider: 'p', model: 'm', usage: { ...zero, input: 1000, output: 20 } }] }],
  agents: [
    { role: 'orchestrator', sessionId: 'orchestrator-1', status: 'idle', usage: { ...zero, input: 7, output: 3 } },
    { role: 'worker', sessionId: 'worker-t1', ticketId: 't1', status: 'idle', provider: 'p', model: 'm', usage: { ...zero, input: 1000, output: 20 } },
  ],
  usage: { sessions: [], totals: { ...zero, input: 1007, output: 23 }, today: { ...zero, input: 1007, output: 23 },
    byDay: [{ day: '2026-01-01', totals: { ...zero, input: 1007, output: 23 } }],
    byModel: [{ provider: 'p', model: 'm', totals: { ...zero, input: 1007, output: 23 } }],
    todayByModel: [{ provider: 'p', model: 'm', totals: { ...zero, input: 1007, output: 23 } }] },
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('renders the summary, projects, tickets, agents and usage from the dashboard API', async () => {
  document.body.innerHTML = body
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => payload })))
  // @ts-expect-error The board is plain browser JavaScript, outside the TypeScript project.
  await import('../dashboard/app.js')
  await vi.waitFor(() => expect(document.querySelector('#tickets')?.textContent).toContain('Fix the copy'))
  expect(document.querySelector('#summary')?.textContent).toContain('打开工单')
  expect(document.querySelector('#summary')?.textContent).toContain('1.0k')
  expect(document.querySelector('#projects')?.textContent).toContain('Alpha')
  expect(document.querySelector('#projects')?.textContent).toContain('acme/alpha')
  expect(document.querySelector('#tickets')?.textContent).toContain('已批准 1')
  expect(document.querySelector('#tickets')?.textContent).toContain('停止')
  expect(document.querySelector('#pause')?.textContent).toBe('暂停')
  expect((document.querySelector('#pause') as HTMLButtonElement).disabled).toBe(false)
  expect(document.querySelector('#agents')?.textContent).toContain('worker-t1')
  expect(document.querySelector('#usage')?.textContent).toContain('1.0k')
  expect(document.querySelector('#health')?.textContent).toContain('github')
  expect(document.querySelector('#error')).toHaveProperty('hidden', true)
})
