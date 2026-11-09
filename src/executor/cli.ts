/**
 * CLI agent executor: runs a ticket with a non-interactive coding-agent CLI (Claude Code, Codex, Command Code) in the ticket
 * directory, parses its JSON event stream for progress and the final result, and then commits, pushes and opens the pull
 * request itself with the worker git configuration and GitHub CLI, so the CLI needs no network or credentials of its own.
 */
import type { ExecutorKind } from '../policy.ts'

export type CliKind = Exclude<ExecutorKind, 'harness'>
export interface CliLimits { maxTurns: number; timeoutMinutes: number }
/** The sandbox a CLI agent gets: writes confined to its directory unless the executor permission is full access. */
export type CliPermission = 'workspace-write' | 'danger-full-access'

/** Shell commands a Claude Code worker may run without a prompt; everything else is denied in `-p` mode. */
export const CLAUDE_ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite', 'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(npx:*)',
  'Bash(node:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(mkdir:*)']

/**
 * Builds the argv for one CLI run in `directory`; `resume` continues the CLI's own earlier session for a follow-up.
 * - claude: `claude -p <prompt> --output-format stream-json --verbose --max-turns N`, edits accepted, shell limited to
 *   `CLAUDE_ALLOWED_TOOLS` (or every tool under full access).
 * - codex: `codex exec --json --skip-git-repo-check -c sandbox_mode=workspace-write <prompt>` (`resume <id>` for a
 *   follow-up); its resume subcommand has no `--sandbox`, so the mode goes through `-c` for both. No turn cap flag.
 * - cmd: `cmd -p <prompt> --output-format json --max-turns N --trust --yolo --skip-onboarding --no-auto-update`; Command
 *   Code's print mode blocks file writes and shell commands without `--yolo`, so full access is required and refused here
 *   otherwise rather than starting a run that can change nothing.
 * @throws when `cmd` is asked for a confined run.
 */
export function cliArgv(kind: CliKind, prompt: string, directory: string, limits: CliLimits, permission: CliPermission, resume?: string): string[] {
  const full = permission === 'danger-full-access'
  switch (kind) {
    case 'claude': return ['claude', '-p', prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', String(limits.maxTurns),
      ...full ? ['--permission-mode', 'bypassPermissions'] : ['--permission-mode', 'acceptEdits', '--allowedTools', CLAUDE_ALLOWED_TOOLS.join(',')],
      ...resume ? ['--resume', resume] : []]
    case 'codex': return ['codex', 'exec', ...resume ? ['resume', resume] : [], '--json', '--skip-git-repo-check',
      ...full ? ['--dangerously-bypass-approvals-and-sandbox'] : ['-c', 'sandbox_mode=workspace-write'], ...resume ? [] : ['--cd', directory], prompt]
    case 'cmd':
      if (!full) throw new Error('Command Code cannot write files or run commands in print mode under workspace-write; set executor permission to danger-full-access, or use Codex or the harness')
      return ['cmd', '-p', prompt, '--output-format', 'json', '--max-turns', String(limits.maxTurns), '--trust', '--yolo',
        '--skip-onboarding', '--no-auto-update', ...resume ? ['--resume', resume] : []]
  }
}

