# Automaker PR #22 — Corrective Pass and Qualification Directive

You are the implementation and verification agent for JsonLord/automaker PR #22:
https://github.com/JsonLord/automaker/pull/22

Review baseline (revalidate at start): head 8480c1fcff60688da8b5a0a7444b9692f4b38f1d, PR head branch hf-deployment-verification-12316696031661565486, target fix/argus-human-merge-gate. The last review verdict was REQUEST CHANGES / NO-GO DEPLOYMENT.

## Mission

Resolve the four exact review findings: (1) the SHA provenance path is not proven to work in the actual HF Docker build context; (2) the project overview uses fs.access() while Argus uses physical realpath/allowed-root resolution, creating inconsistent health classification; (3) JSON parse tests copy a handler into a toy Express app instead of testing the actual Automaker pipeline; (4) there is no exact-head CI, real-image readback, or persistent-volume restart evidence. Keep the scope bounded. Do not redesign Argus or expand autonomy.

## Authority and non-negotiable restrictions

- Authorized: inspect source, create isolated worktree, implement fixes, write tests/docs, run local tests/builds, commit and push the existing PR development branch safely (non-force) after checking current ref and worktree ownership.
- Not authorized: merge PR, deploy or restart Hugging Face Space, attach or change volumes, change secrets, enable Argus autonomy, dispatch Jules sessions, run paid inference, create actual GitHub merges, alter production registered projects, delete directories, or overwrite production data.
- No additional public ports. Retain port 7860 and authentication behavior. Do not copy secrets, actual credentials, project content, or unredacted settings into evidence or Git.
- If a required approval, storage recovery, or access step is blocked, STOP that step, mark it BLOCKED, and finish safe implementation/reporting. Do not invent success.
- Preserve the human merge gate. Never change ARGUS_AUTOMATIC_MERGE=FORBIDDEN semantics.

## GATE 00 — Source and evidence freeze

1. Fetch live PR #22 metadata, base SHA, head SHA, changed files, linked CI status, and unresolved reviews. Confirm HEAD versus the baseline above; if changed, inspect every new diff before editing.
2. Inspect and map Dockerfile, .dockerignore, scripts/export-hf-deployment.mjs, scripts/generate-provenance.sh, build-identity.ts, entrypoint.sh, apps/server/src/index.ts, routes/projects/routes/overview.ts, and services/argus/project-access.ts.
3. Confirm the exact build context that Hugging Face receives. The export script currently writes a provenance sidecar outside its git archive; .dockerignore excludes .git; Docker ARG BUILD_GIT_SHA is optional; the root fallback file is not tracked. Explain which production route supplies each source of identity.
4. Record baseline tests without triggering production writes. Store branch/SHA, commands, exit codes, logs and redacted evidence.
5. Produce docs/verification/hf-recovery/gate00-inventory.md. Do not claim the current runtime storage cause is proven solely by a missing project path; distinguish observed API failure, known HF ephemeral-storage behavior, and actual mount evidence.

## GATE 01 — Verifiable, deployable provenance

Design and implement one source-of-truth release identity contract:

- Each release records the **GitHub source commit** and, separately when available, the **Hugging Face Space revision**. Do not conflate them.
- A production image must contain a valid, exact 40-character source SHA and build timestamp, grounded in the reviewed source commit, rather than an arbitrary valid-looking SHA.
- Make this work for the real HF deployment input. If using an in-context generated manifest, generate it deterministically from the reviewed Git commit at packaging/export time and include it in the actual Docker context. No stale tracked manifest, unattached sidecar, or accidental dependency on .git.
- Alternatively, provide a verified CI-to-HF build-argument flow that supplies and checks BUILD_GIT_SHA for **each** revision; a manually configured static Space variable that can go stale is insufficient.
- If supporting both git-archive packaging and direct Hugging Face Git-based builds, explicitly implement and test both. If one is unsupported, document the supported deployment route and fail closed.
- Ensure the manifest survives multi-stage compilation and is read by /api/health. Avoid leaking secrets.

Mandatory tests:

1. Valid reviewed SHA -> Docker build succeeds, final image returns that exact SHA.
2. No .git and no SHA/manifest -> controlled build failure (intended).
3. Malformed/zero SHA -> failure.
4. Wrong or stale SHA/manifest -> rejected, not merely accepted because it is 40 hex characters.
5. Clean git-archive source -> reproducible provenance packaging.
6. Run server build plus actual compiled runtime readback, not only generator unit tests.

Give concrete archive digest, build command, image identifier if available, source SHA and HTTP response. If Docker or registry network is blocked, report NOT_PROVEN; do not fabricate a passed image test.

Output: gate01-provenance.md and gate01-provenance.json.

## GATE 02 — Shared project filesystem truth

