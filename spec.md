# Automaker + Argus Autonomous Development Specification

Status: implementation specification  
Target repository: `JsonLord/automaker`  
Target branch: `opencode-cli-branch-fix-9526433256615186185`

## 1. Objective

Transform Automaker into an autonomous project-development control plane with Microsoft ArgusAgent embedded as the project brain.

Automaker remains the host application, UI, project registry, Kanban surface, provider configuration owner, and lifecycle supervisor. Argus is installed and managed by Automaker and becomes the long-lived Manager/Planner/Reviewer orchestration brain for every autonomous project.

A project becomes autonomous when a working specification exists. Creating a spec must activate Argus by default. At startup Automaker must discover and resume autonomous projects, reconcile their Git/Jules/GitHub state, decompose outstanding specification work into Kanban tasks, and continue working without requiring Automaker UI interaction.

The default execution hierarchy is:

```text
Automaker
  └─ Argus project brain
       ├─ Manager: objectives, routing, stage transitions, recovery decisions
       ├─ Planner: spec decomposition, next task, evidence/acceptance criteria
       ├─ Junior Engineer: Google Jules REST API
       ├─ Senior Engineer: OpenCode CLI, only when directly routed or escalated
       └─ Senior Reviewer: fresh read-only OpenCode context

GitHub PR + CI
  └─ Argus verdict
       ├─ red CI -> Jules repair loop
       ├─ review changes -> Jules repair loop
       ├─ repeated failure -> Senior diagnosis/takeover
       └─ green CI + exact-SHA approval -> autonomous merge -> local sync
```

Deployment is explicitly outside this system. Autonomous mode may edit code, run tests, create branches/PRs, review, repair, merge, and reconcile Git state, but it must not deploy or publish the project.

## 2. Core design decisions

### 2.1 Argus is part of Automaker

Do not build Argus as a separately operated product or require the user to start a second service manually.

Automaker must:

- install a pinned compatible revision of `microsoft/ArgusAgent` in its production image;
- start and supervise the Argus runtime itself;
- create one Argus project/session identity for each Automaker project;
- expose Argus state through existing Automaker server/UI APIs;
- start/resume Argus automatically for eligible projects;
- stop project workers cleanly when Automaker shuts down;
- reconcile incomplete work after process/container restart.

Automaker is Node/TypeScript while Argus is Python. Do not port Argus to TypeScript. Preserve upstream Argus and add a narrow integration bridge owned by Automaker. Prefer a single long-lived Argus runtime capable of managing multiple project sessions rather than one full Python installation/process per project.

No additional public port may be required. If Argus's WebAPI is used internally, bind it to loopback only and let the Automaker server proxy/consume it. A stdio/JSON-RPC bridge is also acceptable if it proves simpler and more reliable. The UI must continue to talk to Automaker, not directly to Argus.

### 2.2 Argus is an agentic brain, not a deterministic scheduler only

Argus Manager and Planner must remain model-backed agentic roles. They decide how to decompose the current spec, whether work belongs with Junior or Senior, when a failed Junior attempt should receive feedback, and when work should be escalated.

For the first implementation, use Argus's native OpenCode backend for its Manager/Planner role reasoning rather than inventing a second direct-HTTP chat implementation. OpenCode is already supported by Argus and by this Automaker branch.

The same compatible provider may power multiple roles, but role sessions and authority must be isolated:

- Argus Manager context != Argus Planner context;
- Manager/Planner context != Senior Engineer context;
- Senior Engineer context != Senior Reviewer context;
- a reviewer must never review its own implementation context.

The LLM proposes classifications and overrides; deterministic policy validates them. This keeps routing recoverable and testable.

Manual Kanban overrides may set a forced executor, but autonomous operation must not depend on a human setting them.

### 2.3 Worker roles

Default:

- **Jules = Junior Developer** and normal implementation worker.
- **OpenCode = Senior Reviewer** for every Jules PR.
- **OpenCode = Senior Engineer** only for work Argus classifies as senior-level or after escalation.

