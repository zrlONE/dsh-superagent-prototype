# Stage 6 Single-project run — fork notes (2026-11-04)

Scope: configure one project (`zrlONE/dsh-sandbox`) and run issue → worker → PR → reviewer → dashboard end to end, with the
new defaults (`workspace-write`, Workflow on, project-scoped execution).

## Project

```json
{
  "id": "sandbox",
  "name": "DSH Sandbox",
  "repository": "zrlONE/dsh-sandbox",
  "directory": "/Users/xiaozhao/.dsh/state/superagent/work-sandbox",
  "prepare": "git clone --shared /Users/xiaozhao/code/dsh-sandbox \"$DSH_SUPERAGENT_DIR\" && cd \"$DSH_SUPERAGENT_DIR\" && git remote set-url origin \"https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git\" && git fetch --no-tags origin \"${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}\" && git checkout -b \"agent/$DSH_SUPERAGENT_NAME\" FETCH_HEAD && npm test",
  "model": null,
  "rules": null,
  "enabled": true
}
```

Active project `sandbox`; executor `harness` + `workspace-write`; main Session `read-only`; Workflow enabled,
`maxRounds=2`.

## First attempt (issue #7) and the worktree finding

The first request used the old `git worktree add` prepare command. The harness worker ran, implemented `min(a, b)` and its
tests, and `npm test` passed, but it could not commit:

```
git could not create /Users/xiaozhao/code/dsh-sandbox/.git/worktrees/<ticket>/index.lock,
denied by workspace-write sandbox because worktree metadata is outside the writable workspace
```

The worker correctly reported blocked with a clear question; approval is `never`, so it did not try to escalate. The ticket
was stopped and its linked worktree/branch removed. This is not a worker bug: under `workspace-write`, a linked worktree's
Git metadata lives in the source clone, outside the Ticket directory.

## Fix

The project prepare command now creates a **self-contained clone** inside the Ticket directory:

- `git clone --shared <local clone> "$DSH_SUPERAGENT_DIR"` — fast, objects shared with the local clone;
- `git remote set-url origin https://github.com/<repo>.git` — push/PR go to GitHub, not the local path;
- `git fetch origin "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}"` and `git checkout -b "agent/$DSH_SUPERAGENT_NAME" FETCH_HEAD` —
  handles both issues (default branch) and PR-origin tickets.

The `.git` directory is now inside the writable Ticket directory, so commit, push and `gh pr create` work under
`workspace-write`.

## Successful run

| Step | Result |
| --- | --- |
| Issue #8 `Add a max helper` | comment mentions `@lon-ac`; GitHub Source polls it |
| Ticket `bea93562…` | accepted, project `sandbox`, directory `work-sandbox/add-max-bea93562e3de` |
| Harness worker | added `max(a, b)` and positive/negative/equal tests; `npm test` 6/6 passed |
| Hand-off | committed `604279c`, pushed `agent/add-max-bea93562e3de`, opened PR #9 |
| Workflow reviewer | independent `reviewer-…` Session, read-only sandbox, reviewed PR #9 and approved in round 1 |
| Dashboard | project `sandbox` shows the ticket; worker 21.9k input / 1.7k output, reviewer 12.4k / 0.5k tokens |

The worktree at `work-sandbox/add-max-bea93562e3de` is clean at `604279c`; `.git` is inside the directory. `PR #9` is open
and awaiting a person; reviewer approval does not merge.

## Docs changed

- `docs/003-execution.md` prepare section now shows the self-contained clone command and explains when `git worktree` is
  still acceptable (`danger-full-access`).
- `docs/006-deployment.md` prerequisite and `SETUP.md` checkout question say the same.

## Upgrade note

Existing Tickets prepared with `git worktree` under the old `danger-full-access` still point at linked worktrees. If such a
Ticket gets a follow-up while `workspace-write` is active, its worker can edit and test but cannot commit. For an existing
deployment switching to `workspace-write`, either keep `danger-full-access` for those Tickets until they end, or recreate
their directories with the self-contained clone.

## Remaining

- PR #9 is open for a person to merge; merging/close would end the Ticket and show `ended` on the Dashboard.
- Issue #7 remains open with the stopped first ticket; it can be closed as superseded.
- Multi-repository polling and Distribution are still pending.