Current overview uses fs.access(projectRef.path), while the Argus guard uses fs.realpath, registration lookup, ALLOWED_ROOT_DIRECTORY, and symlink rules. Implement a reusable **read-only** inspection primitive or common validation layer that keeps these semantics aligned without weakening the authorization guard.

Requirements:

- Distinguish missing path, denied path, inaccessible parent, non-directory, broken symlink, outside-allowed-root, and forbidden metadata symlink where applicable.
- Overview must mark unavailable registered projects clearly with a machine-readable reason; do not call them healthy or idle.
- Missing/unreadable feature state must be marked unknown/incomplete, not asserted to contain zero real work. Preserve API compatibility where practical.
- Argus protected routes must still enforce registered ownership, physical-root checks, and rejection of cross-project access.
- Do not automatically create missing project directories or remove stale registrations.
- Avoid leaking sensitive absolute paths in unauthenticated responses or raw errors.
- Make the aggregate dashboard accurately count unavailable/error projects.

Test against temporary fixtures: valid registered root, missing directory, unreadable directory, path replaced by a file, broken symlink, symlink escaping root, valid nested path, forbidden .automaker symlink, stale registration, two projects with mixed health, and non-regression of Argus authorization.

Output: gate02-project-access.md with fixture results and API matrix.

## GATE 03 — Test the real malformed-JSON middleware

Move the error middleware into a named, reusable module and register it in the actual server. Never duplicate implementation code inside tests.

Use the real application assembly or a production-equivalent exported app factory with Supertest. Verify:

- Invalid JSON to POST /api/auth/login produces HTTP 400, JSON MIME, stable MALFORMED_JSON code and no stack/file path.
- Valid JSON still reaches its route.
- Unsupported content types are rejected according to current API policy.
- Authentication 401/403 behavior remains unchanged.
- Existing non-JSON errors do not get falsely rewritten to MALFORMED_JSON.
- Parser errors stay bounded and do not leak request bodies or secrets.

Test production-style compiled startup or a realistic integration fixture; toy Express-only tests are insufficient.

Output: gate03-json-errors.md.

## GATE 04 — Full exact-head qualification

Run at minimum:

- npm run build:packages
- npm run build --workspace=apps/server
- relevant server unit/integration tests, including all new tests
- lint/typecheck checks used by the repository
- release/export reproducibility checks and secret scan
- production-style Docker build and /api/health readback, if available

Capture counts, warnings, failures and exact command exit codes. Link real GitHub Actions workflow run URL, exact tested head SHA, job conclusion and artifacts. A workflow file existing is not proof of a successful hosted run.

Deliver a traceable table for every initial review objection: source link, test, actual result, evidence filename, PASS/FAIL/BLOCKED/NOT_PROVEN.

Output: gate04-qualification.md, gate04-results.json, sanitized logs.

## GATE 05 — Storage deployment plan only, no production mutation

Write an operator-ready Hugging Face volume migration and smoke-test plan:

- Select the explicit persistent mount strategy (/app/data or /data with full configuration), supported by current HF documentation.
- Align DATA_DIR, ARGUS_SKILL_HOME and ALLOWED_ROOT_DIRECTORY; validate UID 1000 read/write and atomic-file behavior.
- Inventory/back up live settings, project records, .automaker state, Git repositories, campaigns and recovery references before any rebuild.
- Define how to handle the lost twenty-argus-live-20261020 registration **without inventing a replacement project or falsifying history**; require human approval for retirement or re-registration.
- Specify freeze/drain, rollback and recovery if the mount or schema is unreadable.
- Define an approved **disposable** project test: register -> verify all four mode APIs -> restart -> verify unchanged project identity, Git history and persisted Argus state -> clean up only with permission.
- Require live SHA readback matching the exact built source, auth regression, and no unapproved autonomy before promotion.

No HF Space writes or restarts in this gate. Output: gate05-hf-operator-plan.md and a preflight checklist with clear GO/NO-GO stop points.

## PR handoff

Push your corrections non-force to the appropriate PR #22 head after confirming branch/ref, and keep PR open. If you must work on a separate repair branch first, explain ancestry and how it is integrated without overwriting unrelated commits. Do not merge.

Deliver:
1. PR link, final head SHA and changed-file list.
2. Gates 00-05 artifacts, sanitized logs and JSON evidence.
3. Exact test counts and real CI links.
4. Clear distinctions: CODE_READY, IMAGE_PROVEN, STORAGE_READY, LIVE_RUNTIME_PROVEN.
5. Final recommendation, with explicit remaining human decisions.

Success is **not** a claimed 100% test pass. Success is verified provenance in a production-style image, consistent filesystem judgments, realistic API tests and an operator-usable persistent-storage plan. Deployment remains NO-GO until an approved live persistence/restart gate passes.
