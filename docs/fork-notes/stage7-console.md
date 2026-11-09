# Stage 7 Control console — fork notes (2026-11-04)

Scope: turn the standalone dashboard into a control console for the running application without moving the backend out of
DSH. The UI remains independent of the Harness Web UI; the control actions go through the application's management API.

## What changed

| Area | Change |
| --- | --- |
| Dashboard view (`src/app/views/dashboard.ts`) | Each Ticket carries `actions: { retry, stop }`; `retry` follows the domain's `canRetry`, `stop` is offered for every open Ticket |
| Console server (`scripts/dsh-superagent-dashboard.mjs`) | `POST /api/action` proxies pause/resume, retry and stop to the management API; same token/cookie rules; a small body limit and an action allowlist |
| UI (`dashboard/index.html`, `app.js`, `style.css`) | Header pause/resume button; per-Ticket retry/stop buttons with confirmation for stop; inline action errors; reload after an action |
| Docs/tests | 009/006 updated; the rendering test covers the controls; live pause/resume verified |

## Actions

- `pause` / `resume` → `POST /orchestrator/api/executor/pause` with `{paused}`.
- `retry` + `ticketId` → `POST /orchestrator/api/tickets/:id/retry`.
- `stop` + `ticketId` → `POST /orchestrator/api/tickets/:id/stop`.

The console still reads `GET /orchestrator/api/dashboard` every 10 seconds. The backend remains a DSH profile; removing DSH
entirely is the separate host-replacement project.

## Verification

- `pnpm typecheck`, `pnpm test` (64 files, 1235 tests), `pnpm build` pass; `node --check` passes for the board and server.
- Live: `POST /api/action {"action":"pause"}` returned `{"paused":true}`, the board reflected it, `resume` returned
  `{"paused":false}`; an unknown action returned HTTP 400.
- Ticket actions are exposed: open Tickets offer stop, retryable ones offer retry; ended Tickets offer neither.
- The single-project run's PR #9 was merged by `zrlONE` while this work was in progress; the Ticket ended as `merged`, and
  the board shows it as ended with the workflow verdict preserved.

## Limits

- Settings, projects, prompts and Sources remain in the DSH-hosted application panel; the console only handles processing
  pause and Ticket lifecycle actions.
- The backend still requires DSH/Cordis. A true standalone host (no DSH) is a larger refactor and overlaps Distribution.
- The console process is not yet managed by `scripts/dsh-superagent`.
