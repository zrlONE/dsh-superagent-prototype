# Stage 1 Baseline — fork notes (2026-11-03)

- Fork: https://github.com/zrlONE/dsh-superagent-prototype (origin), upstream = deepseek-ai/dsh-superagent-prototype
- Local: ~/code/dsh-superagent, branch feat/multi-agent-platform (nothing committed/pushed)
- Engines: node ^22.19 || >=24 (Mac mini had 22.1.0 → installed 22.23.4 via fnm), pnpm 11.7.0 (ok), dsh ^0.2.1-alpha.2 (npm latest @deepseek-ai/dsh 0.2.1-rc.5; docs pin 0.2.1-rc.3)

## pnpm check
- typecheck: PASS; build (tsdown): PASS (11 files, 693 kB)
- test: 1196/1197 pass. Only failure: tests/environment.spec.ts:93 expects git stderr "no email was given";
  git on this Mac emits Chinese messages (zh locale), so the string match fails. Env/locale issue, not a code bug.
  LANG/LC_ALL=C did not help (test sanitises env). Fix later in test (force LC_ALL=C in its env) or ignore.

## Module map
| Concept | Files |
|---|---|
| Runtime (composition root, Cordis plugin) | src/index.ts, src/app/runtime.ts |
| Engine (pure, sync, no I/O) | src/core/engine.ts + parts intake.ts, evals.ts, tickets.ts, assignments.ts, replies.ts; ports.ts, model.ts, stage.ts |
| Router (main Session) | src/app/sessions.ts, src/app/assessment.ts (MasterAssessor), src/app/tools/main.ts, src/app/notices.ts, prompts/ |
| Ticket/Assignment | src/core/tickets.ts, src/core/assignments.ts, src/core/model.ts |
| Store (node:sqlite, migrations) | src/app/store.ts, store-read.ts, migration.ts, effects.ts (durable queue), outbox.ts |
| Sources | src/sources/kind.ts, registry.ts, github*.ts, feishu*.ts, poll.ts |
| Executor | src/executor/dsh.ts (DshExecutor, WorkerSlots), src/executor/background.ts, src/app/tools/executor.ts, src/app/delivery.ts |
| Policy | src/policy.ts, src/admission.ts |
| Panel | src/client/ (React, Harness Web client plugin), src/app/http.ts, api.ts, views/ |
| Setup/env | src/app/setup.ts, src/setup.ts, src/deployment.ts, src/infra/ |
| Watchdog | NOT implemented; docs/006 suggests an hourly check in another Harness profile. Only restart-recovery + effect retries exist |

## Harness coupling
- Whole app is a Cordis plugin bundle loaded into a DeepSeek Harness profile (cordis.patch.yml, package.json "dsh" field, peerDeps @deepseek-ai/cordis, dsh-agent, dsh-session, dsh-llm, dsh-subprocess, dsh-scope, dsh-api-session-controller, client-ui-*). ~22 src files import @deepseek-ai/*.
- Sessions: router + one `worker-<ticket>` Harness Session each; created/resumed via dsh-agent/dsh-session (src/app/sessions.ts, executor/dsh.ts). Executor relies on Session events: user/message taken into history (inputsRead), turn end, errors, steering messages into a running turn, inbox injection.
- Presets: `dsh-superagent-worker` / `dsh-superagent-router` defined in cordis.patch.yml (danger-full-access shell, 5 s fg→bg job, subagents under `standard`).
- Tools: report/reply/handback/etc. are Harness tools registered per Session (src/app/tools/*); background jobs/subagents tracked via Harness (executor/background.ts).
- Subprocess: setup probes and worker shells via dsh-subprocess. Panel: Harness Web sidebar + design tokens + plugin manager.

## Seam for AgentAdapter
- Clean port already exists: `Executor { start, deliver, stop }` in src/core/ports.ts, with callbacks EngineForExecutor (assignmentStarted, inputsDelivered, inputsRead, turnEnded, deliveryFailed, report, handback, followForContext, markUnrelated, assignmentInterrupted).
- Plan: new src/executor/cli.ts (CliExecutor) implementing Executor over an AgentAdapter {launch(dir,prompt,model), send(sessionId,text), cancel, events: turnEnded/error/sessionId, capabilities{resume, stream, steer, structuredOutput}}; adapters claude (`claude -p --output-format stream-json --resume`), codex (`codex exec --json` / resume). Worker tools (report/reply/handback) exposed to CLIs via a local MCP server or a `sa` CLI the worker calls.
- Router/MasterAssessor also need a non-Harness LLM session (same adapter, or a direct API call) — second seam: Sessions.
- Steering mid-turn isn't supported by -p CLIs: deliver Inputs at turn end/resume instead (capability flag).

## Single-repo assumptions
- GitHub Source config has one `repository`; DSH_SUPERAGENT_GITHUB_REPOSITORY env; setup checks push to that repo; one execution root + one prepare command; one agent account notifications filtered to repo; repository context for assessor. Change to Project{id, repo, localClone, prepare, agentDefaults}; Ticket.projectId; Source instances per project (registry already supports multiple instances).

## To run the baseline end-to-end (not done)
- `npm i -g @deepseek-ai/dsh@0.2.1-rc.3`, a dedicated `superagent` profile, a model provider (DeepSeek API key) configured in Harness
- A separate GitHub *user* account for the agent with write access to a test repo + gh-agent wrapper login
- Feishu bot optional; git ≥2.32; preferably a separate macOS user (danger-full-access)

## Verdict
Decouple within the fork is feasible, but as "keep core, replace host": src/core (pure, 0 Harness imports), policy, store/effects/outbox, sources are reusable as is; Runtime, Sessions, DshExecutor, tools, Panel (≈ the whole src/app glue + client) are Harness-bound and must be rewritten as a standalone Node host. Do not try to shim Harness. Stage 2 = standalone runtime in the fork reusing src/core etc.; keep upstream mergeable for core by not editing core files more than needed.
