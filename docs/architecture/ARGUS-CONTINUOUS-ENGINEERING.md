# Argus continuous engineering

Read [ADR 001](decisions/001-argus-authority-and-workers.md) and the
[live test plan](../verification/JULES-LIVE-TEST-PLAN.md) before enabling integrations.

## Ownership and defaults

The existing Runner is the only scheduler. It executes bounded transitions and
persists its next wake. Registered project identity resolves through canonical
paths under `ALLOWED_ROOT_DIRECTORY`. API requests acknowledge durable queued
controls with HTTP 202; that does not mean remote execution completed.

Production authentication cannot be disabled by the development bypass.
`AUTHENTICATION_TOKEN` or `AUTOMAKER_API_KEY` supplies API authentication. Browser
sessions use the existing cookie flow. Keys never belong in URLs, project files,
build arguments, task descriptions, evidence, or logs.

| Setting                                            | Default / meaning                                           |
| -------------------------------------------------- | ----------------------------------------------------------- |
| `ARGUS_LOKI_ENABLED`                               | `false`; opt-in verification                                |
| `ARGUS_LOKI_VERIFY_PR`                             | `true`; false makes verification unavailable                |
| `ARGUS_LOKI_REQUIRED_FOR_MERGE`                    | `false`; true blocks on any non-VERIFIED verdict            |
| `ARGUS_LOKI_MAX_REPAIR_ATTEMPTS`                   | `2`, bounded to 0–2                                         |
| `ARGUS_LOKI_WORKER_URL`                            | trusted HTTPS worker endpoint, no embedded credentials      |
| `ARGUS_LOKI_WORKER_TOKEN`                          | bearer credential, external worker only                     |
| `ARGUS_CONTINUOUS_ENGINEERING_ENABLED`             | `false`; bounded Scout admission after objective completion |
| `ARGUS_LOKI_REVIEW`, `ARGUS_LOKI_EXECUTOR_ENABLED` | reserved, unsupported; do not enable expecting execution    |

Jules uses `JULES_API_KEY`, a linked GitHub repository source, and repository API
permissions. `GITHUB_PAT` maps to `GH_TOKEN`. GitHub must allow PR inspection,
required checks, annotated tag/ref creation and deletion, and approved merges.
Require strict status checks and enforcement for administrators. Integration CI
must run on the GitHub test merge commit with the exact current base and PR HEAD.
Missing protection or integration checks blocks merging.

OpenCode 1.18.35 is pinned in Docker. Compatible providers use `COMPATIBLE_URL`,
`COMPATIBLE_MODEL`, and `COMPATIBLE_API_KEY`. Generated configuration references
`{env:COMPATIBLE_API_KEY}`. ArgusAgent is pinned to source
`746f76b7a74a1217507c9ee348eecd3b782f7c92`, package 0.1.1.
Senior review/diagnosis receives supplied bounded evidence in an isolated temporary
working directory and `OPENCODE_PERMISSION={"*":"deny"}`. These are evidence-only
reviews; they do not run repository tests. Local Senior implementation fails closed
with `SENIOR_ISOLATED_EXECUTOR_UNAVAILABLE`; a production isolated implementation
worker remains a separate integration, never a public remote shell.

## Authenticated API

All paths below are under `/api/argus`. Supply `projectId` or registered absolute
`projectPath` in JSON for POST, query parameters for GET. Traversal, unknown projects,
roots that escape the allowed directory, and symlinked metadata are rejected.

| Method | Path                                  | Behavior                                                   |
| ------ | ------------------------------------- | ---------------------------------------------------------- |
| GET    | `/health`                             | safe build identity, installed capabilities, runner health |
| GET    | `/status`                             | canonical task, exact-SHA proof summaries, campaign        |
| POST   | `/pause`, `/resume`                   | queue durable autonomy control                             |
| POST   | `/wake`, `/reconcile`                 | queue work; paused projects reject with 409                |
| POST   | `/campaign/start`                     | atomically start one campaign; accepts `options`           |
| POST   | `/campaign/pause`, `/campaign/resume` | preserve original deadline                                 |
| POST   | `/campaign/drain`                     | finish/reconcile existing work; no new tasks               |
| POST   | `/campaign/stop`                      | stop local scheduling and finalize report                  |
| GET    | `/campaign`, `/campaign/status`       | current campaign                                           |
| GET    | `/campaign/report`                    | persist and return evidence-backed report                  |

