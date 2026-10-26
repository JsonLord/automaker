# Gate 04 — exact-head qualification and review objection trace

Start SHA: `7c6476dc94b939a60cf5da037ae7cf45e12b5ffd`. Implementation end: `ab0a8957960198e0d3d1751b860d8bc3094f7752`.
The full source command run is bound to `9626087f74b469db80064c3f3c9072d60a08273c`; canonical extraction
fixes were then covered by all 11 release tests. Final post-evidence qualification
must explicitly name its final immutable SHA in the PR handoff and final-report.json.
Do not infer final image or live deployment success from this historical gate report.

| Initial review objection                      | Source correction                                                                                                    | Actual tests/results                                                                                                                                   | Evidence                                                            | Gate                                  |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------- |
| HF context cannot prove source SHA            | export-hf-deployment.mjs, release-identity.mjs, verify-release-context.mjs, Dockerfile and workflow packaged context | 11 release identity tests pass; compiled health 200/exact source; final Docker image builds but initial runtime cannot read root-only extracted source | gate01-provenance.json; gate04-results.json; final handoff readback | Final image readback pending          |
| Overview and Argus disagree                   | project-inspection.ts, project-access.ts, overview.ts                                                                | 22 inspection/mode tests pass, including permissions, symlinks, missing state and mixed aggregate                                                      | gate02-project-access.json                                          | PASS                                  |
| Copied toy JSON test                          | http-app.ts, json-errors.ts, actual index.ts integration; obsolete copied test removed                               | 8 real pipeline/auth tests pass and 5 actual compiled startup HTTP probes pass                                                                         | gate03-json-errors.json                                             | PASS                                  |
| Missing exact-head CI/image/persistence proof | Frozen source qualification plus image/readback pipeline and operator-only plan                                      | All host checks pass at the stated code SHA after resource recovery; no hosted run IDs or live restart proof exists                                    | gate04-results.json; gate05 plan; final handoff                     | BLOCKED for hosted/live qualification |

## Actual local results

Package/server/UI builds, typecheck, formatter, server/UI lint, all 3,022 server
tests (23 existing skips), coverage thresholds, 1,004 package/UI tests, 19 release/
runtime/export diagnostic tests passed. The browser initially failed with ENOSPC,
then passed 72 tests (2 existing skips) after local build-cache recovery. Focused
totals overlap the server suite. No skips or thresholds were added/weakened.
Baseline's uploaded directive and middleware formatting were corrected without
changing the directive's requirements. Failed ENOSPC runs are retained separately;
those failures were not reported as assertion passes.

Image qualification exposed real environment/pipeline issues: writable Buildx
cache location, build-only CA trust with TLS verification retained, VFS disk
amplification, and root-only source permissions after ordinary tar extraction under
umask 077. Docker now uses frozen install, runtime prune, consolidated layers,
root-owned system directories, and a packaged context with explicit canonical
archive modes and --same-permissions extraction. The public CA is a temporary
BuildKit mount, not an image layer or a Space secret. CLI source/version pins are
preserved. No additional public port is exposed; runtime stays UID 1000/port 7860.
Initial successful image build is not promoted to IMAGE_PROVEN before health
readback on the corrected context. A new immutable final-context build follows.

## Hosted CI and source integrity

PR #22 stays open. Corrections are ordinary descendant commits on its existing
branch; there is no force push or merge. PR #19 and the human merge gate remain
unchanged. CI URLs cannot be invented: no current candidate hosted runs were
returned after synchronize; repository Actions settings access is HTTP 403.
Required workflows remain Argus Platform, PR Build Check, Format Check, Test Suite,
E2E Tests and Security Audit. Existing checks/thresholds are retained. Argus Platform
now tests the exact PR source head and the actual exported Docker context.

Tracked-file export rejects credentials/authority/runtime-state paths. A bounded
high-confidence credential pattern scan checked 1,781 tracked text files and found
zero matches; this is not a comprehensive secret-detector claim. Sanitized logs
contain test names/counts and error codes, not API keys, cookies, bodies, settings
or project contents. Source archive digest and build commands appear in the JSON
and final artifact manifest.

Acceptance: local implementation is qualified, but hosted CI, corrected final-image
readback and approved live persistent-volume restart remain independent gates.
Proceed only to Gate 05's safe operator plan; no deployment is authorized. Final
post-evidence requalification may resolve image/local status, never live authorization.