The Senior Reviewer is read-only. It may inspect code, diffs, tests, CI evidence, spec/acceptance criteria and repository context, but may not edit files or commit.

The Senior Engineer receives a separate write-enabled OpenCode session. Work produced by Senior Engineer must use an isolated task branch/worktree and must never mutate the canonical base branch directly.

### 2.4 YOLO autonomy policy

Within repository development operations, default to autonomous execution. Do not add human approval gates for auth files, workflow files, migrations, destructive refactors, or merges merely because they are risky code changes.

Still enforce hard system boundaries:

- never expose, print, persist in Git, or place secrets in prompts unnecessarily;
- never deploy, release, publish packages, change external production infrastructure, make purchases, or perform unrelated account administration;
- never force-push the canonical base branch;
- never delete unreconciled local work without first making a recoverable snapshot;
- never merge a PR whose reviewed head SHA differs from the currently tested head SHA.

## 3. Provider and secret configuration

Required Hugging Face Space secrets/environment variables:

```text
COMPATIBLE_URL
COMPATIBLE_MODEL
COMPATIBLE_API_KEY
JULES_API_KEY
GITHUB_PAT
```

Optional future role overrides may be introduced, for example `ARGUS_MANAGER_MODEL`, but the default must work from only the five variables above.

### 3.1 OpenCode compatible provider

At container startup, Automaker must idempotently upsert one Automaker-managed OpenCode provider using:

- `COMPATIBLE_URL` -> provider base URL;
- `COMPATIBLE_MODEL` -> selected model;
- `COMPATIBLE_API_KEY` -> runtime credential.

Never serialize the literal `COMPATIBLE_API_KEY` into a committed project file. Prefer OpenCode's environment-variable credential mechanism. If OpenCode requires an auth store at runtime, keep it outside project Git, permissions `0600`, and make the provider config reference the environment-derived credential.

Do not replace or destroy existing OpenCode providers/models. Update only the Automaker-managed provider section.

Detect the installed OpenCode configuration format/version rather than assuming a stale schema.

### 3.2 Argus role configuration

Default role mapping:

```text
manager  -> opencode / COMPATIBLE_MODEL
planner  -> opencode / COMPATIBLE_MODEL
reviewer -> opencode / COMPATIBLE_MODEL, read-only
engineer -> external Jules adapter by default
senior-engineer -> isolated opencode / COMPATIBLE_MODEL when routed/escalated
```

Argus already supports per-role model/backend resolution; integrate with that mechanism instead of flattening all roles into one session.

### 3.3 Jules

Use the current Google Jules REST API directly unless an official maintained SDK is available at implementation time. Do not invent a dependency on a nonexistent SDK.

Base API currently documented as `https://jules.googleapis.com/v1alpha`.

Authenticate every request with `x-goog-api-key: $JULES_API_KEY`.

The adapter must support at minimum:

- list/get connected sources;
- create repository-bound session;
- `automationMode: AUTO_CREATE_PR`;
- plan auto-approval (`requirePlanApproval: false`) in YOLO mode;
- get session;
- list activities;
- sendMessage while a session is active;
- extract resulting PR/artifact information;
- bounded polling with exponential backoff/jitter;
- 429/5xx retry handling;
- terminal failure reporting;
- restart/reconciliation by persisted Jules session id.

Jules sources are pre-connected through Jules/GitHub. If the current repository cannot be matched to a Jules source, mark the task blocked with an actionable diagnostic; do not fabricate a source.

### 3.4 GitHub CLI

The image must contain `gh` and `git`.

At runtime:

```text
GH_TOKEN = GITHUB_PAT
```

Prefer `gh auth setup-git` / GitHub's credential-helper behavior over writing the PAT into remote URLs or checked-in configuration.

Do not fall back from `GITHUB_PAT` to `HF_TOKEN` or unrelated secrets. Do not treat `JULES_API_KEY` as an OpenCode credential. Each secret has exactly one purpose unless explicitly configured otherwise.

The current branch's startup code contains historical credential fallbacks; replace them with strict named-secret handling.

## 4. Project control files

Every Automaker project gets a project constitution/control set.