Campaign options: `mode` (`normal`/`overnight`), `durationMs` (1s–8h), `drainMs`
(0–duration), `maxNewTasks` (1–100), `maxRepairAttempts` (0–20). Defaults are 8h,
30min drain, 30 tasks, five total repair attempts, one worker. Duration supports
accelerated tests, not deadline extensions. Resume never extends a deadline.

## Durable state and recovery

Project `.automaker/` contains:

- `argus-state.json`: versioned canonical project/task, exact SHAs and reconciliation.
- `argus-control.json`: requested/handled revisions and pending operator intent.
- `campaigns/current.json` and `campaigns/reports/<id>.json`: deadline, reservations,
  repair counts, progress and reports. Reports explicitly label unavailable cost accounting.
- `tasks/<task-hash>.json`, `task-history.json`: archived task evidence before renewal/clear.
- `verification/<task-hash>/<head>.json`: bounded Loki results and counters.
- `discovery.json`: hypotheses, dispositions, bounded admission history, quiescence.
- `experiments/index.json`, `experiments/<id>.json`: baseline, variants, claims, measurements.
- `worker-waves.json`: optional dependency/worker claim ledger.
- `pipeline.json`: existing custom lanes, including Argus lanes.

Infrastructure leases live in the operator-selected shared state directory as
`worker-leases.json`. Use a persistent directory shared by all allocating instances.
Files use serialized atomic writes with fsync and rename. State revisions reject
stale writers; corrupt authoritative JSON is an error, never a fresh empty state.
Unknown locks are not stolen. Investigate their owning process/host before removal.

At 7.5h campaigns drain. At 8h they persist completion/expiry and stop reconciliation;
remote Jules sessions remain intact. Restart reads the same deadline and reservations.
A remote PR/task still pending appears in the report. Operator stop does not cancel
remote work. Infrastructure/auth failures block honestly. A blocked task with an
ambiguous remote owner is retained; automatically abandoning it to create unrelated
replacement work is intentionally unsupported.

Merge intent persists the repository tag claim owner before remote mutation. On
unknown merge outcome retain ownership and inspect the authoritative GitHub PR on
restart. Own claims can be recovered; expired claims block until operator review.
Never delete a claim unless the original operation is confirmed stopped/complete.
If a crash occurs before the returned tag SHA is persisted, compare the annotated
tag owner with the durable intent before manual release. Never steal another owner.
Canonical synchronization preserves dirty/divergent work using immutable recovery
refs. Do not delete recovery refs until displaced work is reviewed. Tracked
`.automaker` metadata blocks canonical synchronization to protect authority.

## Loki external-worker contract

Upstream inspected: asklokesh/loki-mode at
`13a829b52eae1bde74a444779868c6209e569e2c` (BSL 1.1 restrictions).
Real help confirms `loki verify-pr <GitHub PR URL> --out <directory>`.
The worker must enable `LOKI_VERIFY_PR=1`, install its own permitted Loki package,
provide the documented sandbox/image, and isolate checkout/setup/test execution.
No local Loki process or privileged socket is mounted in the control plane.
No standalone read-only review mode is claimed.

