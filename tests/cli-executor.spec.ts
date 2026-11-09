import { describe, expect, it } from 'vitest'
import { CLAUDE_ALLOWED_TOOLS, cliArgv, cliPrompt, parseCliOutput, pullNumber, pullTitle } from '../src/executor/cli.ts'
import { ExecutorConfigSchema } from '../src/policy.ts'

const limits = { timeoutMinutes: 30, maxTurns: 12 }

describe('CLI argv', () => {
  it('runs Codex in a confined sandbox through config, since its resume subcommand has no --sandbox flag', () => {
    const first = cliArgv('codex', 'do it', '/work/ticket', limits, 'workspace-write')
    expect(first).toEqual(['codex', 'exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode=workspace-write',
      '--cd', '/work/ticket', 'do it'])
    const resumed = cliArgv('codex', 'again', '/work/ticket', limits, 'workspace-write', 'thread-1')
    expect(resumed).toEqual(['codex', 'exec', 'resume', 'thread-1', '--json', '--skip-git-repo-check',
      '-c', 'sandbox_mode=workspace-write', 'again'])
    expect(cliArgv('codex', 'do it', '/work/ticket', limits, 'danger-full-access')).toContain('--dangerously-bypass-approvals-and-sandbox')
  })
  it('lets Claude edit within its workspace and limits its shell, or lets it bypass permissions under full access', () => {
    const confined = cliArgv('claude', 'do it', '/work/ticket', limits, 'workspace-write')
    expect(confined).toContain('acceptEdits')
    expect(confined).toContain(CLAUDE_ALLOWED_TOOLS.join(','))
    expect(confined).toContain('--max-turns')
    expect(cliArgv('claude', 'do it', '/work/ticket', limits, 'danger-full-access')).toContain('bypassPermissions')
    expect(cliArgv('claude', 'again', '/work/ticket', limits, 'workspace-write', 'session-1')).toContain('--resume')
  })
  it('runs Command Code only with full access, which its print mode needs to write and run commands', () => {
    expect(() => cliArgv('cmd', 'do it', '/work/ticket', limits, 'workspace-write'))
      .toThrow('danger-full-access')
    expect(cliArgv('cmd', 'do it', '/work/ticket', limits, 'danger-full-access')).toEqual(['cmd', '-p', 'do it', '--output-format', 'json',
      '--max-turns', '12', '--trust', '--yolo', '--skip-onboarding', '--no-auto-update'])
    expect(cliArgv('cmd', 'again', '/work/ticket', limits, 'danger-full-access', 'session-1')).toContain('--resume')
  })
})

const lines = (...events: unknown[]): string => events.map(event => JSON.stringify(event)).join('\n')

