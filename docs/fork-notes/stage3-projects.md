# Stage 3 Projects — fork notes (2026-11-03)

Scope: make the deployment multi-project and multi-repository. Each project has its own repository, worktree root,
prepare command, worker model, and assessment rules. This step ships the project model and per-project execution;
concurrent polling of every project repository is the next step.

## What changed

| Area | Change |
| --- | --- |
| Settings (`src/policy.ts`) | `projects: Project[]` and `activeProject`; `ProjectSchema` (`id`, `name`, `repository`, `directory`, `prepare`, `model`, `rules`, `enabled`); helpers `projectsOf`, `activeProjectOf`, `projectById`, `projectFor`, `rulesForProject`; `policyVersion` includes projects and the active project |
| Assessment (`src/app/assessment.ts`, `src/core/*`) | `Candidate.projectId`; `EngineOptions.projectId(trigger)`; `MasterAssessor` evaluates a candidate against its project's rules and puts `project` + `rules` in the eval payload; `assessmentOutcome` accepts an explicit rule list |
| Execution (`src/executor/dsh.ts`, `src/app/execution-environment.ts`) | Ticket worktree root from the project (`directory` or `<stateDir>/work/<id>`); project prepare command; project worker model passed to `Sessions.ensure`; environment repository from the project; CLI hand-off uses the project repository |
| Sources | GitHub triggers carry `meta.repository`; `Commands.withRepository` scopes GitHub reads; channel addresses carry `repository`; thread context reads the trigger's repository |
| Settings API/panel | New `projects` block (`{projects, activeProject}`); saving it syncs the active project's repository into the GitHub Source, rechecks push access and restarts; the Execution page has a project list editor with active switch, repository, worktree root, prepare, model, rules and enabled switch |
| Tests/docs | Project policy/execution tests, panel project editor test, 003/005/006/007 and README updated |

## Behaviour

- A Ticket's project is derived from its origin Trigger's `meta.repository`. Without configured projects, one synthetic
  default project comes from the active GitHub Source and the Executor's directory/prepare/model, so single-repository
  deployments keep their old root and settings.
- The ticket's directory and model are fixed when it is accepted; changing projects later does not move it.
- `DSH_SUPERAGENT_GITHUB_REPOSITORY` in a ticket's execution environment is its project's repository, and the CLI
  executor's commit/push/PR hand-off uses the same repository.
- The active project drives the GitHub Source's `repository`: its notifications and repository-wide streams belong to
  that repository. Selecting another active project saves the source repository, validates the agent account and restarts.

## Verification

- `pnpm typecheck`, `pnpm test` (60 files, 1216 tests) and `pnpm build` pass.
- Added tests cover repository-to-project resolution, project rule narrowing, policy-version changes, project worktree
  roots, and adding a project from the panel.
- No live multi-repository run yet; the sandbox still has one repository.

## Known limits / next step

- Only the active project's repository receives new notifications, Issues/PRs, comments and default-branch CI. Existing
  Tickets in another project keep their Subscriptions, but a new issue there is not observed until it becomes active.
- Feishu triggers have no repository, so they use the active project.
- GitHub thread keys are still `github:<number>`; concurrent multi-repository polling needs repository-scoped Thread keys
  (for example `github:<repo>#<number>`) and repository-scoped cursors/retry maps, plus a migration for existing Threads.
- `orchestrator_read` of `github/...` resources still uses the deployment's default repository unless the caller passes a
  scoped `Commands`.
- The panel has no project filter on the Execution page yet; the Dashboard phase can add that across projects.
