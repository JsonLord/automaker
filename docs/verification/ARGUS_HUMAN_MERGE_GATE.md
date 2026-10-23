# Argus human merge gate

Qualified foundation: PR [#19](https://github.com/JsonLord/automaker/pull/19),
`8298262e39b9b30da1fbb5006220cdd96d8b4625`. Its branch is unchanged.
The corrective branch is `fix/argus-human-merge-gate`, based directly on that commit.

## Invariants

- `ARGUS_AUTOMATIC_MERGE = FORBIDDEN`
- `HUMAN_GITHUB_MERGE = REQUIRED`
- `PRODUCTION_RELEASE = HUMAN_APPROVAL_REQUIRED`

Milestone E observes GitHub; it cannot request a merge. The GitHub observer no
longer implements the merge mutation. GitIntegrationService's compatibility entry
point always rejects with `ARGUS_AUTOMATIC_MERGE_FORBIDDEN`, without contacting
GitHub. No YAML, mode, optional `requiresHumanMerge`, or agent-provided actor field
can authorize a merge. GitHub permissions and branch rules separately govern
external actors; observation does not assert that an external actor was human.

## Lifecycle and durable evidence

CI success and Senior approval must match the exact current PR head. Configured
Loki verification must be VERIFIED for the repository, PR, head and verified base.
`merge-ready` remains the existing Merge Gate lane; `nextAction` becomes
`human-merge-required`. The status API and Kanban's existing `argus` payload expose
`humanMergeGate`: repository, PR number, URL, expected head, base and readiness time.
Readiness is not an approval record. There is no new human actor assertion.

Waiting projects make one remote observation per runner wake, with a 60-second
interval plus at most 5 seconds jitter. Reconciliation creates no merge intent,
remote ownership tag, or merge mutation. Legacy intents remain durable forensic
evidence and are never retried. Changed heads invalidate CI, Senior, Loki and
readiness evidence. Closed unmerged PRs, identity mismatches, missing merge SHAs,
and failed gates block completion.

An external merge is recorded as `EXTERNAL_MERGE_OBSERVED` before gate validation,
including incomplete or mismatched observations for inspection. Only a validated
merge creates `externalMerge` evidence. Existing legacy intents may be resolved
from authoritative GitHub state, but new intents are never fabricated. After local
synchronization, DONE additionally requires exact remote repository/PR/head/base,
matching external merge evidence, merge ancestry, local/remote equality, passing
exact-head CI/review, no active execution lease, and no blocked reason.

Canonicalized project paths serialize duplicate observations, including symlink
aliases, in this process. The existing runner's durable project fence coordinates
runner reconciliation across processes. Local synchronization failures preserve the
observed merge and block for operator recovery. Restart after a persisted DONE
does not emit another TASK_DONE event.

## Deterministic qualification

`milestone-e.test.ts` exercises green gates without merge, repeated observations,
restart while waiting, true/false/absent optional mode flag, untrusted YAML actor
claims, offline external merges, stale heads, identity mismatches, missing merge
SHA, failed CI, stale review, required Loki, legacy unknown intents, concurrent
completion, local-sync failure/recovery and independent DONE requirements.

`autonomy-runner.test.ts` exercises actual Milestone E on startup and persisted
restart for enabled and paused projects, and verifies bounded polling without
Planner/Jules dispatch. Campaign fixtures now wait for an external merge event.
`platform-pipeline.test.ts` retains Jules repair, Loki and exact-SHA Senior review
and simulates GitHub changing externally; no merge mock changes remote state.
Mode integration verifies the same gate for approved default-mode work.

Static audit command:

```sh
rg -n -i 'gh pr merge|pulls/.*/merge|merge_method|mergePullRequest|createMergeIntent' apps/server/src scripts
```

The sole source match is the unconditional deny compatibility entry point. Full
stack and exact published commit evidence are recorded in ARGUS_STACK_INTEGRATION.md
and the linked PR checks. No live models, Jules sessions, GitHub merges or HF
mutations are used in these tests.