describe('CLI output', () => {
  it('reads the final message and thread id of Codex exec --json', () => {
    const output = lines(
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Looking at the tests.' } },
      { type: 'item.started', item: { type: 'command_execution', command: 'npm test' } },
      { type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 0, aggregated_output: 'ok' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Added multiply and tests pass.' } },
      { type: 'turn.completed', usage: {} },
      'not json')
    const result = parseCliOutput('codex', output, 0)
    expect(result).toMatchObject({ ok: true, text: 'Added multiply and tests pass.', session: 'thread-1', turns: 1 })
    expect(result.progress).toContain('command: npm test')
  })
  it('reads Command Code\'s wrapped events and final result line', () => {
    const output = lines(
      { type: 'event', event: { type: 'run_start', sessionId: 'session-1' } },
      { type: 'event', event: { type: 'message_end', content: [{ type: 'text', text: 'I will add the test.' },
        { type: 'tool_use', name: 'write_file' }] } },
      { type: 'event', event: { type: 'turn_end', turnNumber: 1 } },
      { type: 'event', event: { type: 'run_end', result: { finalText: 'Added the test; npm test passes.', sessionId: 'session-1',
        stopReason: 'end_turn', turnCount: 1 } } },
      { type: 'result', subtype: 'success', sessionId: 'session-1', stopReason: 'end_turn', turnCount: 1, finalText: 'Added the test; npm test passes.' })
    const result = parseCliOutput('cmd', output, 0)
    expect(result).toMatchObject({ ok: true, text: 'Added the test; npm test passes.', session: 'session-1', turns: 1, stopReason: 'end_turn' })
    expect(result.progress).toContain('tool: write_file')
  })
  it('reads Claude stream-json and requires its result line to report success', () => {
    const output = lines(
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Adding it.' }, { type: 'tool_use', name: 'Edit' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'Done, tests pass.', session_id: 'session-1', num_turns: 3 })
    expect(parseCliOutput('claude', output, 0)).toMatchObject({ ok: true, text: 'Done, tests pass.', session: 'session-1', turns: 3 })
    expect(parseCliOutput('claude', lines({ type: 'assistant', message: { content: [{ type: 'text', text: 'no result' }] } }), 0).ok).toBe(false)
    expect(parseCliOutput('claude', lines({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'too many turns' }), 0))
      .toMatchObject({ ok: false, text: 'too many turns' })
  })
  it('reads token usage and the model the CLI reported', () => {
    expect(parseCliOutput('codex', lines({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 30, output_tokens: 20 } }), 0))
      .toMatchObject({ usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0 } })
    expect(parseCliOutput('cmd', lines({ type: 'event', event: { type: 'model_request_start', model: 'magpie/x' } },
      { type: 'result', subtype: 'success', finalText: 'ok', usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 5 } }), 0))
      .toMatchObject({ usage: { input: 50, output: 10, cacheRead: 5 }, model: 'magpie/x' })
    expect(parseCliOutput('claude', lines({ type: 'result', subtype: 'success', is_error: false, result: 'ok', modelUsage: { 'claude-x': {} },
      usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } }), 0))
      .toMatchObject({ usage: { input: 7, output: 3, cacheRead: 2, cacheWrite: 1 }, model: 'claude-x' })
  })
  it('reports a turn cap, an error event and a non-zero exit as failures', () => {
    expect(parseCliOutput('cmd', lines({ type: 'result', subtype: 'success', stopReason: 'max_turns', finalText: 'stopped', turnCount: 12 }), 8))
      .toMatchObject({ ok: false, text: 'stopped', stopReason: 'max_turns' })
    expect(parseCliOutput('codex', lines({ type: 'error', message: 'model overloaded' }), 1))
      .toMatchObject({ ok: false, text: 'model overloaded' })
    expect(parseCliOutput('codex', '', 1)).toMatchObject({ ok: false, text: 'codex exited with 1' })
  })
})

describe('CLI prompt', () => {
  it('states the hand-off: the agent changes and tests files, the executor commits, pushes and opens the pull request', () => {
    const prompt = cliPrompt({ title: 'Add multiply', request: '{"text":"add multiply"}', repository: 'acme/widgets', assignment: 'small' })
    for (const expected of ['Add multiply', 'add multiply', 'acme/widgets', 'small', 'Do not commit, push', 'run the project\'s tests']) {
      expect(prompt).toContain(expected)
    }
  })
  it('asks a follow-up only for the change, in the same directory', () => {
    expect(cliPrompt({ title: 'Add multiply', request: '', followup: 'also handle zero' }))
      .toBe('Follow-up on the same task:\nalso handle zero\n\nMake the change in this directory, run the tests, and do not commit or push.')
  })
  it('turns a ticket title into one short pull request title', () => {
    expect(pullTitle('  Add   multiply  ')).toBe('Add multiply')
    expect(pullTitle('')).toBe('Agent change')
  })
  it('reads the pull request number from the last line of gh output', () => {
    expect(pullNumber('https://github.com/acme/widgets/pull/42')).toBe(42)
    expect(pullNumber('warning: something\nhttps://github.com/acme/widgets/pull/7\n')).toBe(7)
    expect(pullNumber('no pull request here')).toBeUndefined()
  })
})

describe('executor settings', () => {
  it('defaults to the harness with confined workers and a read-only main Session', () => {
    expect(ExecutorConfigSchema.parse({})).toMatchObject({ kind: 'harness', permission: 'workspace-write', routerPermission: 'read-only' })
  })
  it('refuses Command Code with a confined sandbox, which could not write in print mode', () => {
    expect(() => ExecutorConfigSchema.parse({ kind: 'cmd' })).toThrow('danger-full-access')
    expect(ExecutorConfigSchema.parse({ kind: 'cmd', permission: 'danger-full-access' })).toMatchObject({ kind: 'cmd' })
  })
})