### 4.1 `ARGUS.md` — stable objective charter

Automatically create `ARGUS.md` for every new project and for an imported project when its first spec is created.

It contains human/project-level intent:

- project objective / north star;
- success conditions;
- architectural constraints;
- non-goals;
- test/quality expectations;
- definition of done;
- persistent instructions that future specs must respect.

Argus may read `ARGUS.md` but must not silently rewrite its objectives to make work easier. Only explicit user/project-author changes may alter the objective charter. Automaker may create the initial charter from project creation/spec-generation inputs.

### 4.2 `spec.md` — mutable executable plan

`spec.md` is the current execution specification.

When a spec is created:

1. ensure `ARGUS.md` exists;
2. create/update `spec.md` so it concretely advances `ARGUS.md`;
3. create/validate `.automaker/argus.yaml`;
4. enable autonomy by default;
5. start/resume the project Argus brain;
6. decompose the spec into Kanban work.

Argus may regenerate or revise `spec.md` when:

- all current spec tasks are complete but `ARGUS.md` objectives are not yet satisfied;
- evidence shows the current spec is impossible/stale/incomplete;
- implementation reveals required follow-up work;
- a recovery/reconciliation pass discovers drift between current code and objectives.

Argus must not erase history. Before replacing a working spec, persist a revision record with old spec hash, new spec hash, timestamp, reason, and triggering evidence. Git history may provide the content history; additionally keep machine-readable revision metadata in project state.

The flow is one-way in authority:

```text
ARGUS.md (stable objective)
    -> spec.md (mutable current plan)
        -> tasks
            -> code/PRs
```

Never infer a new `ARGUS.md` objective from whatever code happened to be produced.

### 4.3 `.automaker/argus.yaml` — policy/configuration

Generate a default configuration similar to:

```yaml
version: 1
autonomy:
  enabled: true
  mode: yolo
  resume_on_startup: true
  deployment: disabled
routing:
  default_executor: jules
  senior_executor: opencode
  reviewer: opencode
  jules_ci_repair_attempts: 2
  senior_feedback_then_jules_attempts: 1
merge:
  strategy: merge
  require_ci_green: true
  require_senior_review: true
  require_exact_head_sha: true
git:
  remote: origin
  sync_on_startup: true
  sync_after_merge: true
```

Do not place secrets in this file.

### 4.4 Machine state

Persistent runtime state belongs under Automaker's data directory / existing persistence mechanism, not necessarily in Git. It must include enough information to resume idempotently:

- project id;
- Argus session/project id;
- current spec revision/hash;
- task ids and Kanban state;
- forced/default executor;
- Jules session id and URL;
- GitHub repository identity;
- base branch;
- task branch;
- PR number/URL;
- current PR head SHA;
- CI run/check state;
- reviewer verdict and reviewed SHA;
- retry counters;
- last known remote base SHA;
- last locally reconciled SHA;
- last merge commit SHA;
- recovery snapshot/stash refs if any.

Never persist API keys in this state.

## 5. Startup behavior

Autonomous project continuation is the default.

On Automaker startup:

1. validate required tools and named secrets;
2. idempotently configure OpenCode provider;
3. validate `gh` authentication;
4. start/supervise the integrated Argus runtime;
5. enumerate Automaker projects;
6. for each project with `spec.md` or `ARGUS.md`, migrate/create `.automaker/argus.yaml` if absent and default autonomy to enabled;
7. reconcile Git, GitHub PR/CI, Jules session and Argus task state;
8. resume incomplete work;
9. if no work is active, ask Argus Planner to compare code/spec/objectives and populate the Kanban;
10. if current spec is complete but objectives remain, have Argus generate the next spec revision and continue.

A legacy project with neither a spec nor objective charter remains idle until a spec is created.

Startup reconciliation must not create duplicate Jules sessions, duplicate PRs or duplicate Kanban tasks.

## 6. Routing and overrides

Routing is a hybrid of model judgment and deterministic guardrails.

Argus Manager receives:

- `ARGUS.md`;
- current `spec.md` revision;
- task acceptance criteria;
- relevant repository summary;
- current Kanban state;
- previous attempt history;
- Jules failure/CI/review evidence;
- executor availability.

Manager returns a structured routing decision with reason/evidence, for example:

```json
{
  "executor": "jules",
  "reason": "bounded implementation with explicit tests",
  "risk": "normal",
  "escalationCondition": "two failed CI-repair attempts"
}
```

Baseline policy:

- bounded bug fixes, tests, localized features, mechanical implementation -> Jules;
- cross-cutting architecture, difficult migrations, major refactors, repeated failure, or tasks explicitly requiring senior judgment -> Senior Engineer;
- every implementation -> Senior Reviewer before merge;
- two automatic Jules CI/review-repair attempts -> Senior diagnosis/feedback;
- one final Jules repair after Senior feedback -> Senior takeover if still failing.

A Kanban/manual override may force `jules` or `senior`, but Argus remains responsible for lifecycle transitions and review.

## 7. Kanban as the operational surface

Argus owns Kanban task lifecycle. The Kanban is a projection/control surface over durable orchestration state, not the sole source of truth.

Each card should expose at least:

- title and acceptance criteria;
- spec revision;
- executor (`Jules` / `Senior`);
- Argus phase;
- branch;
- Jules session id/link if used;
- PR number/link;
- head SHA;
- CI status;
- repair count;
- Senior Reviewer verdict;
- next action;
- latest concise Argus status/report.

Argus may autonomously create, split, reorder, reassign, move and close cards.

Suggested lifecycle:

```text
BACKLOG
 -> PLANNED
 -> ASSIGNED_JULES | ASSIGNED_SENIOR
 -> IMPLEMENTING
 -> PR_OPEN
 -> CI_CHECK
    -> CI_FAILED -> JULES_CI_REPAIR -> CI_CHECK
    -> CI_GREEN -> SENIOR_REVIEW
 -> REVIEW_CHANGES -> JULES_REPAIR -> CI_CHECK
 -> APPROVED
 -> MERGE_READY
 -> MERGED
 -> LOCAL_SYNCED
 -> DONE
```

Every transition must be idempotent and journaled.

## 8. Jules implementation loop

For a normal task:

1. Argus Planner produces bounded task prompt + acceptance criteria + evidence required.
2. Git reconciliation records an exact base branch and base SHA.
3. Resolve the repository's Jules source.
4. Create Jules session from that branch with `AUTO_CREATE_PR` and no plan approval.
5. Persist session id before waiting.
6. Poll session/activities using bounded adaptive backoff.
7. Mirror meaningful progress into the Kanban without flooding it.
8. When Jules returns a PR, resolve exact PR number, branch and head SHA from GitHub.
9. Run/observe GitHub CI for that exact head SHA.
10. If CI fails, collect failed jobs/steps/log excerpts and send a focused repair request while the session is active when valid; otherwise create a new repair session against the correct branch/source state.
11. Never assume `sendMessage` can revive a terminal Jules session.
12. After two failed Jules repairs, obtain Senior diagnosis and feed its concrete findings into one final Jules repair.
13. If that fails, route implementation to Senior Engineer.

Prompts sent to Jules should include task-specific context, not the complete historical log.

## 9. Senior review and senior implementation

### 9.1 Senior Reviewer

Create a fresh read-only OpenCode review context for each review attempt.

Inputs:

- objective/spec section;
- task acceptance criteria;
- PR diff and changed files;
- exact head SHA;
- CI/test evidence;
- relevant code context;
- prior review feedback only when applicable.

Structured output:

```json
{
  "verdict": "approve | changes_required | blocked",
  "reviewedHeadSha": "...",
  "findings": [],
  "requiredChanges": [],
  "evidence": []
}
```

The reviewer may not edit the repository.

An approval is invalid immediately if the PR head SHA changes.

### 9.2 Senior Engineer

When Argus routes/escalates implementation to Senior Engineer, create an isolated OpenCode write session and task branch/worktree. It may implement and test but it may not write directly to the canonical base branch.

Normal autonomous flow should remain Jules-first. Senior takeover is the exception, not a hidden rewrite of all Junior work.

