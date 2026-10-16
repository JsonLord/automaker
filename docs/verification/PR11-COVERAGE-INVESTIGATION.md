# PR #11 coverage investigation

The red server check combined a real test coverage gap with an incorrect measurement scope. Tests passing did not imply that the configured coverage thresholds passed.

## Reproduced failures

At starting PR head `930d093b697c25d0d534fd5a087552e8da36cf8b`, `npm run test:server:coverage` ran **2,606 passing tests, with 23 skips**, but failed the unchanged 75% function and 55% branch thresholds:

| Measurement                                          | Statements | Branches | Functions |  Lines |
| ---------------------------------------------------- | ---------: | -------: | --------: | -----: |
| Original server command                              |     65.70% |   54.10% |    70.80% | 66.26% |
| Original report restricted to imported server source |     67.86% |   57.50% |    71.67% | 68.44% |
| Corrected configured server scope, before new tests  |     57.61% |   49.85% |    62.54% | 57.83% |

The original configuration used `src/**/*.ts` although the command ran with the repository root. Vitest 4's executed-file matching uses substring matching, so server tests importing UI utilities also measured UI source. Untested-file discovery resolved that same glob against the repository root, found no root `src`, and omitted 33 server source files. This configuration was already present at the PR base.

The configuration now pins the repository root and qualifies coverage paths with `apps/server/src`. Reports go to `apps/server/coverage`, the location used by CI artifact collection. Existing scope exclusions are retained; no threshold was reduced and no production module was newly excluded to obtain a passing result. The inherited gates remain statements/lines 60%, branches 55%, functions 75%.

## Meaningful tests and defects

New tests exercise credential environment isolation and subprocess races; provider error classification and bounded retries; Codex tool/patch/todo event compatibility; GitHub dispatch/PR identity checks; actual temporary Git repositories for staging boundaries, stash recovery, branch creation and commit-log parsing; agent metadata discovery; and durable event-history isolation and concurrent mutations. Additional lifecycle and recovery tests cover the generic auto-mode services and test runner. The test-runner cases first reproduced duplicate concurrent starts, a completed short run reported as running, and a terminal error overwritten by a later exit. The narrow fixes reserve an in-flight worktree start, preserve the first terminal result, and emit lifecycle events in order. Auto-mode integration tests also enforce Argus ownership before generic execution or recovery and verify the active project/worktree registry. Fixtures use temporary repositories and mocked provider/process boundaries; no live Jules session, deployed server, or production secret is required.

The history tests first reproduced three failures: a mutable shared fallback index leaked event summaries between projects, clearing history restored stale summaries, and simultaneous writers collided on timestamp-named temporary files. The fix clones fallback values, uses UUID temporary names, and serializes store/delete/clear through the existing durable file lock. Filesystem access validation precedes lock creation; secure filesystem record/index I/O and the existing disk schema remain in use. These tests do not claim a separate cross-process simulation; the shared lock utility's own tests cover its ownership behavior.

One discovery limitation remains outside this change: tests cover symlink entries inside agent directories, not physical containment when the agent base directory itself is a symlink. This investigation does not claim that those tests establish complete symlink containment.

## Final result

`npm run test:server:coverage` passes with **2,901 tests passed and 23 existing skips** across 123 passing files and one skipped file. All inherited global thresholds pass:

| Metric     |          Final coverage | Threshold |
| ---------- | ----------------------: | --------: |
| Statements | 68.16% (8,760 / 12,851) |       60% |
| Branches   |  58.17% (4,962 / 8,530) |       55% |
| Functions  |  77.04% (1,420 / 1,843) |       75% |
| Lines      | 68.57% (8,392 / 12,238) |       60% |

The full run includes the recovery fixture correction: a lookup error before ownership acquisition must not release capacity, while execution failure after acquisition must release it. No skipped case was added to bypass a failure.

The reproducible command is the existing `npm run test:server:coverage` using the lockfile's Vitest 4.1.12. JSON (`coverage-final.json`), LCOV (`lcov.info`), and HTML are produced in `apps/server/coverage`; the Test Suite workflow retains the directory as an artifact. The passing local run is logged at `/tmp/pr11-coverage-verified.log` in the task workspace.

Hosted check success must be verified for the final pushed commit before Jules live testing or Hugging Face publication. Local coverage, even when passing, is not evidence that those hosted checks or live integrations have run successfully.
