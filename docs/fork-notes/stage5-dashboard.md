# Stage 5 Dashboard — fork notes (2026-11-03)

Scope: a standalone, responsive, cross-project board with Tickets, agent Sessions, workflow state and token usage, outside
the Harness Web UI.

## What changed

| Area | Change |
| --- | --- |
| Usage (`src/app/usage.ts`) | `UsageMeter` counts `assistant/message` token usage per Session and day, deduplicates replayed sequences, persists in `KV.usage.session`, and accepts CLI-reported usage; `Sessions` observes every managed Session and backfills persisted Sessions at startup |
| API (`src/app/views/dashboard.ts`, `src/app/http.ts`, `src/app/api.ts`) | `GET /orchestrator/api/dashboard` joins projects, Tickets, worker/reviewer/orchestrator Sessions, workflow state and usage |
| Standalone server (`scripts/dsh-superagent-dashboard.mjs`) | Serves the board and proxies the API; loopback by default, token auth for a non-loopback host, optional `DASHBOARD_PRICES` cost estimates |
| UI (`dashboard/`) | Responsive desktop/mobile board: health, KPI cards, projects, Tickets, agents, usage by model and the last seven days |
| CLI usage | `parseCliOutput` reads Claude/Codex/Command Code token usage and model, and the Executor adds it to the ticket's worker Session |
| Docs/tests | `docs/009-dashboard.md`; usage, dashboard view and board-rendering tests; module/test tables updated |

## Behaviour

- The board polls every 10 seconds and is read-only. It shows runtime health (including source/workflow errors), the pause
  state, the active project, and the workflow switch.
- Project rows count open, working, awaiting-review and failed Tickets and sum their tokens; Ticket cards show the stage,
  workflow round/verdict, worker/reviewer live status, model, tokens and last update; the title links to its source.
- Usage is per Session and per day. Restarting backfills loaded and persisted managed Sessions from their event logs, so the
  main Session and historical worker/reviewer usage are not lost. Replayed events are ignored by sequence.
- CLI executors report token usage in their JSON streams; the Executor records it under `cli/<model or kind>` for the
  ticket's worker Session. Historical CLI runs from before this change are not backfilled.
- `DASHBOARD_PRICES` maps a model route to USD per 1M tokens; cost is estimated for the total, today, each model, Ticket,
  project and agent. Unpriced models contribute tokens but no cost.
- Token auth: `DASHBOARD_TOKEN` set, the board's first `?token=…` visit sets an HttpOnly SameSite=Strict cookie and redirects
  to `/`; a non-loopback bind is refused without a token.

## Verification

- `pnpm typecheck`, `pnpm test` (64 files, 1235 tests) and `pnpm build` pass.
- Live: the API returned 2 open Tickets, both `person/review` with workflow `approved`, 6 agent rows, and 121k input /
  7.7k output / 700k cache tokens across the orchestrator, reviewers and the earlier harness worker.
- Dashboard server: `/`, `/style.css`, `/app.js` and `/api/dashboard` return 200; token auth returns 401 without a token and
  302 + cookie with it; prices produced `$0.1739` total, `$0.0237` / `$0.0457` per Ticket and `$0.0694` for the project.
- The board's rendering logic is covered by a jsdom test; a real browser was not available in this environment, so the
  visual layout was not screenshot-verified.

## Limits / next step

- The board process is separate: `scripts/dsh-superagent` does not start/stop it yet (Distribution will package it).
- Agent live status is only known while the Session is loaded; after a restart it shows `not loaded` until the Session loads.
- CLI usage is captured only for runs after this change; old CLI runs show no tokens.
- Cost pricing is an operator-supplied estimate, not a provider invoice.
- Multi-repository polling remains the unfinished part of Projects.
- Next: Distribution (remote execution nodes, packaging, one-click deployment).
