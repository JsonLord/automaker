# Argus multi-mode engineering

PR #14 extends the existing Automaker/Argus implementation. It does not replace
its bridge, OpenCode role runner/model resolver, Jules executor, CI observation,
Loki verification, review, task history or merge invariants.

## Mode contracts and capabilities

`ArgusModeAdapter` defines validate → plan → execute → evaluate. The typed registry
contains `default`, `rea`, `paper2code`, `eval`; adapters are replaceable through the
service constructor. Shared API/UI contracts live in `libs/types/src/argus-modes.ts`.
The registry exposes reviewed upstream revision/license metadata. Upstream code is
not copied, vendored, installed or represented as having run.

| Mode       | Working CPU workflow                                                                                                                                                                                                                                                   | Evidence and explicit limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default    | Existing Manager admission and Planner task proposal; explicitly approved tasks use the existing Argus/Jules lifecycle                                                                                                                                                 | Manager decision and original Planner contract are retained. Existing projects default here without migration or mode selection. No mode API activates autonomy.                                                                                                                                                                                                                                                                                                                                               |
| REA        | Authorized supplied API/web observations and explicit source files → versioned evidence → hypotheses → bounded literal experiments → report and optional task proposals                                                                                                | `rea-evidence.json`, `rea-hypotheses.json`, `rea-reproduction.md`, `rea-report.md`. A text match is evidence of a text claim, never proof of causality. Source collection is explicit and bounded, not recursive. Live network probes/native binaries need an optional isolated worker and are not silently executed.                                                                                                                                                                                          |
| Paper2Code | Supplied paper metadata/text or allowed project text document → optional configured read-only model analysis → implementation specification/tasks → approved reference generation in separate Git worktree → real unit and reproduction subprocesses → measured report | Four required report artifacts plus `reference.mjs` and `reference.test.mjs` when applicable. CPU template catalog supports sum, arithmetic mean, and a scalar linear equation. General implementation tasks go through existing Jules after explicit approval; arbitrary generated code is not run locally. DOI/arXiv references are recorded, not falsely described as retrieved documents. PDF/OCR, external datasets and other scientific workers are explicitly unavailable unless separately integrated. |
| Eval       | Versioned aligned golden datasets → exact/contains/numeric checks → optional configured OpenCode judge → candidate/model/commit comparison → current-source evaluation recommendation                                                                                  | `eval-config.json`, `eval-results.json`, `eval-comparison.md`, `eval-report.md`. Rubric/dataset hashes, versions and model identities are explicit. Baselines require identical golden data/rubric; missing/stale evidence fails closed. Scores evaluate supplied outputs; no candidate generation or external benchmark run is implied.                                                                                                                                                                       |

## Provenance and licenses

These are workflow-compatible independent Node adapters, not claims that upstream
Python packages or full upstream systems are executed:

| Reference                                  | Reviewed revision                          | Applicable license                                                             |
| ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------ |
| morluto/rea                                | `95c8f57aa2eafab4c8d7d43482b33ceefaf96b16` | MIT (`LICENSE`)                                                                |
| going-doer/Paper2Code                      | `ba9169978043d5799c8d4f4a0963e6b66a24c2e1` | Apache-2.0 (`LICENSE`)                                                         |
| Arize-ai/phoenix, `packages/phoenix-evals` | `c9a3087027fedff23c32b083534d0a16bcce1a25` | Elastic License 2.0 (`packages/phoenix-evals/LICENSE`), not assumed Apache/MIT |

Before replacing an adapter with upstream code or a Python provider, review the
pinned package's license, transitive dependencies and resource requirements. The
ELv2 package is not bundled into this application. A separately configured Phoenix
service can consume the versioned dataset/result JSON through an adapter; no such
service or credential is required by the default CPU paths.

## Durable state, concurrency and recovery

Project-scoped `.automaker/modes/state.json` uses the existing metadata symlink
checks, cooperating-process lock, unique temporary files, fsync and atomic rename.
Mode/config revisions, immutable run snapshots, tasks, artifacts/hashes and evidence
events persist together. Configuration/selection history is retained. There is no
silent pruning: 200 runs or 1,000 configuration transitions require explicit
archival rather than overwriting history. Inputs are limited to 128 KiB, selected
source files to 16 KiB and each artifact to 256 KiB.