## 10. CI repair loop

For a PR CI failure:

```text
GitHub Actions/check fails
 -> Automaker obtains exact failing run/jobs/steps
 -> Argus creates concise failure evidence
 -> Jules CI Fixer attempt 1
 -> new head SHA
 -> CI
 -> Jules CI Fixer attempt 2 if needed
 -> Senior diagnosis
 -> Jules final repair
 -> Senior takeover if still failing
```

Do not send Jules the entire GitHub Actions history. Send the exact failed checks, useful error excerpts, current head SHA, task criteria and relevant diff/context.

The repair counter is tied to task + PR lineage and survives restart.

## 11. Git/GitHub synchronization contract

This section is a hard correctness requirement. Remote GitHub state is authoritative for autonomous integration; the local Automaker checkout must be made an exact, recoverable projection of the selected remote base branch after each merge and at startup.

### 11.1 Invariants

1. Never write implementation commits directly to the local canonical base branch.
2. Jules normally creates commits remotely on its PR branch.
3. Senior implementation, if required, uses an isolated branch/worktree.
4. The canonical local base branch is only advanced during reconciliation.
5. Every review and CI verdict is tied to an exact commit SHA.
6. Never force-push the canonical remote base branch.
7. Never discard dirty/divergent local state without a recovery ref/snapshot.
8. A per-project Git mutex/lease serializes fetch/reconcile/merge/sync operations.
9. Git operations are idempotent: retrying after a crash produces the same final base SHA rather than duplicate commits/PRs.

### 11.2 Before dispatch

Under the project Git lock:

1. verify `origin` and repository identity;
2. determine configured/default base branch;
3. `git fetch --prune origin`;
4. inspect working tree, local base SHA and `origin/<base>` SHA;
5. if dirty, create a named recoverable snapshot/stash before cleaning the Automaker-owned autonomous checkout;
6. if local base contains unique commits or diverges, create `automaker/recovery/<timestamp>-<sha>` before realigning;
7. fast-forward when possible; otherwise realign only after recovery snapshot;
8. record exact `base_sha` used for task dispatch.

Do not silently lose manual work.

### 11.3 PR tracking

When Jules reports completion, GitHub is the authority for PR metadata. Resolve and persist:

- PR number;
- base ref;
- head ref;
- head OID/SHA;
- state;
- mergeability/check status.

Do not infer the PR head only from a Jules message.

If Jules pushes another repair commit, invalidate old CI/reviewer state and restart checks for the new SHA.

### 11.4 Merge strategy

Default merge strategy: **merge commit**, not squash and not rebase.

Reason: this autonomous system benefits more from forensic traceability than perfectly flat history. A merge commit preserves Jules's original commit SHAs and repair sequence, while rebase changes SHAs and squash destroys commit-level evidence.

Merge only when all are true for the same PR head SHA:

- required CI/checks are green;
- fresh Senior Reviewer verdict is `approve`;
- `reviewedHeadSha == currentHeadSha`;
- base branch has not changed in a way that invalidates mergeability;
- PR is still open/mergeable.

Use `gh pr merge --merge` or equivalent GitHub API behavior. Include task id, spec revision and Jules session id in PR/merge metadata where practical.

### 11.5 Post-merge local synchronization

After GitHub confirms merge:

1. obtain the authoritative merge commit/base head from GitHub;
2. `git fetch --prune origin`;
3. verify `origin/<base>` contains the merged PR;
4. under Git lock, ensure any dirty/unexpected local state has a recovery snapshot;
5. check out the canonical base branch;
6. make local base exactly match `origin/<base>`; use fast-forward when possible, otherwise a controlled reset is permitted only because recovery state was created first;
7. verify `git rev-parse HEAD == git rev-parse origin/<base>`;
8. persist `last_remote_base_sha`, `last_local_base_sha`, merge PR and timestamp;
9. only then transition `MERGED -> LOCAL_SYNCED -> DONE`.

Do not mark a task done merely because GitHub says the PR merged.

### 11.6 Startup reconciliation matrix