export interface CliResult {
  /** Whether the CLI reported success (and exited 0). */
  ok: boolean
  /** The agent's final message, or the error it reported. */
  text: string
  /** The CLI's own session/thread id, for a follow-up run. */
  session?: string
  turns?: number
  /** Why the CLI stopped, when it says (such as `end_turn` or a turn cap). */
  stopReason?: string
  /** Token usage the CLI reported for the run, when it reported any. */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** The model the CLI reported using, when it named one. */
  model?: string
  /** Short progress lines (tool uses and interim messages), most recent last. */
  progress: string[]
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
/** Adds one CLI usage record, whose keys are snake_case for Claude and camelCase for Command Code. */
const addUsage = (into: { input: number; output: number; cacheRead: number; cacheWrite: number }, value: unknown): void => {
  const usage = record(value)
  if (!usage) return
  into.input += count(usage.input_tokens ?? usage.inputTokens)
  into.output += count(usage.output_tokens ?? usage.outputTokens)
  into.cacheRead += count(usage.cache_read_input_tokens ?? usage.cacheReadTokens ?? usage.cached_input_tokens)
  into.cacheWrite += count(usage.cache_creation_input_tokens ?? usage.cacheWriteTokens)
}
const textOf = (content: unknown): string => Array.isArray(content)
  ? content.map(block => record(block)?.type === 'text' ? str(record(block)?.text) ?? '' : '').join('\n').trim() : str(content) ?? ''
/** Names of tool calls in a Claude-style content array, for the progress lines. */
const toolsOf = (content: unknown): string[] => Array.isArray(content)
  ? content.flatMap(block => record(block)?.type === 'tool_use' ? [`tool: ${str(record(block)?.name) ?? '?'}`] : []) : []

/**
 * Parses a CLI's newline-delimited JSON output: Claude Code `stream-json` (`system`/`assistant`/`result` events), Codex
 * `exec --json` (`thread.started`, `item.completed`, `turn.completed`, `turn.failed`/`error`) and Command Code `json`
 * (events wrapped as `{"type":"event","event":…}` and a final `result` line with `finalText`). Lines that are not JSON are
 * ignored.
 */
export function parseCliOutput(kind: CliKind, output: string, exitCode: number | null): CliResult {
  const progress: string[] = []
  let text = '', session: string | undefined, turns: number | undefined, stopReason: string | undefined, failed: string | undefined
  let model: string | undefined
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let sawResult = false, resultOk = true
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event: Record<string, unknown> | undefined
    try { event = record(JSON.parse(trimmed)) } catch { continue }
    if (!event) continue
    const type = str(event.type) ?? ''
    session = str(event.session_id) ?? str(event.sessionId) ?? str(event.thread_id) ?? session
    if (type === 'result') {
      sawResult = true
      text = str(event.result) ?? str(event.finalText) ?? textOf(event.content) ?? text
      turns = typeof event.num_turns === 'number' ? event.num_turns : typeof event.turns === 'number' ? event.turns
        : typeof event.turnCount === 'number' ? event.turnCount : turns
      stopReason = str(event.stop_reason) ?? str(event.stopReason) ?? stopReason
      resultOk = event.is_error !== true && (str(event.subtype) ?? 'success') === 'success' && event.ok !== false && !turnCap(stopReason)
      if (!resultOk) failed = text || str(event.subtype) || 'error'
      // Claude and Command Code report the run's usage on the final result; Codex does so per turn.
      if (kind !== 'codex') addUsage(usage, event.usage)
      const models = record(event.modelUsage)
      model = str(event.model) ?? (models ? Object.keys(models)[0] : undefined) ?? model
    } else if (type === 'assistant') {
      const content = record(event.message)?.content ?? event.content
      const said = textOf(content)
      if (said) { progress.push(said.slice(0, 200)); if (kind !== 'claude') text = said }
      progress.push(...toolsOf(content))
    } else if (type === 'item.completed' || type === 'item.started') {
      const item = record(event.item)
      if (type === 'item.completed' && item?.type === 'agent_message') { text = str(item.text) ?? text; progress.push(text.slice(0, 200)) }
      else if (type === 'item.started' && item?.type === 'command_execution') progress.push(`command: ${str(item.command) ?? '?'}`)
      else if (type === 'item.completed' && item?.type === 'command_execution' && item.exit_code !== 0) {
        progress.push(`command exited ${String(item.exit_code ?? '?')}: ${str(item.aggregated_output)?.trim().slice(0, 160) ?? ''}`)
      }
    } else if (type === 'turn.completed') {
      turns = (turns ?? 0) + 1
      if (kind === 'codex') addUsage(usage, event.usage)
    } else if (type === 'turn.failed' || type === 'error') {
      failed = str(record(event.error)?.message) ?? str(event.message) ?? 'error'
    } else if (type === 'event') {
      // Command Code wraps every event once: run/message/turn events carry the result and interim text.
      const inner = record(event.event)
      const innerType = str(inner?.type) ?? ''
      session = str(inner?.sessionId) ?? session
      if (innerType === 'message_end') {
        const content = inner?.content
        const said = textOf(content)
        if (said) { text = said; progress.push(said.slice(0, 200)) }
        progress.push(...toolsOf(content))
      } else if (innerType === 'turn_end' && typeof inner?.turnNumber === 'number') {
        turns = inner.turnNumber
      } else if (innerType === 'model_request_start') {
        model = str(inner?.model) ?? model
      } else if (innerType === 'run_end') {
        const result = record(inner?.result)
        text = str(result?.finalText) ?? text
        session = str(result?.sessionId) ?? session
        stopReason = str(result?.stopReason) ?? stopReason
        turns = typeof result?.turnCount === 'number' ? result.turnCount : turns
      } else if (innerType === 'error') {
        failed = str(inner?.message) ?? str(record(inner?.error)?.message) ?? 'error'
      }
    }
  }
  const capped = turnCap(stopReason)
  const ok = exitCode === 0 && !failed && !capped && (kind !== 'claude' || (sawResult && resultOk))
  const fallback = failed || progress.at(-1) || `${kind} exited with ${exitCode ?? 'a signal'}`
  return { ok, text: ok ? text : text || fallback, ...session ? { session } : {}, ...turns !== undefined ? { turns } : {},
    ...stopReason ? { stopReason } : {}, ...usage.input || usage.output || usage.cacheRead || usage.cacheWrite ? { usage } : {},
    ...model ? { model } : {}, progress: progress.slice(-20) }
}
/** Whether a CLI stop reason names its turn cap, which ends the run without finishing the task. */
const turnCap = (reason: string | undefined): boolean => !!reason && /max[-_ ]?turns?/i.test(reason)

export interface CliTask { title: string; request: string; assignment?: string; repository?: string; followup?: string }
/**
 * The prompt of a CLI run: the request and assignment, and the rules of the hand-off. The executor commits, pushes and opens
 * the pull request, so the agent changes and tests files only.
 */
export function cliPrompt(task: CliTask): string {
  if (task.followup) return `Follow-up on the same task:\n${task.followup}\n\nMake the change in this directory, run the tests, and do not commit or push.`
  return [`You are working on a ticket in the git checkout in the current directory${task.repository ? ` (${task.repository})` : ''}.`,
    `Title: ${task.title}`, `Request:\n${task.request}`, ...task.assignment ? [`Notes:\n${task.assignment}`] : [],
    'Make the smallest change that fulfils the request, add or update tests, and run the project\'s tests (e.g. `npm test`) until they pass.',
    'Do not commit, push, or open a pull request, and do not touch files outside this directory: that is done for you afterwards.',
    'End with a short summary of what you changed and the test result.'].join('\n\n')
}

/** One-line pull request title from a ticket title. */
export const pullTitle = (title: string): string => title.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Agent change'
/** The number of the pull request a GitHub URL names, from the last line of `gh` output. */
export const pullNumber = (output: string): number | undefined => {
  const match = /\/pull\/(\d+)(?:\D|$)/.exec(output.trim().split('\n').at(-1) ?? '')
  return match ? Number(match[1]) : undefined
}
