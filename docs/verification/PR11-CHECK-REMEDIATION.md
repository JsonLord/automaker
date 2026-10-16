# PR #11 check remediation

This follow-up addresses the review of the first platform implementation. The
original implementation report is historical; this document and the PR's latest
checks govern readiness. No live Jules workflow or Hugging Face publishing was run.

## Formatting

The eight reported files were formatted without semantic changes. The repository
`npm run format:check` passes. The hosted Format Check passed after that commit.

## Dirty checkout: proven cause and fix

Ten tracked logo, font and test-image assets contained ordinary binary data while
`.gitattributes` assigned Git LFS filters to those paths. GitHub's runner has LFS
installed. Its clean filter compares an LFS pointer against each ordinary binary
blob, so the checkout is dirty before npm, builds or tests execute. This sandbox
originally lacked the filter, explaining why the complete local CI sequence stayed
clean.

The failure was reproduced with real Git LFS 3.7.0: refreshing file timestamps
immediately produced binary-to-pointer diffs. All ten matching tracked files were
inspected; none contained genuine LFS pointers. Their attributes now explicitly
use `-filter -diff -merge -text`. Broad patterns for future genuine LFS assets remain.
No image/font bytes, history, or canonical branches were rewritten.

With the real filter enabled, all ten assets now remain clean and the deployment
export passes. Hosted Argus Platform validation and deployment export also passed
on the pushed LFS fix. The exporter still refuses tracked changes. Phase-specific
filename/status diagnostics and an always-run status/stat step identify any future
mutation without logging source contents or credentials. Three real Git fixture
tests validate that guard, including staged renames and unusual filenames.

## Coverage

See [the coverage investigation](PR11-COVERAGE-INVESTIGATION.md). The old scope both
included imported UI code and omitted 33 untested server modules. Correcting it
revealed a genuine coverage gap; no threshold or production exclusion was relaxed.

Meaningful regression tests found and fixed event-history cross-project leakage and
concurrent writes, test-runner lifecycle races, Git recovery parsing errors, and
Argus ownership bypasses in generic resume/verification/recovery controls. Existing
generic workflow behavior remains covered.

Final server coverage run: **2,901 passed, 23 existing skips**; statements 68.16%,
branches 58.17%, functions 77.04%, lines 68.57%. All original thresholds pass.
The additional package/UI suite passes **1,002 tests**. Coverage evidence is retained
as a CI artifact even on failure.

## Dependencies and CI consistency

See [dependency triage](PR11-DEPENDENCY-AUDIT.md) for exact versions, advisories and
compatibility evidence. Critical/high findings went from 51 to zero. Production
findings went from 16 to zero. Eight moderate package findings remain from one
upstream desktop packaging logger advisory; they are not declared resolved.

Upgrades are explicit and compatibility-tested; no `npm audit fix --force`, ignored
advisory or legacy peer override was used. The audit gate now fails at high severity.
Common CI setup and formatting checks use `npm ci --ignore-scripts`, keeping the
validated lockfile graph instead of forced re-resolution or hardcoded native-binding
versions. Invalid SSH lock URLs fail lint rather than being silently rewritten in CI.

A published Copilot SDK patch failed actual Node ESM loading despite successful
types and mocked tests. The selected fixed SDK passes eleven production entry-point
imports; CI now runs that check. A clean production-only install, native rebuild and
those same import checks pass with Electron, Vite and Vitest absent. The Dockerfile
copies this locked production dependency set and keeps the browser cache separately.
A real container build/smoke remains a separate release prerequisite.

## Release gate

Local builds, types, lint, unit tests, coverage and dependency imports are evidence
for the source change. They do not establish hosted check success, real integration
success, or approval to publish. Verify **every required check on the final pushed
PR head** before Jules live testing or HF publishing. The separate live-test and
release-checklist documents continue to apply.
