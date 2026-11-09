# Stage 8 Alerts and budgets — fork notes (2026-11-04)

Scope: close the two operational gaps left after the single-project run — nobody noticed a failed Ticket unless they opened
the dashboard, and a runaway worker had no spending limit.

## What changed

| Area | Change |
| --- | --- |
| Guardrails (`src/app/guardrails.ts`) | `Guardrails.tick()` posts one notice per event into the Ticket's own GitHub/Feishu conversations: failed/blocked Report, failed Input delivery, attention question, budget exceeded. State per Ticket is in `KV.alerts.ticket`. |
| Token budgets | `guardrails.budget.ticketTokens` counts the worker + reviewer Sessions; reaching it reports the Ticket `failed`, stops the assignment and alerts. `dailyTokens` counts every Session's day; reaching it pauses processing and alerts through the most recent open Ticket. `0` disables either limit. |
| Settings | New `guardrails` block with `alerts` switches (`enabled`, `failures`, `attention`, `budget`) and `budget` limits. The Execution settings page has an **Alerts and budget** form; the block is saved independently with its own revision. |
| Runtime | `Guardrails` runs after every pass, beside `Workflow`, so it also works when the Workflow is disabled. The daily limit pauses through `Settings.pause(..., 'system')`. |
| Tests/docs | `tests/guardrails.spec.ts`, panel settings test, policy defaults, architecture module/test tables and deployment notes. |

## Verification

- `pnpm typecheck`; targeted `vitest` for guardrails, policy and panel settings.
- Unit cases cover one-shot attention, failed Report, disabled switches, Ticket budget stop and daily pause.
- Live behavior after restart: alerts are off by default; enable **Execution → Alerts and budget** to use them.

## Limits

- Alerts are posted to every Channel the Ticket started in, including GitHub, where they appear as an issue/PR comment.
- Subagent Sessions are not attributed to a Ticket budget; the budget counts the worker and reviewer Sessions.
- A daily budget pauses processing once per day/limit. Raising the limit alerts again; resuming after a pause does not re-pause
  until the next pass, so the limit can be bypassed for that day by an explicit resume.
- Cost in USD is still a dashboard estimate (`DASHBOARD_PRICES`); budgets are token-based.