At restart, compare persisted state, Jules, GitHub and local Git.

Examples:

- Jules still active, no PR -> resume polling; do not create another session.
- Jules completed, PR exists -> attach to that PR.
- PR open, CI running -> resume CI observation.
- PR head changed -> invalidate stale approval/check records.
- PR already merged, local behind -> sync local only.
- local already equals remote merge SHA -> mark sync idempotently complete.
- local diverged/dirty -> recovery snapshot then reconcile.
- task says active but PR was closed unmerged -> Argus recovery decision; do not pretend success.

## 12. Commit/checkpoint policy

Create meaningful traceable checkpoints at development gateways, not token-level edits.

Expected checkpoints/events:

- initial objective/spec creation;
- spec revision;
- Jules implementation commits (owned by Jules);
- each CI-repair iteration (Jules commit(s));
- Senior takeover branch commits when needed;
- merge commit;
- Automaker/Argus control-plane changes when the application itself is being developed.

Runtime state transitions must also be journaled even when they do not warrant a Git commit.

For projects being autonomously developed, implementation code should normally arrive through PR commits rather than Automaker making arbitrary local commits on base.

## 13. Spec completion and self-renewal

When all cards for the current `spec.md` revision are DONE:

1. Argus Reviewer/Manager evaluates repository evidence against the current spec and `ARGUS.md`;
2. if objective conditions are met, mark the project objective satisfied/idle;
3. if objective conditions are not met, generate a new `spec.md` revision from unmet objective gaps;
4. journal the spec revision reason/evidence;
5. generate new Kanban tasks automatically;
6. continue autonomous execution.

This makes Argus persistent without allowing it to move its own goalposts.

## 14. Failure and recovery policy

Normal work must not block forever.

Classify failures as:

- missing secret/tool;
- Jules source unavailable;
- Jules API retryable/non-retryable error;
- CI failure;
- review failure;
- Git divergence/sync conflict;
- executor crash/timeout;
- exhausted repair budget;
- impossible/contradictory spec.

Missing credentials and impossible product ambiguity may surface prominently to the user. Otherwise Argus should attempt bounded autonomous recovery.

Use leases with expiry/heartbeat so a crashed process does not leave tasks permanently owned.

## 15. Automaker UI/API requirements

Integrate rather than create a separate Argus UI.

Add project-level visibility/control for:

- autonomy enabled/running/paused/error;
- current Argus Manager phase;
- current spec revision;
- active executor;
- Jules session;
- PR/CI/review state;
- Git sync state;
- latest Argus report;
- forced executor override;
- pause/resume/reconcile actions.

Existing Kanban cards should be extended where possible rather than duplicated in a second board.

Argus should publish concise status summaries into Automaker after major transitions and completion.

## 16. Production image and startup fixes

The current target branch already installs OpenCode and GitHub CLI, but the implementation must audit and correct the production image/startup path.

Required changes include:

- install Python tooling required for the pinned Argus source installation (Python 3.11+ compatible runtime, pip/venv as required);
- pin Argus to a known tested upstream commit/ref rather than an unbounded moving `main` dependency;
- add an explicit upgrade path/documentation for changing the pin;
- ensure Docker's default `BRANCH_NAME` points to this target branch or is removed if copying the checked-out source makes cloning unnecessary;
- remove historical secret guessing/fallbacks;
- use `COMPATIBLE_*`, `JULES_API_KEY`, `GITHUB_PAT` exactly;
- keep secrets out of logs;
- run startup doctor/health checks without requiring interactive login;
- do not expose an additional public Argus port.

## 17. Implementation strategy

Implement in vertical milestones and keep the branch runnable after every milestone.

### Milestone A — baseline and integration seam

- inventory current project/spec/Kanban/OpenCode/Git services;
- document current baseline tests/build;
- add typed `ArgusService` interface in Automaker server;
- install/pin Argus in the image;
- create supervised local bridge/runtime;
- prove one Automaker project can create/resume an Argus project and query status;
- no Jules dispatch yet.

### Milestone B — provider and project control files

