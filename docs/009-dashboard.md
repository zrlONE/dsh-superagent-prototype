# 009 Dashboard

The dashboard is a standalone, responsive board for all projects. It is not part of the DeepSeek Harness Web UI and reads
the running application through its management API.

## Start

```sh
node scripts/dsh-superagent-dashboard.mjs
```

It serves `http://127.0.0.1:3083/` and proxies `/api/dashboard` to `http://127.0.0.1:3082` with the management API's
same-origin header. The application must already be running (`scripts/dsh-superagent start`).

Configuration is by flag or environment:

| Flag | Environment | Default | Meaning |
| --- | --- | --- | --- |
| `--port` | `DASHBOARD_PORT` | `3083` | HTTP port |
| `--host` | `DASHBOARD_HOST` | `127.0.0.1` | Bind address; a non-loopback host requires a token |
| `--api` | `DASHBOARD_API` | `http://127.0.0.1:3082` | Management API base |
| `--token` | `DASHBOARD_TOKEN` | empty | Access token; the first visit with `?token=…` sets an HttpOnly cookie |
| `--prices` | `DASHBOARD_PRICES` | `{}` | JSON prices per 1M tokens, keyed by `provider/model` |

To read it on a phone on the same network:

```sh
DASHBOARD_HOST=0.0.0.0 DASHBOARD_TOKEN='a long random string' node scripts/dsh-superagent-dashboard.mjs
```

Open `http://<computer-ip>:3083/?token=<token>` once. The token stays in a cookie; the address bar is cleaned. The
management API remains on loopback; only the board's proxy is exposed.

## What it shows

- **Runtime health** from the application's health entries, the pause state, and the active project.
- **Projects** with open, working, awaiting-review and failed counts, and their token usage.
- **Tickets**: open Tickets and recent ended ones, each with its project, stage, workflow verdict/round, worker and reviewer
  status, summary, tokens and last update. The title links to its source URL when it has one.
- **Agents**: the main Session, each worker and reviewer Session with its live status, model, and tokens.
- **Usage**: total and today's tokens, the last seven days, and tokens by model. Cost is shown when prices are configured.

Token usage comes from each Session's `assistant/message` events and is persisted per Session in the state database, so it
survives restarts; replayed events are not counted twice. Usage is counted across the main Session, workers, reviewers and
subagents. A CLI executor's own reported usage (Claude, Codex or Command Code) is added for the ticket's worker Session when
the CLI reports it.

## Controls

The standalone console can act on the running application through its own `POST /api/action` endpoint, which proxies the
management API with the same token/cookie rules:

- **Pause / resume** processing from the header; the header shows the current state.
- **Retry** a stalled Ticket whose latest Report is `failed` or `blocked`, or whose input delivery failed.
- **Stop** an open Ticket (with a confirmation); its running assignment is stopped and the Ticket ends.

The board reloads after each action and reports an error inline if the management API refuses it. These actions change the
application, so the console is no longer read-only; it still does not replace the Harness-hosted runtime. The full settings,
projects, prompts and source configuration remain in the application's own panel.

## Prices

`DASHBOARD_PRICES` maps a `provider/model` route to USD per one million tokens:

```json
{
  "magpie-responses/codex/gpt-6.1-sol": { "input": 1.25, "output": 10, "cacheRead": 0.125, "cacheWrite": 1.25 },
  "cmdcode/deepseek/deepseek-v4-flash": { "input": 0.27, "output": 1.1 }
}
```

Unpriced models contribute nothing to cost; the token counts remain exact. The board shows `费用未配置` when no price is set.
Prices are an estimate for the operator's own accounting, not a provider invoice.

## Limits

- The board polls every 10 seconds. It can pause/resume processing and retry/stop Tickets, but other settings, projects,
  prompts and Sources are edited in the application panel.
- It reflects the running process only; after a restart, usage remains but the live agent status starts empty until a
  Session loads.
- The board is a separate process from the application. `scripts/dsh-superagent` does not start or stop it yet.