`RemoteLokiExecutor` POSTs `{runId, command, args, timeoutMs}` with bearer auth.
The trusted worker must return the same `runId`, `sandboxVerified:true`, `exitCode`,
and `result` containing the unmodified `verify-pr-result.json` structure:
`verdict`, `pr:{repo,number}`, `base`, `head`, `checks`, `reasons`, `blocked`, `notes`.
Inspect `verification.ts` for the exact executable contract. Results are bounded
64KB, timed out, redacted, and checked against repository/PR/HEAD/base identities.
The worker endpoint/implementation is operator-supplied; an installed adapter alone
is not an operational verifier. Verdicts are VERIFIED, FAILED, NOT_PROVEN,
UNAVAILABLE, ERROR. Optional unavailable evidence remains visible, never VERIFIED.
Repairs retain the same active Jules session and PR, persist intent first, and
require an authoritative new GitHub HEAD before reverification. Unknown message
outcomes are not blindly resent. Terminal sessions escalate safely.

## Discovery and experiments

Scout currently consumes persisted Loki evidence gaps to propose discriminating
regression tests. Other observation sources are extension points, not claimed as
implemented ingestion. Each proposal includes evidence references, observation,
hypothesis, expected improvement, baseline, measurement, threshold, fixture,
negative control, verification command, confidence and disposition. Manager receives
objective/spec, proposal, budgets and completed-task history; Planner follows only
admitted evidence. Sensitive proposals require human approval and cannot execute.
Without justified work the project becomes QUIESCENT/NO_ACTION. `ARGUS.md` is never
rewritten by discovery. Limits are five proposals, three admissions, five discovery
iterations; single active execution. General provider cost accounting is NOT_PROVEN.

The optional `EngineeringExperiments` boundary accepts a reproducible baseline and
2–3 isolated variants, shared commands, numeric metric/direction and minimum
improvement. It reevaluates the baseline and all candidate SHAs externally. Missing,
stale, incorrect, tied or insufficiently improved measurements are inconclusive.
One durable evaluation claim, no automatic retries, maximum three experiments per
project, one active evaluation. Optional token/cost caps require measured usage;
missing usage cannot satisfy them. `admitWinner` sends only the selected variant
through Manager/Planner and normal PR gates. It does not merge variants or claim
that the external evaluation worker is installed. Variant generation and automatic
experiment selection from Scout remain disabled extension points.

## Board and worker extensions

`ArgusBoardProjector` derives existing card statuses and appends dynamic Loki,
QA/CI, Senior, Merge Gate columns. A verified card requires merge and local sync.
Generic edit/delete/import/ownership mutation and generic Auto Mode execution cannot
change Argus authority. The existing board shows task/session/PR/HEAD, proof, repair
count, next action, blockers and campaign controls/report. Other board modes remain.

`ArgusWorkerWaves` is an optional durable graph/claim library, disabled by default.
It supports dependency admission, max two claims, owned completion, pending
cancellation, cycle rejection, restart/stale ownership. It has no independent loop
and is not wired to parallel Jules dispatch. Production remains sequential.

`InfrastructureProvider` offers disabled, static/mock and Foreman implementations.
Foreman uses HTTPS, authenticated GET `/api/hosts/:id`, API-v2 Accept header,
allowlisted numeric host IDs, bounded responses and timeout. Configure URL,
username and personal access token in a private composition root; no public API
accepts these. Capabilities are operator-attested inventory. The constructor is
explicitly disabled by default. There are currently no environment-driven automatic
Foreman activation or provisioning routes. Static claims validate CPU/RAM/runtime,
isolation, approved commands and duration. Expired/unknown claims retain capacity.
`LeasedExperimentEvaluator` associates external results and leases; failed transports
retain claims, successful completed results release them. No host destruction exists.

## Build and release

Run `npm ci --ignore-scripts`, `npm rebuild node-pty`, `npm run build:server`,
`npm run build --workspace=apps/ui`, `npm run typecheck`, both error-level lint
commands, `npm run test:server`, `npm run test:packages` on Node 22/Python 3.
CI uses no production secrets. A configured workflow is not evidence of a green
GitHub run. Follow the [HF checklist](../deployment/HF-RELEASE-CHECKLIST.md) for the
committed-source deterministic export and separate publishing operations.