- strict named env handling;
- compatible OpenCode provider upsert;
- generate `ARGUS.md`, `spec.md`, `.automaker/argus.yaml` lifecycle;
- enable autonomy on spec creation;
- auto-resume/reconcile on startup;
- map Argus Manager/Planner/Reviewer roles to isolated OpenCode sessions.

### Milestone C — Jules Junior adapter

- source matching;
- sessions/activities polling;
- AUTO_CREATE_PR;
- persistent session state;
- Kanban projection;
- crash-safe resume.

### Milestone D — GitHub CI/review/repair

- resolve exact PR/head SHA;
- observe checks/workflows;
- focused CI failure evidence;
- two Jules repair attempts;
- read-only Senior review;
- one post-Senior Jules repair;
- Senior takeover.

### Milestone E — merge and Git reconciliation

- merge-commit policy;
- exact-SHA merge gate;
- recovery refs for dirty/divergent local state;
- post-merge exact local/remote synchronization;
- startup reconciliation matrix;
- concurrency locks/leases.

### Milestone F — spec self-renewal and complete autonomy

- objective gap evaluation;
- automatic spec revisioning;
- task regeneration;
- full startup autonomous cycle;
- UI controls/status;
- end-to-end restart tests.

## 18. Required tests

At minimum add automated tests for:

1. OpenCode compatible provider upsert is idempotent and preserves unrelated providers.
2. Secrets are not serialized into project files/log output.
3. `ARGUS.md` is created once and not silently rewritten by Argus spec renewal.
4. Creating a spec enables autonomy and starts/decomposes work.
5. Startup resumes an already-active project without duplicate Jules session.
6. Jules session creation uses correct source/base and AUTO_CREATE_PR.
7. Jules terminal state plus existing PR is recovered after restart.
8. CI failure targets current head SHA and increments persisted repair count.
9. Changing PR head invalidates previous reviewer approval.
10. Two Junior repairs -> Senior diagnosis -> one Junior repair -> Senior takeover.
11. Merge cannot occur with red CI, stale review SHA, or non-current PR head.
12. Merge uses merge-commit strategy by default.
13. Dirty local state gets a recovery snapshot before realignment.
14. Diverged local base gets a recovery ref before reset.
15. After merge, local base exactly equals `origin/<base>` before DONE.
16. Restart after remote merge but before local sync completes reconciliation without a duplicate merge.
17. Concurrent task events cannot run two merge/sync operations for one project.
18. Completed spec with unmet `ARGUS.md` objective produces a new spec revision.
19. Completed objective does not generate infinite replacement specs.
20. Deployment commands are never invoked by autonomous development flow.

Provide mocked contract tests for Jules/GitHub plus at least one opt-in live smoke test that requires explicit environment variables and cannot run accidentally in normal CI.

## 19. Observability

Use structured events with project/task ids. Important events include:

```text
argus.project.started
argus.project.resumed
argus.route.decided
argus.spec.revised
jules.session.created
jules.session.state_changed
jules.pr.detected
github.ci.started
github.ci.failed
github.ci.green
review.started
review.approved
review.changes_required
repair.attempted
senior.escalated
pr.merge.started
pr.merged
git.recovery_snapshot.created
git.sync.started
git.sync.completed
task.done
objective.satisfied
```

Never log secret values.

## 20. Definition of done

This transformation is complete when a fresh Automaker deployment can be given the five secrets, import/create a GitHub-backed project, create a spec, and then without further UI interaction:

1. create/maintain the project objective charter;
2. activate Argus;
3. decompose the spec into Kanban work;
4. route normal work to Jules;
5. observe Jules until a PR exists;
6. react to CI failures with the bounded repair policy;
7. obtain an independent OpenCode Senior review;
8. merge only green, exact-SHA-approved work;
9. synchronize the local Automaker checkout exactly to GitHub;
10. resume correctly after a container restart at any point in the flow;
11. generate the next spec from unmet stable objectives when needed;
12. stop when the objective is satisfied;
13. never deploy the project.

No hidden dependency on an interactive shell, second manually-started Argus app, or manually approved Jules plan is acceptable.
