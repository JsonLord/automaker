# Managed OpenCode execution: investigation and verification

## Root cause

The configured OpenCode provider is `automaker-compatible`; `opencode` is the Automaker transport adapter's name, and is not the identity of that endpoint.

The historical deployment path matching the supplied log is:

1. `entrypoint.sh` invokes `update_settings.py`. Before commit `323173ed`, that script wrote `MiniMax-M2.7` into phase settings and `{model: 'MiniMax-M2.7', provider: 'opencode'}` into the default feature setting. It did not preserve the OpenCode provider ID.
2. SettingsHelper only returned a different `resolvedModel` for a Claude model mapping. It did not restore the managed OpenCode provider.
3. `resolveModelString()` passed the unknown bare model through, producing the quoted ModelResolver warning.
4. AutoModeServiceFacade selected the `opencode` transport and passed `effectiveBareModel` to AgentExecutor. AgentExecutor ignored the model in the resolved SDK options. ExecutionService's direct feature path also resolved the bare model separately.
5. The historical `OpencodeProvider.buildCliArgs()` unconditionally prefixed a model without a slash with `opencode/`. `configureOpenCode()` had registered the endpoint under `automaker-compatible`, so the CLI selected a different provider.

Before:

```text
opencode run --format json --model opencode/MiniMax-M2.7
```

After:

```text
opencode run --format json --model automaker-compatible/MiniMax-M2.7
```

The starting checkout, `d07498df`, already included a partial env-based guard from `323173ed` and additional changes. With the complete compatible environment, that guard alone would correct the exact bare-model example. The supplied deployed log therefore differs from that checkout's behavior; the live deployed SHA was not available. This change fixes the shared runtime route, retains the structured identity through settings and execution, and removes dependence on that last-minute adapter guard. It does not assert that every possible remote provider error has the same cause.

## Canonical routing and configuration

`resolveOpenCodeModel()` returns `{provider, model, id}`. Managed selections and legacy generated profile IDs resolve to `automaker-compatible/<model>`. Exact legacy bare matches migrate only when the managed endpoint is configured and no explicit native provider was selected. Qualified native IDs, legacy `opencode-` IDs, and explicit native provider selections keep their native route. The managed `auto` sentinel resolves to the configured model.

SettingsHelper treats the managed endpoint as an OpenCode provider, rather than a Claude SDK profile. AgentExecutor retains the model in the resolved SDK options for its initial and continuation calls. Auto-mode and direct feature execution retain explicit native selections. Phase resolution supplies canonical identities to other configured phases, including spec generation.

Argus Manager/Planner receive separate `ARGUS_SKILL_OPENCODE_PROVIDER=automaker-compatible` and bare model fields. The pinned upstream Argus implementation qualifies those fields into the same CLI identity. Senior diagnosis/review/engineering use the shared resolver. Their JSONL output is decoded into model text before parsing the business JSON; prompts travel through stdin, collected output is bounded, and subprocess calls have an abort deadline.

Startup checks required variable presence, generated provider/model definitions, and the environment credential reference. When the CLI is available, its documented `opencode models automaker-compatible` discovery command confirms the selected model without running a coding task. Config location follows XDG configuration settings. Missing CLI or a bounded discovery timeout is reported distinctly from successful CLI discovery.

Only `{env:COMPATIBLE_API_KEY}` is serialized into OpenCode config. Python startup and TypeScript settings migration no longer copy the environment key into settings, preserve unrelated providers, and remove the formerly generated inline profile from settings and their supported backups. Output is redacted before diagnostic truncation or event persistence. Generic CLI errors retain safe provider/model/exit/session context; identifiable missing providers/models have explicit codes. Native session retries remain limited to genuine session failures.

## Runtime validation

The installed cloud CLI was OpenCode **1.18.35**. The repository's Dockerfile installs OpenCode without a version pin; the live Space's installed version was not readable here.

The committed `scripts/probe-opencode-compatible.mjs` creates an isolated local mock endpoint and config, denies tools, uses an ephemeral fixture credential, and removes its temporary files. With the same generated configuration and live mock endpoint:

- The incorrect `opencode/MiniMax-M2.7` invocation emitted an `error` event with “Unexpected server error,” exited **1**, produced no text, and made **zero requests** to the compatible endpoint.
- `automaker-compatible/MiniMax-M2.7` exited **0** and returned text. The normal AgentExecutor feature path used that exact CLI model.
- Senior diagnosis and review returned valid business JSON, and Senior engineering returned text.
- All mock HTTP requests selected `MiniMax-M2.7` and supplied the fixture authentication correctly. Credential values were not printed.

Run after the build, using an installed CLI:

```bash
OPENCODE_BIN=/workspace/.onboarding/opencode/node_modules/opencode-linux-x64/bin/opencode \
  timeout 120s node scripts/probe-opencode-compatible.mjs
```

The pinned Argus **0.1.1** source (`746f76b7a74a1217507c9ee348eecd3b782f7c92`) was installed in an isolated venv. Its real `_opencode_model()` function produced `automaker-compatible/MiniMax-M2.7` for all four role inputs and preserved `opencode/big-pickle`. The bridge tests also verify managed and native role environment routing.

**SKIPPED_ENVIRONMENT_RESTRICTION:** no compatible URL/model/key bindings are injected into this cloud machine, so no call to the real remote model endpoint was made. A read-only request to the repository's default Space URL was also unavailable from this environment; that default was not independently confirmed as the user's live target. No live Space rollout or full autonomous Argus campaign was claimed. Rebuild/redeploy the Space from the pushed commit and verify its provider discovery and a bounded normal execution there.

## Tests

All commands run from the repository root with Node 22.23.3.

| Command                                                                            | Result                                                                                                             |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `npm run build:server`                                                             | **PASS**: shared libraries and server compile                                                                      |
| `timeout 180s npm run test:unit -- --maxWorkers=4`                                 | **PASS**: 51 files, 1,002 tests; the root configuration does not discover server tests correctly                   |
| `timeout 180s npx vitest run --config apps/server/vitest.config.ts --maxWorkers=4` | 2,507 passed, 1 **PRE-EXISTING** failure, 23 skipped; 96 passed files, 1 failed file, 1 skipped file               |
| Targeted server command below                                                      | **PASS**: 9 files, 287 tests                                                                                       |
| CLI probe command above                                                            | **PASS**: incorrect route fails without endpoint requests; corrected normal feature and three Senior roles succeed |
| Real pinned Argus `_opencode_model()` check                                        | **PASS**: four managed role identities plus native identity preservation                                           |
| `git diff --check`                                                                 | **PASS**                                                                                                           |

```bash
timeout 180s npx vitest run --config apps/server/vitest.config.ts \
  apps/server/tests/unit/providers/opencode-provider.test.ts \
  apps/server/tests/unit/lib/settings-helpers.test.ts \
  apps/server/tests/unit/services/agent-executor.test.ts \
  apps/server/tests/unit/services/agent-executor-summary.test.ts \
  apps/server/tests/unit/services/opencode-managed-execution.test.ts \
  apps/server/tests/unit/services/argus.test.ts \
  apps/server/tests/unit/services/argus-upstream-contract.test.ts \
  apps/server/tests/unit/services/settings-service.test.ts \
  apps/server/tests/unit/services/notification-service.test.ts \
  --maxWorkers=4
```

The pre-existing failure is `dev-server-service.test.ts > should detect bun as package manager with bun.lockb`. Its filesystem mock makes the higher-priority pnpm lockfile appear present, so the implementation selects pnpm. This same failure was observed before edits during onboarding. The two pre-existing settings-default failures now pass because native defaults are retained outside a managed compatible deployment. **NEW REGRESSION: none observed.** Browser E2E was not run. The existing UI type errors were compared with the pre-edit baseline and remain unchanged.

## Security check

The production Express server was started locally and tested with a non-secret `.env` fixture inside the UI static directory. `/.env`, `/file=../.env`, and `/file=../../.env` each returned HTTP **200**, content type `text/html`, and bytes identical to `/`'s `index.html`. The fixture content was absent. Express static serving ignores dotfiles, and the SPA fallback explains these responses. No actual secret content was printed, committed, or included in test output. The live Space's responses remain unverified because remote access was unavailable.

