# Stage 4 Workflow — fork notes (2026-11-03)

Scope: an independent reviewer for a ready ticket, automatic CI-fix rounds, a shared round cap, and a watchdog for stuck
assignments.

## What changed

| Area | Change |
| --- | --- |
| Settings (`src/policy.ts`) | `workflow` block: `enabled` (off by default), `reviewerModel`, `maxRounds` (3), `watchdog` (on), `timeoutMinutes` (60) |
| State (`src/kv.ts`) | `KV.workflow.state(ticketId)` holds `reviewRound`, `ciRound`, `status`, `lastReviewedAt`, reviewer session id, the latest verdict, and `watchdogAt` |
| Sessions (`src/app/sessions.ts`) | New `reviewer` role: `reviewer-<ticket id>`, worker preset, `read-only` sandbox, worker-model override; reviewer sessions are decorated with a short reviewer prompt and their own tools |
| Reviewer tools (`src/app/tools/reviewer.ts`) | `orchestrator_read` plus `workflow_review` (verdict, summary, issues) |
| Workflow (`src/app/workflow.ts`) | Runs after every pass: starts a reviewer for a new ready report with an open PR, turns `changes` into a note Input that wakes the writer, enforces `maxRounds` for reviews and CI failures, and stops/watchdog-fails a stuck assignment |
| Panel | Execution → Workflow: enable, reviewer model, max rounds, watchdog and timeout |
| Views/docs | Ticket detail exposes its workflow state; 003/005/006/007 and README updated |

## How it behaves

- A ready Report with an open pull request starts review round `reviewRound + 1`. The reviewer works in the ticket checkout
  under a `read-only` sandbox, runs the tests, and calls `workflow_review` exactly once.
- `approve` relays to the main Session and leaves the Ticket in `person/review`; the Workflow never merges.
- `changes` sends the summary and issues to the writer as a note Input (which wakes it), and the next ready Report starts
  the next review round.
- Exhausting `maxRounds` (review or CI fixes) reports the Ticket `failed`, stops the assignment, and tells the main Session.
- The watchdog uses the latest of assignment start, delivery, idle end, Report and Input times; a ready Ticket waiting for a
  person is not considered stuck.
- Reviewer model priority: `workflow.reviewerModel` → the project's worker model → the Executor model.

## Verification

- `pnpm typecheck`, `pnpm test` (61 files, 1228 tests) and `pnpm build` pass.
- Unit tests cover review/CI/watchdog decisions, verdict handling (approve, changes, last-round failure, duplicate/wrong
  reviewer), and the tick starting exactly one reviewer per ready report.
- Live: enabled the Workflow on the running service with `maxRounds=2`; the two existing ready tickets (PR #2 and PR #6)
  each started a `reviewer-*` Session, ran in the ticket checkout, called `workflow_review`, and were approved in round 1.
  The `workflow` health entry stayed `ready`.

## Known limits / next step

- A ticket without a bound pull request is not reviewed; the reviewer only sees the checkout and the PR.
- Reviewer approval is advisory: it does not enable auto-merge or change the Ticket stage.
- CI rounds are counted from CI-failure Trigger Inputs that reached the ticket, not from a fresh CI read; a failure reported
  before the Ticket existed does not count.
- The reviewer keeps the worker preset's write/edit tools; the read-only sandbox is the boundary, not the tool list.
- The panel shows workflow state only in the Ticket detail API for now (no dedicated section/row badge).
- Multi-repository polling remains the unfinished part of Projects.
