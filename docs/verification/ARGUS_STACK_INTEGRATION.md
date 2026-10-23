# Argus stacked integration qualification

Verdict: **NO_GO — BLOCKERS_REMAIN**. Source checks are qualified locally; hosted
qualification is blocked. No merge, deployment or live Twenty import is authorized.

Corrective PR: [#20](https://github.com/JsonLord/automaker/pull/20), stacked above
unchanged qualified PR #19 `8298262e39b9b30da1fbb5006220cdd96d8b4625`.
Source and integration source HEAD: `0380b0856fe1629c4691b3777b16ab82abce6238`. Final publication adds only the
four evidence documents. The exact published evidence commit is recorded in the
PR's final validation report; resolve it with `gh pr view 20 --json headRefOid`.

## History and isolated application

Deployment-base ancestry begins at default branch main `d37ced1c6ee44f721fc80930dfb5baefd7871dde`. Both main and
hyp-import report `protected: false`; there is no verified protected target in this
chain. Do not assume PR #19 targets main directly. The actual chain is:

| Stage | Ref                                                                      | SHA                                        |
| ----- | ------------------------------------------------------------------------ | ------------------------------------------ |
| 1     | `origin/hyp-import`                                                      | `3d42133228f9e1aa9457e194d2d4f81d47b94a7c` |
| 2     | `origin/opencode-cli-branch-fix-9526433256615186185`                     | `93254caa307a17b4628e80d5db10615370f7a29b` |
| 3     | `origin/codex/implement-milestones-a-and-b-for-argus-integration-srcft2` | `805b58a7e60c40427c64cb8d3961d8762b6125d5` |
| 4     | `origin/jules-18096047565811501902-99295020`                             | `f98128a0ac987f406c4c758f8addcea5362a6704` |
| 5     | `origin/jules-15487492702961846755-04f6dea7`                             | `a828c94f7fae4b285fff8cd038761842cf50d7ae` |
| 6     | `origin/jules-14354056622111766374-42608c2c`                             | `bbe8bad2fe29654180335faef26bc78b37c8f7b3` |
| 7     | `origin/feat/argus-continuous-engineering`                               | `4b436f65908d18e95e961c4bb9f5895736fc5a38` |
| 8     | `origin/fix/argus-deployment-issues-6139855128935737352`                 | `970b7865418685d2118277add3f2ab4f1b039fd9` |
| 9     | `origin/fix/hf-deployment-agent-md-and-build-3606839938468972213`        | `96663b93d2291223f9d009339f85b0659a3464a6` |
| 10    | `origin/jules-3194247390098501588-e30c27d9`                              | `c138087ebd17d7f4cef51e2b0111e834fcba11c8` |
| 11    | `origin/fix/argus-import-registration-15005198251122228267`              | `c45fa6f1c77a02a0c8f6a51b1e84cb508c0f8dc5` |
| 12    | `origin/pr-18-safety-16786589082987059652`                               | `8298262e39b9b30da1fbb5006220cdd96d8b4625` |
| 13    | `fix/argus-human-merge-gate`                                             | `0380b0856fe1629c4691b3777b16ab82abce6238` |

The dedicated `/workspace/automaker-integration` worktree started from main and
fast-forwarded those refs in order after checking ancestry for each stage.
No local merge commit, cherry-pick duplication, conflict or conflict resolution
was necessary. PR #15's existing merge `96663b93` is already in PR #14 ancestry and
was retained once. No unrelated branch heads were applied: PRs #1, #2, #4, #5, #6,
#12 and #16 were excluded as additional inputs. Changes already inherited from an
audited ancestor were preserved, rather than falsely claiming they were removed.

Reproduce the graph and complete binary diff without relying on this summary:

```sh
git log --graph --oneline d37ced1c6ee44f721fc80930dfb5baefd7871dde..0380b0856fe1629c4691b3777b16ab82abce6238
git diff --binary d37ced1c6ee44f721fc80930dfb5baefd7871dde 0380b0856fe1629c4691b3777b16ab82abce6238
git diff --name-status 8298262e39b9b30da1fbb5006220cdd96d8b4625 0380b0856fe1629c4691b3777b16ab82abce6238
```

The source rollback reference is main `d37ced1c6ee44f721fc80930dfb5baefd7871dde`; it is a Git ancestry reference,
not a certified HF rollback image. No deployment occurred. The observed HF revision
and state-preserving rollback prerequisites are in TWENTY_IMPORT_SMOKE.md.

## Local validation

The isolated candidate uses Node 22.23.3, frozen `npm ci --ignore-scripts`, supported
node-pty rebuild, and the repository's real commands. Qualification covers package
build, server build, UI build, typecheck, format:check, server/UI lint, server tests
and coverage, package/UI unit tests, combined Argus integration, provenance/export
checks, and the full browser suite. No thresholds, approvals or tests were bypassed.
Final exact-commit commands/results are preserved in the PR validation manifest.

Totals: 3,003 server tests passed / 23 existing skips; 1,004 package/UI tests passed;
155 focused integration tests passed; 11 provenance/export diagnostic tests passed;
72 browser tests passed / 2 existing skips. Focused totals overlap the server suite
and are not additional unique tests. The first complete integration snapshot
`fdaf115877a964bae6337c438a82c58a119c3db7` passed 3,001 server tests and 153 focused
tests; the final source adds two crash recovery cases and an executor prompt assertion.

Combined coverage includes real checkout metadata, unauthorized imports and
traversal, no-clobber separate-process/crash tests for all controls, no fabricated
spec/task, paused planning imports, native identity and failure recovery, mode
permission boundaries, paused restart, authorized existing controls, human-merge
waiting and recovery, and the complete mocked Jules/Loki/Senior pipeline. The
runtime bridge and Jules/model transports are deterministic fixtures, not paid calls.

## Hosted workflow gate: blocked

All six required conclusions for the final candidate are **NOT_RUN**:

| Workflow       | Conclusion                 |
| -------------- | -------------------------- |
| Argus Platform | NOT_RUN — Actions disabled |
| PR Build Check | NOT_RUN — Actions disabled |
| Format Check   | NOT_RUN — Actions disabled |
| Test Suite     | NOT_RUN — Actions disabled |
| E2E Tests      | NOT_RUN — Actions disabled |
| Security Audit | NOT_RUN — Actions disabled |

No candidate check-run URL exists. See [PR checks](https://github.com/JsonLord/automaker/pull/20/checks)
and [repository Actions](https://github.com/JsonLord/automaker/actions).
GitHub's supported workflow dispatch returned HTTP 422, **Actions has been disabled
for this repository**. Settings inspection returned HTTP 403, **Resource not
accessible by integration**. Source pushes/PR publication succeed; these do not
establish Actions authorization. Earlier PR #19 successes are not reused as proof
for the new candidate. Hosted Docker/provenance qualification remains missing.
Maintainer recovery: enable repository Actions through authorized settings, then
trigger the existing PR workflows on the exact published HEAD and require all six
successes before reconsidering STACK_INTEGRATION.

## Corrective source/test inventory

- `apps/server/src/services/argus/autonomy-runner.ts`
- `apps/server/src/services/argus/git-integration-service.ts`
- `apps/server/src/services/argus/github-ci-observer.ts`
- `apps/server/src/services/argus/jules-executor.ts`
- `apps/server/src/services/argus/milestone-e-orchestrator.ts`
- `apps/server/src/services/argus/types.ts`
- `apps/server/tests/unit/services/argus-modes.integration.test.ts`
- `apps/server/tests/unit/services/autonomy-runner.test.ts`
- `apps/server/tests/unit/services/jules-executor.test.ts`
- `apps/server/tests/unit/services/milestone-e.test.ts`
- `apps/server/tests/unit/services/platform-pipeline.test.ts`
- `docs/verification/ARGUS_HUMAN_MERGE_GATE.md`

The final evidence-only follow-up also includes ARGUS_STACK_INTEGRATION.md,
TWENTY_IMPORT_SMOKE.md and ARGUS_RELEASE_GATE.json. No dependency, Dockerfile,
workflow, registry, mode authorization or production configuration changes were
introduced by this corrective PR.

## Full inherited integration file inventory (295 source files)

- `.dockerignore`
- `.gitattributes`
- `.github/actions/setup-project/action.yml`
- `.github/workflows/argus-platform.yml`
- `.github/workflows/e2e-tests.yml`
- `.github/workflows/format-check.yml`
- `.github/workflows/pr-check.yml`
- `.github/workflows/security-audit.yml`
- `.github/workflows/test.yml`
- `.hfignore`
- `.husky/pre-commit`
- `Agent.md`
- `Dockerfile`
- `README.md`
- `apps/server/eslint.config.mjs`
- `apps/server/package.json`
- `apps/server/scripts/check-runtime-dependencies.mjs`
- `apps/server/src/api-docs.ts`
- `apps/server/src/index.ts`
- `apps/server/src/lib/auth.ts`
- `apps/server/src/lib/build-identity.ts`
- `apps/server/src/lib/opencode-errors.ts`
- `apps/server/src/lib/settings-helpers.ts`
- `apps/server/src/providers/opencode-provider.ts`
- `apps/server/src/providers/provider-factory.ts`
- `apps/server/src/routes/agent/index.ts`
- `apps/server/src/routes/app-spec/generate-spec.ts`
- `apps/server/src/routes/argus/index.ts`
- `apps/server/src/routes/argus/modes.ts`
- `apps/server/src/routes/auth/index.ts`
- `apps/server/src/routes/features/index.ts`
- `apps/server/src/routes/git/routes/details.ts`
- `apps/server/src/routes/git/routes/enhanced-status.ts`
- `apps/server/src/routes/health/index.ts`
- `apps/server/src/routes/health/routes/index.ts`
- `apps/server/src/routes/health/routes/run-tests.ts`
- `apps/server/src/routes/projects/index.ts`
- `apps/server/src/routes/projects/routes/import-github.ts`
- `apps/server/src/routes/settings/index.ts`
- `apps/server/src/routes/settings/routes/diagnostics-opencode.ts`
- `apps/server/src/routes/setup/routes/opencode-status.ts`
- `apps/server/src/routes/templates/index.ts`
- `apps/server/src/routes/templates/routes/clone.ts`
- `apps/server/src/services/agent-executor-types.ts`
- `apps/server/src/services/agent-executor.ts`
- `apps/server/src/services/argus/argus-service.ts`
- `apps/server/src/services/argus/autonomy-runner.ts`
- `apps/server/src/services/argus/autonomy-runtime.ts`
- `apps/server/src/services/argus/board-projector.ts`
- `apps/server/src/services/argus/campaigns.ts`
- `apps/server/src/services/argus/durable-store.ts`
- `apps/server/src/services/argus/engineering-experiments.ts`
- `apps/server/src/services/argus/engineering-scout.ts`
- `apps/server/src/services/argus/environment.ts`
- `apps/server/src/services/argus/git-context.ts`
- `apps/server/src/services/argus/git-integration-service.ts`
- `apps/server/src/services/argus/github-ci-observer.ts`
- `apps/server/src/services/argus/index.ts`
- `apps/server/src/services/argus/infrastructure.ts`
- `apps/server/src/services/argus/jules-client.ts`
- `apps/server/src/services/argus/jules-executor.ts`
- `apps/server/src/services/argus/merge-coordinator.ts`
- `apps/server/src/services/argus/milestone-d-orchestrator.ts`
- `apps/server/src/services/argus/milestone-e-orchestrator.ts`
- `apps/server/src/services/argus/modes/contracts.ts`
- `apps/server/src/services/argus/modes/control.ts`
- `apps/server/src/services/argus/modes/default.ts`
- `apps/server/src/services/argus/modes/eval.ts`
- `apps/server/src/services/argus/modes/evidence.ts`
- `apps/server/src/services/argus/modes/paper2code.ts`
- `apps/server/src/services/argus/modes/rea.ts`
- `apps/server/src/services/argus/modes/registry.ts`
- `apps/server/src/services/argus/modes/service.ts`
- `apps/server/src/services/argus/modes/upstreams.ts`
- `apps/server/src/services/argus/opencode-config.ts`
- `apps/server/src/services/argus/opencode-role-runner.ts`
- `apps/server/src/services/argus/orchestrator.ts`
- `apps/server/src/services/argus/project-access.ts`
- `apps/server/src/services/argus/project-lifecycle.ts`
- `apps/server/src/services/argus/runtime.ts`
- `apps/server/src/services/argus/senior-worktree.ts`
- `apps/server/src/services/argus/spec-renewal-service.ts`
- `apps/server/src/services/argus/startup.ts`
- `apps/server/src/services/argus/task-history.ts`
- `apps/server/src/services/argus/types.ts`
- `apps/server/src/services/argus/upstream-contract.ts`
- `apps/server/src/services/argus/verification.ts`
- `apps/server/src/services/argus/worker-waves.ts`
- `apps/server/src/services/auto-mode/compat.ts`
- `apps/server/src/services/auto-mode/facade.ts`
- `apps/server/src/services/bootstrap-starter-project.ts`
- `apps/server/src/services/dev-server-service.ts`
- `apps/server/src/services/event-history-service.ts`
- `apps/server/src/services/execution-service.ts`
- `apps/server/src/services/feature-state-manager.ts`
- `apps/server/src/services/notification-service.ts`
- `apps/server/src/services/pull-service.ts`
- `apps/server/src/services/recovery-service.ts`
- `apps/server/src/services/settings-service.ts`
- `apps/server/src/services/stash-service.ts`
- `apps/server/src/services/test-runner-service.ts`
- `apps/server/src/tests/bootstrap-starter-project.test.ts`
- `apps/server/tests/unit/api-docs.test.ts`
- `apps/server/tests/unit/argus-controls.test.ts`
- `apps/server/tests/unit/auth.test.ts`
- `apps/server/tests/unit/lib/agent-discovery.test.ts`
- `apps/server/tests/unit/lib/auth-utils.test.ts`
- `apps/server/tests/unit/lib/auth.test.ts`
- `apps/server/tests/unit/lib/build-identity.test.ts`
- `apps/server/tests/unit/lib/provider-error-handler.test.ts`
- `apps/server/tests/unit/providers/codex-tool-mapping.test.ts`
- `apps/server/tests/unit/providers/opencode-provider.test.ts`
- `apps/server/tests/unit/providers/provider-factory.test.ts`
- `apps/server/tests/unit/routes/opencode-status.test.ts`
- `apps/server/tests/unit/routes/projects/import-github.test.ts`
- `apps/server/tests/unit/routes/settings/diagnostics-opencode.test.ts`
- `apps/server/tests/unit/services/argus-board.test.ts`
- `apps/server/tests/unit/services/argus-exclusive-files.test.ts`
- `apps/server/tests/unit/services/argus-modes.integration.test.ts`
- `apps/server/tests/unit/services/argus-upstream-contract.test.ts`
- `apps/server/tests/unit/services/argus.test.ts`
- `apps/server/tests/unit/services/auto-mode/lifecycle.integration.test.ts`
- `apps/server/tests/unit/services/autonomy-runner.test.ts`
- `apps/server/tests/unit/services/bootstrap-foundation.test.ts`
- `apps/server/tests/unit/services/campaigns.test.ts`
- `apps/server/tests/unit/services/dev-server-service.test.ts`
- `apps/server/tests/unit/services/engineering-discovery.test.ts`
- `apps/server/tests/unit/services/event-history-service.test.ts`
- `apps/server/tests/unit/services/git-dispatch-context.test.ts`
- `apps/server/tests/unit/services/git-workflows.integration.test.ts`
- `apps/server/tests/unit/services/jules-executor.test.ts`
- `apps/server/tests/unit/services/loki-verifier.test.ts`
- `apps/server/tests/unit/services/merge-coordinator.test.ts`
- `apps/server/tests/unit/services/milestone-d.test.ts`
- `apps/server/tests/unit/services/milestone-e.test.ts`
- `apps/server/tests/unit/services/notification-service.test.ts`
- `apps/server/tests/unit/services/opencode-managed-execution.test.ts`
- `apps/server/tests/unit/services/platform-pipeline.test.ts`
- `apps/server/tests/unit/services/pr-review-comments.service.test.ts`
- `apps/server/tests/unit/services/pull-service.integration.test.ts`
- `apps/server/tests/unit/services/pull-service.test.ts`
- `apps/server/tests/unit/services/recovery-service.test.ts`
- `apps/server/tests/unit/services/stash-service.test.ts`
- `apps/server/tests/unit/services/test-runner-service.test.ts`
- `apps/server/tests/unit/services/worker-infrastructure.test.ts`
- `apps/server/vitest.config.ts`
- `apps/ui/package.json`
- `apps/ui/public/sw.js`
- `apps/ui/scripts/bump-version.mjs`
- `apps/ui/scripts/prepare-server.mjs`
- `apps/ui/scripts/rebuild-server-natives.cjs`
- `apps/ui/scripts/update-version.mjs`
- `apps/ui/src/components/ui/app-error-boundary.tsx`
- `apps/ui/src/components/views/agent-view.tsx`
- `apps/ui/src/components/views/board-view.tsx`
- `apps/ui/src/components/views/board-view/argus-campaign-panel.tsx`
- `apps/ui/src/components/views/board-view/argus-mode-panel.tsx`
- `apps/ui/src/components/views/board-view/components/kanban-card/argus-task-evidence.tsx`
- `apps/ui/src/components/views/board-view/components/kanban-card/kanban-card.tsx`
- `apps/ui/src/components/views/settings-view/cli-status/opencode-cli-status.tsx`
- `apps/ui/src/components/views/settings-view/shared/types.ts`
- `apps/ui/src/components/views/setup-view/steps/opencode-setup-step.tsx`
- `apps/ui/src/components/views/terminal-view/terminal-panel.tsx`
- `apps/ui/src/lib/electron.ts`
- `apps/ui/src/lib/http-api-client.ts`
- `apps/ui/src/renderer.tsx`
- `apps/ui/src/store/setup-store.ts`
- `apps/ui/src/store/types/project-types.ts`
- `apps/ui/tests/unit/argus/mode-panel.test.tsx`
- `diag_logs.txt`
- `docker-entrypoint.sh`
- `docs/api/ARGUS-MODES.md`
- `docs/architecture/ARGUS-CONTINUOUS-ENGINEERING.md`
- `docs/architecture/ARGUS-MULTI-MODE.md`
- `docs/architecture/decisions/001-argus-authority-and-workers.md`
- `docs/deployment/HF-RELEASE-CHECKLIST.md`
- `docs/issues/notification-rename-enoent.md`
- `docs/opencode-managed-routing-fix.md`
- `docs/ui/ARGUS-MODES.md`
- `docs/verification/ARGUS_HUMAN_MERGE_GATE.md`
- `docs/verification/CLOUD-IMPLEMENTATION-RESULTS.md`
- `docs/verification/HF-RUNTIME-BASELINE.json`
- `docs/verification/HF-RUNTIME-BASELINE.md`
- `docs/verification/IMPLEMENTATION-PR.md`
- `docs/verification/JULES-LIVE-TEST-PLAN.md`
- `docs/verification/PR11-CHECK-REMEDIATION.md`
- `docs/verification/PR11-COVERAGE-INVESTIGATION.md`
- `docs/verification/PR11-DEPENDENCY-AUDIT.md`
- `docs/verification/PR14-DEPLOYMENT-BLOCKERS.md`
- `docs/verification/PR14-MULTI-MODE-IMPLEMENTATION.md`
- `docs/verification/PREDEPLOY-QUALIFICATION.md`
- `docs/verification/TWENTY-EFFICIENCY-FINDINGS.md`
- `docs/verification/TWENTY-LIVE-ARGUS-REPORT.md`
- `docs/verification/TWENTY-LIVE-ARGUS-TRACE.jsonl`
- `entrypoint.sh`
- `libs/dependency-resolver/package.json`
- `libs/git-utils/package.json`
- `libs/model-resolver/package.json`
- `libs/model-resolver/src/index.ts`
- `libs/model-resolver/src/opencode.ts`
- `libs/model-resolver/src/resolver.ts`
- `libs/model-resolver/tests/opencode.test.ts`
- `libs/platform/package.json`
- `libs/platform/src/subprocess.ts`
- `libs/platform/src/system-paths.ts`
- `libs/platform/tests/subprocess-diagnostics.test.ts`
- `libs/prompts/package.json`
- `libs/spec-parser/package.json`
- `libs/types/package.json`
- `libs/types/src/argus-modes.ts`
- `libs/types/src/feature.ts`
- `libs/types/src/index.ts`
- `libs/types/src/model.ts`
- `libs/types/src/provider.ts`
- `libs/types/src/settings.ts`
- `libs/utils/package.json`
- `package-lock.json`
- `package.json`
- `requirements.txt`
- `result.txt`
- `run_logs.txt`
- `run_logs_all.txt`
- `run_logs_final.txt`
- `run_logs_final_2.txt`
- `run_logs_final_3.txt`
- `run_logs_final_4.txt`
- `run_logs_final_5.txt`
- `run_logs_final_6.txt`
- `run_logs_full.txt`
- `run_ui.py`
- `scripts/argus_runtime_bridge.py`
- `scripts/check-clean-working-tree.mjs`
- `scripts/export-hf-deployment.mjs`
- `scripts/fix-lockfile-urls.mjs`
- `scripts/generate-provenance.sh`
- `scripts/get-claude-token.sh`
- `scripts/get-cursor-token.sh`
- `scripts/probe-opencode-compatible.mjs`
- `scripts/test-hf-runtime.mjs`
- `scripts/test-opencode-inference.mjs`
- `scripts/tests/build-provenance.test.mjs`
- `scripts/tests/check-clean-working-tree.test.mjs`
- `scripts/tests/test-hf-runtime.test.mjs`
- `scripts/verify_argus_contract.py`
- `spec.md`
- `src/__init__.py`
- `src/__pycache__/__init__.cpython-312.pyc`
- `src/__pycache__/main.cpython-312.pyc`
- `src/agents/__init__.py`
- `src/agents/__pycache__/__init__.cpython-312.pyc`
- `src/agents/__pycache__/agent_factory.cpython-312.pyc`
- `src/agents/__pycache__/base_agent.cpython-312.pyc`
- `src/agents/__pycache__/evolution_agent.cpython-312.pyc`
- `src/agents/__pycache__/generation_agent.cpython-312.pyc`
- `src/agents/__pycache__/meta_review_agent.cpython-312.pyc`
- `src/agents/__pycache__/proximity_agent.cpython-312.pyc`
- `src/agents/__pycache__/ranking_agent.cpython-312.pyc`
- `src/agents/__pycache__/reflection_agent.cpython-312.pyc`
- `src/agents/__pycache__/supervisor_agent.cpython-312.pyc`
- `src/agents/agent_factory.py`
- `src/agents/base_agent.py`
- `src/agents/evolution_agent.py`
- `src/agents/generation_agent.py`
- `src/agents/meta_review_agent.py`
- `src/agents/proximity_agent.py`
- `src/agents/ranking_agent.py`
- `src/agents/reflection_agent.py`
- `src/agents/supervisor_agent.py`
- `src/config/__init__.py`
- `src/config/__pycache__/__init__.cpython-312.pyc`
- `src/config/__pycache__/config.cpython-312.pyc`
- `src/config/config.py`
- `src/main.py`
- `src/tools/__init__.py`
- `src/tools/__pycache__/__init__.cpython-312.pyc`
- `src/tools/__pycache__/base_tool.cpython-312.pyc`
- `src/tools/__pycache__/citation_tool.cpython-312.pyc`
- `src/tools/__pycache__/reasoning_tool.cpython-312.pyc`
- `src/tools/__pycache__/search_tool.cpython-312.pyc`
- `src/tools/base_tool.py`
- `src/tools/citation_tool.py`
- `src/tools/reasoning_tool.py`
- `src/tools/search_tool.py`
- `src/ui/__init__.py`
- `src/ui/streamlit_app.py`
- `src/utils/__init__.py`
- `src/utils/__pycache__/__init__.cpython-312.pyc`
- `src/utils/__pycache__/exceptions.cpython-312.pyc`
- `src/utils/__pycache__/logger.cpython-312.pyc`
- `src/utils/__pycache__/validators.cpython-312.pyc`
- `src/utils/exceptions.py`
- `src/utils/logger.py`
- `src/utils/validators.py`
- `start_ui.bat`
- `update_settings.py`
