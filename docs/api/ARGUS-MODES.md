# Argus mode API

All routes below are relative to `/api/argus`. Existing authentication is required.
Every request identifies a registered project with `projectId` or `projectPath`
(GET query, otherwise JSON body). Arbitrary directories and cross-project run IDs
are rejected. `/api-docs` also lists these routes.

| Method | Route                                  | Request/result                                                                                                                              |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/modes`                               | Mode descriptors, versions and pinned upstream metadata                                                                                     |
| GET    | `/mode`                                | Current mode, durable revision/configs, runs and history                                                                                    |
| PUT    | `/mode`                                | `{mode, expectedRevision, config?}`; optimistic revision guard, no autonomy change                                                          |
| POST   | `/mode/command`                        | `{command: "/rea"}` (or `/default`, `/paper2code`, `/eval`); selection only                                                                 |
| POST   | `/mode/plan`                           | `{input, idempotencyKey}`; creates durable validated plan, never executes it                                                                |
| POST   | `/mode/run`                            | `{runId, approval?: {repositoryChanges:true,sourceSha}}`; explicit run                                                                      |
| GET    | `/mode/runs/:id`                       | Project-owned immutable input/config snapshot, status, tasks, events, artifacts                                                             |
| GET    | `/mode/runs/:id/artifacts`             | `{artifacts:[{name,content,mediaType,sha256,evidenceId}]}`                                                                                  |
| POST   | `/mode/runs/:id/tasks/:taskId/approve` | `{approved:true,sourceSha}`; admission to existing Argus requires repository-change/model-call permissions, no autonomy activation or merge |
| GET    | `/mode/gate`                           | Current-source Eval recommendation and evidence IDs; `authorizesMerge:false`                                                                |

Shared TypeScript contracts are in `libs/types/src/argus-modes.ts`; runtime schemas
are in `apps/server/src/services/argus/modes/contracts.ts`. Unknown fields and
unbounded arrays/strings are rejected. Config defaults:

```json
{
  "capabilities": { "repositoryRead": false, "referenceImplementation": false, "llmJudge": false },
  "permissions": { "repositoryChanges": false, "modelCalls": false },
  "evaluation": { "minimumScore": 1, "requireJudge": false }
}
```

Selecting a mode is independent from granting capabilities/permissions. Saving a
new config invalidates prior unexecuted plans; plan again afterward. Run actions
are idempotent; a terminal or interrupted run is returned without replay. To retry
an explicitly reviewed interrupted operation, create a new plan/key after inspecting
its persisted worktree/task intent. A blocked validation returns a durable blocked
run and a report of missing capabilities. Operational failures cannot produce a
fabricated passing score.

REA takes a question, `authorized:true`, explicit supplied `sources` (observations
or permitted repository paths) and hypotheses linking a source ID, claim and literal
`contains` experiment. No live URL probe, recursion, tool command or native binary
execution is accepted. Paper2Code takes title, text/documentPath/reference, optional
ambiguities and structured numeric reference algorithm/examples. Missing PDF/OCR,
methods or datasets stay blocked/unproven. Configured read-only paper analysis
uses the existing Planner model identity. Eval takes dataset ID/version/rubricVersion,
rule and aligned candidate rows `{id,input,expected,actual}` plus explicit model and
commit SHA per candidate. `baselineRunId` must reference a compatible completed Eval
inside the same project. `useJudge` additionally requires both capability and permission.

The existing authenticated `POST /api/agent/send` also intercepts the four exact
slash selection commands, resolves the registered working directory, and returns
the selected mode/description without invoking the agent. Extra command arguments
are rejected rather than forwarded to an unrestricted tool-using model. The UI uses
the mode command API and displays a selection notice.

Error examples: 400 invalid input/selection command; 401 unauthenticated; 403 denied
permission/approval/root; 404 unregistered project or project-local run missing;
409 stale revision/plan, active task, busy execution or incompatible baseline;
503 unavailable/corrupt storage or required service. Detailed source, credentials
and raw provider diagnostics are never echoed by the mode route error wrapper.
