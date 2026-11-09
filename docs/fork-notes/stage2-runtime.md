# Stage 2 Runtime — fork notes (2026-11-03)

Scope: remove the hardcoded `danger-full-access`, make sandbox and executor kind configurable, add a CLI agent adapter
(Claude Code, Codex, Command Code), expose the choice in the panel, and run the sandbox end-to-end with Codex and Command Code.

## What changed

| Area | Change |
| --- | --- |
| Settings (`src/policy.ts`) | `executor.permission` (`workspace-write` default, or `danger-full-access`), `executor.routerPermission` (`read-only` default, `workspace-write`, `danger-full-access`), `executor.kind` (`harness` default, `claude`, `codex`, `cmd`), `executor.cli.{timeoutMinutes,maxTurns}` |
| Session sandbox (`src/app/sessions.ts`, `src/index.ts`) | Sessions append a `sandbox/mode` event from the settings and set `approval` to `never` once; the plugin now injects `approval` so the service is visible on the first `ensure`. The old hardcoded `danger-full-access` is gone. The event is written directly, as `setSandboxMode` does (its type is declared locally because the package is transitive), so the profile's preset table is not flipped on every `ensure`: every preset couples approval to `ask` or `never`, and both roles need `never` with `read-only`/`workspace-write`. |
| CLI adapter (`src/executor/cli.ts`) | `cliArgv`, `cliPrompt`, `parseCliOutput`, `pullTitle`, `pullNumber` for the three CLIs |
| Executor (`src/executor/dsh.ts`) | `launch` runs the CLI in the prepared ticket directory instead of creating a worker Session; `deliver` resumes the CLI with waiting Inputs and marks them read; `stop`/`shutdown` abort it; it holds a worker slot; `handOffCli` commits, pushes and opens/finds the PR, and the PR is bound to the ticket **before** the `ready` report |
| Panel (`src/client/execution.tsx`, `locales.ts`) | Executor kind, worker permission and main-Session permission selects |
| Docs/tests | New `tests/cli-executor.spec.ts`; policy, panel, docs and module table updated; 003/005/006/007 updated |

## CLI behaviour verified on this machine

- **Codex** (`codex exec --json`): events `thread.started`, `item.completed` (`agent_message`, `command_execution`), `turn.completed`. Sandbox is set with `-c sandbox_mode=workspace-write` because `codex exec resume` has no `--sandbox` flag. Full access uses `--dangerously-bypass-approvals-and-sandbox`.
- **Command Code** (`cmd -p --output-format json`): wrapped events (`{"type":"event","event":…}`) and a final `result` line with `finalText`, `sessionId`, `stopReason`, `turnCount`. Print mode **blocks writes and shell commands** with `--accept-edits`/`--tools-all`; only `--yolo` works, so settings reject `cmd` with `workspace-write`.
- **Claude Code** (`claude -p --output-format stream-json`): `system`/`assistant`/`result`; `acceptEdits` plus `CLAUDE_ALLOWED_TOOLS` writes inside the ticket directory. Not run end-to-end yet.

## End-to-end on `zrlONE/dsh-sandbox`

| Run | Result |
| --- | --- |
| Codex, `workspace-write` | Issue #3 → ticket → Codex edited `src/math.ts` and tests, `npm test` passed, PR #4 opened. The ticket ended as completed because the ready report arrived before the GitHub poll found the PR; the binding fix below came from this. |
| Command Code, `danger-full-access` | Issue #5 → ticket → `cmd` updated `test/basic.test.ts`, `npm test` passed, PR #6 opened, ticket stayed in `person/review` (binding fix works). |
| Command Code follow-up | Human comment resumed the stored `cmd` session, added the assertion, pushed a second commit to PR #6. A later CI result delivered as an automatic Input ran once more and correctly reported `No changes to push`. |

The main Session assessed all of these under `read-only` with no problem. Its eval model had to be switched to a Magpie model because the restarted service no longer had `COMMAND_CODE_API_KEY` in its environment.

## Known limits / next steps

- A live main Session keeps its durable model selection: changing `eval.model` affects new Sessions only. Recreate the main Session or use the DSH model picker after switching providers.
- The CLI session id is in memory, so a follow-up after a service restart starts a fresh CLI conversation in the same worktree rather than resuming.
- The plugin now injects `approval`; a host that supplies `permissionPresets` always supplies it, but a bare custom profile would need it too.
- `handOffCli` assumes GitHub (`bindThread` uses `github:<pr>`). Multi-Source projects will need to carry the Source id.
- Claude end-to-end and a harness worker under `workspace-write` still need a run; the harness default changed from full access, so watch the first few workers.
- The `cli` limits are schema-only for now; the panel does not expose them.
- Stage 3 (Projects) starts from here: per-project repository, worktree root, prepare command, models and rules.
