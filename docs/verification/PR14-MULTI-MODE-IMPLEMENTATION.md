# PR #14 multi-mode implementation qualification

Implementation branch: `fix/hf-deployment-agent-md-and-build-3606839938468972213`.
The initial task reference was `8abf3f7813c0fdd44dda569e03f8b3c9fbfc75f1`.
The later upstream HF baseline-test commit `88e7ed0d989665b8b5a346608b794202eae59621`
was fast-forwarded into the checkout before publication; its baseline reports are
preserved. Its two JavaScript files were formatted to pass the full format gate.
No existing HF Space file was deleted or uploaded.

## Implementation evidence

See the [architecture/mode matrix](../architecture/ARGUS-MULTI-MODE.md),
[API endpoints](../api/ARGUS-MODES.md), and [UI components/controls](../ui/ARGUS-MODES.md).
All four modes have functioning project-scoped backend workflows, durable
configuration/run history, tasks/evidence artifacts, and explicit blocked outcomes.
UI additions: `ArgusModePanel`, agent chat mode-selection notice, typed
`argusModes` HTTP client and mode task references on existing Kanban cards.

Ten high-value backend integration scenarios use real temporary Git repositories,
atomic durable storage, authenticated Express/Supertest HTTP, the existing fixture
Argus bridge, separate Git worktrees, actual numeric reference/unit subprocesses,
and a fixture OpenCode CLI for optional judge/paper-analysis contracts. They cover:

- Existing Default Manager/Planner contract, idempotent task admission and mandatory
  human merge for mode-generated tasks.
- Authorized REA evidence, hypotheses, supported/refuted experiments, static
  dependency/contract observations and four hashed report artifacts.
- Paper specification, approved separate worktree, generated reference/unit code,
  actual positive/signed numeric reproduction tests, and explicit missing-method/data gaps.
- Versioned Eval good/bad outputs, regression comparison, exact-source gate
  invalidation, aligned datasets and denied judge permissions.
- Real read-only fixture CLI judge calls and configured Planner paper analysis;
  advisory score versus explicitly required judge policy.
- Execution serialization, idempotent retries, revision conflicts, safe mode changes,
  unknown-mode scheduling suppression and recovery without replay.
- Authentication, registered-root/cross-project isolation, source traversal/symlink
  denial, untrusted documents, denied tool input and credential redaction.

Two UI integration tests verify that selection does not run anything, execution
needs a separate click, and untrusted artifact markup renders as escaped text.
Three provenance generation tests plus three build-identity tests reject zero or
missing SHA placeholders while allowing startup. Three existing real Git guard
tests remain passing; the exporter's clean-tree invariant is retained.

The optional-role fixture exposed full environment inheritance in the shared
subprocess helper. Explicit `inheritEnv:false` now preserves the caller's credential
allowlist while leaving other callers' default behavior intact. Proxy, CA and trusted
OpenCode configuration selectors remain available to approved model calls.

## Local canonical validation

The following passed on the combined implementation (logs retained in the task
workspace under `/tmp/task2-*.log`):

| Check                                                              | Result                                                                                                                            |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build:server`                                             | PASS                                                                                                                              |
| `npm run build --workspace=apps/ui`                                | PASS                                                                                                                              |
| `npm run typecheck`                                                | PASS                                                                                                                              |
| `npm run lint:server:errors`                                       | PASS                                                                                                                              |
| `npm run lint:errors`                                              | PASS                                                                                                                              |
| `npm run test:server`                                              | 2,922 passed; 23 existing skips                                                                                                   |
| `npm run test:server:coverage`                                     | 2,922 passed; 23 existing skips                                                                                                   |
| `npm run test:packages`                                            | 1,004 passed, including the two added UI cases                                                                                    |
| Mode/build-identity targeted suite                                 | 13 passed                                                                                                                         |
| Provenance and clean-tree guard Node suite                         | 6 passed                                                                                                                          |
| Formatting, lockfile lint, 11 actual production dependency imports | PASS                                                                                                                              |
| Production backend HTTP smoke                                      | `/health` 200; unauthenticated mode API 401; authenticated registered-project API 200; real REA Plan/Run PASS with four artifacts |

Final server coverage: statements **69.18%**, branches **59.39%**, functions
**78.25%**, lines **69.56%**. Original thresholds and production coverage scope
are unchanged. Initial two native-loading suite failures were environment setup:
frozen installation skips scripts, so the required `node-pty` rebuild was executed
and full tests rerun successfully. No test was disabled to resolve a failure.

## CI and publication evidence

The five ordinary PR workflows previously used a single-star base-branch filter,
which excluded this stacked PR's slash-containing base branch. They now use `**`
so build, tests/coverage, security, formatting and E2E run on PR #14. Argus Platform
also runs on pushes to the mandatory branch and explicitly qualifies mode and
unknown-provenance fixtures. Docker qualification remains an independent job.

Local results are not hosted CI results. The final handoff supplies the exact
published SHA and observed check/run URLs after publication. Do not infer that a
hosted check ran merely because this local table passed. No force push, unrelated
branch or automatic merge is part of delivery.

## Optional capabilities and HF decision

No new heavy dependencies or permanently running per-mode workers were added.
The pinned upstream workflows/licenses are documented; Phoenix's ELv2 evaluation
package is not bundled. Native binary analysis, live target probes, PDF/OCR ingestion,
arbitrary scientific execution and an external Phoenix provider remain optional
unconfigured capabilities. General engineering proposals use the existing Jules
path after explicit approval; only the closed numeric reference catalog executes
locally. Model/provider availability is not inferred from fixture success.

HF assumptions: Linux x64, Node 22, two CPUs, ordinary CPU Space memory, no GPU,
persistent project/metadata storage under the configured data volume and enough
space for isolated worktrees. Neither idle mode selection nor mode API polling
launches a model or heavyweight worker.

**Production deployment decision: NO-GO until the final hosted revision is green
and the separate release checklist/live model/Jules/runtime qualification is
satisfied.** This implementation task does not perform live model/Jules execution,
HF publishing, target content clearing, or deployment approval. Reuse
[the existing release checklist](../deployment/HF-RELEASE-CHECKLIST.md).