## Secondary notification rename error

See [the separate issue note](issues/notification-rename-enoent.md). The current branch already has per-file serialization and UUID temporary filenames. Its 20-concurrent-write regression passes. No new notification code change was justified, and no notification-fix commit was created.

## Files changed

| File                                                                 | Purpose                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `libs/model-resolver/src/opencode.ts`                                | Shared structured OpenCode provider/model identity and legacy managed selection migration                    |
| `libs/model-resolver/src/index.ts`                                   | Export shared identity functions                                                                             |
| `libs/model-resolver/src/resolver.ts`                                | Canonical phase resolution; preserve explicit native/Claude selections                                       |
| `libs/model-resolver/tests/opencode.test.ts`                         | Managed, native, nested model, incomplete environment and phase regressions                                  |
| `libs/types/src/model.ts`                                            | Require endpoint configuration before applying the managed default                                           |
| `libs/types/src/settings.ts`                                         | Managed phase defaults when configured; preserve original defaults otherwise                                 |
| `libs/types/src/provider.ts`                                         | Optional subprocess exit-code metadata                                                                       |
| `libs/platform/src/subprocess.ts`                                    | Sanitize before diagnostic logging, bound collected output, retain exit code                                 |
| `libs/platform/tests/subprocess-diagnostics.test.ts`                 | Split-chunk secret redaction and bounded output regressions                                                  |
| `apps/server/src/lib/settings-helpers.ts`                            | Resolve managed and explicit native OpenCode selections without a Claude SDK credential profile              |
| `apps/server/src/lib/opencode-errors.ts`                             | Shared redaction, bounded diagnostics and deterministic failure codes                                        |
| `apps/server/src/providers/opencode-provider.ts`                     | Shared CLI identity, sanitized events/errors and safe session retry classification                           |
| `apps/server/src/services/agent-executor-types.ts`                   | Retain resolved SDK model in execution options                                                               |
| `apps/server/src/services/agent-executor.ts`                         | Retain selected model for initial execution and continuations                                                |
| `apps/server/src/services/auto-mode/facade.ts`                       | Preserve explicitly selected native OpenCode provider                                                        |
| `apps/server/src/services/execution-service.ts`                      | Preserve explicit native provider in direct feature execution                                                |
| `apps/server/src/services/settings-service.ts`                       | Migrate managed settings; remove generated inline credentials and sanitize backups                           |
| `apps/server/src/services/argus/opencode-config.ts`                  | Validate variables/config/model discovery, preserve credential reference and XDG location                    |
| `apps/server/src/services/argus/argus-service.ts`                    | Shared structured role routing; retain native config and required runtime/trust environment                  |
| `apps/server/src/services/argus/opencode-role-runner.ts`             | Shared model identity, JSONL text decoding, bounded stdin-based role execution and sanitized failures        |
| `apps/server/src/services/argus/project-lifecycle.ts`                | Persist/migrate canonical role model identities across restarts                                              |
| `apps/server/tests/unit/providers/opencode-provider.test.ts`         | Complete managed fixture and thrown model-not-found retry regression                                         |
| `apps/server/tests/unit/services/argus.test.ts`                      | Complete managed endpoint fixture for supervised role routing                                                |
| `apps/server/tests/unit/services/opencode-managed-execution.test.ts` | Normal/native feature, role, restart, secret safety, config and diagnostic regressions                       |
| `update_settings.py`                                                 | Persist canonical selection without credentials; preserve providers and atomically sanitize settings/backups |
| `scripts/probe-opencode-compatible.mjs`                              | Reproducible real-CLI before/after and normal-feature/Senior-role smoke test                                 |
| `docs/opencode-managed-routing-fix.md`                               | Investigation, reproduction, validation evidence and deployment limits                                       |
| `docs/issues/notification-rename-enoent.md`                          | Separate unresolved notification incident note                                                               |