A project execution fence coordinates mode changes/runs/task admission with the
existing autonomy runner. At most one mode execution occurs per project. Selecting
or reconfiguring a mode is blocked while a durable run or an incompatible active
engineering task remains. Queued same-process transitions wait for the execution
fence. Cross-process contention fails closed using the existing short lock wait.
The registry never grants an autonomy permission; capabilities, repository-change
permission and model-call permission are independent and default off.

Run ownership/deadlines are persisted before effects. Read-only model work has a
three-minute cancellation signal and subprocess deadline; CPU reference subprocesses
have five-second deadlines/output bounds. Unfinished durable runs become
`interrupted` after their ten-minute recovery deadline, preserving effects/intent
for inspection and never replaying execution automatically. Paper worktree intent
(branch and exact source SHA) is written before creation. A crash-left durable lock
requires the existing operator recovery procedure: establish that all owners are
stopped before removing the specific stale lock. Never reset a project to hide
partial effects. Malformed authoritative state fails closed; an unknown mode ID
falls back to Default without starting anything.

## Engineering admission and merge safety

Plan creation is idempotent by project/key/input/configuration snapshot; conflicting
reuse is rejected. Task admission requires an explicit per-task approval, an exact
matching current source SHA, the run's repository-change and model-call permissions, and existing
Argus autonomy already enabled independently. Deterministic task IDs recover an
admission interrupted between Argus-state and mode-state writes. Mode-generated
cards are protected from generic auto-mode execution by existing Argus ownership.

Existing executor, PR, CI, Loki and exact reviewed-head gates remain intact.
Mode-generated tasks additionally require a human merge: the merge orchestrator
stops before acquiring a merge lease or submitting a merge. Mode selection cannot
start a campaign, replace a task or permit a merge. Existing untagged Default
workflows retain their existing contracts.

`GET /mode/gate` is a release recommendation only. It requires the latest completed
Eval on the current committed source, a clean tracked tree, and the current
configuration revision. A failing run supersedes an earlier passing run. LLM scores
are advisory unless `evaluation.requireJudge` explicitly makes the configured judge
part of the rubric. `authorizesMerge` is always false. CI/review/Loki invariants are
never replaced by a model score.

## Isolation and deployment assumptions

All mode endpoints use existing API authentication and registered physical project
roots. Runs are looked up only inside that root. Evidence readers deny traversal,
hidden metadata/credentials, symlinks, binary files and unbounded reads. Documents
are data; no document field is evaluated as code, a shell command or a path to an
arbitrary worker. UI artifacts render as escaped text.

Read-only OpenCode roles receive a read-only temporary directory, deny-all-tools
configuration and an explicit environment allowlist (configured model credential,
proxy/CA/config selectors). The subprocess API's explicit `inheritEnv: false`
prevents unrelated deployment/GitHub/Jules credentials from being inherited.
Default subprocess behavior stays compatible. Output is redacted before persistence.
Reference programs execute only closed, trusted numeric templates with validated
numeric inputs, no inherited credentials, no shell, Node permission mode and bounded
runtime/output. This is not a sandbox for arbitrary model-generated JavaScript.

Target baseline: Linux x64, Node 22, Python only for the already existing Argus
bridge, two CPU cores and ordinary HF CPU memory (no GPU). Modes add no permanent
worker processes. Idle mode choice runs no model and schedules no research work.
Persist projects and `.automaker` on the configured `/data` volume; an ephemeral
HF filesystem is not durable across rebuilds. Worktrees need additional disk space.
External scientific/binary/PDF/Phoenix workers are optional and are not installed
into the base Docker image. A real production model/Jules qualification and full
image/runtime qualification remain required before enabling those integrations.

No HF Space content is cleared. Forty zeroes are unknown build provenance:
`gitSha: null`, `sourceIdentity: unknown`; startup remains usable. Release builds
must supply and verify a real nonzero source SHA.
