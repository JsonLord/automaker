# Gate 00 — source and evidence freeze

Start HEAD: `6d4af122c924e95c27930d4bb87b7109e29081fa`. Base: `f405f4fe8bc1f788c8d46558c0e90d0a41dcfdcf`.
Current branch is the exact PR #22 branch in /workspace/automaker-pr22. Other
worktrees remain intact. The only post-review change adds the authoritative directive.
End SHA is recorded in the gate ledger and final handoff.

Baseline provenance suite: **1 passed, 2 failed, exit 1**. Tests still expect unknown
identity to succeed although the generator now fails. This is a real baseline failure,
not a waived check. Frozen dependency installation succeeded. No hosted runs exist
for this head. Review metadata is summarized in the JSON companion.

## Build/context map

Dockerfile COPY consumes the HF Docker context with .git excluded by .dockerignore.
It runs generate-provenance.sh before package/server compilation and copies server
dist assets into the final stage. Optional BUILD_GIT_SHA/BUILD_TIMESTAMP can supply
identity, but no verified per-revision HF build-argument flow exists. The root
fallback build-provenance.json is untracked. export-hf-deployment.mjs puts only
committed files in its git archive and writes its SHA/digest sidecar outside that
archive. Therefore neither .git nor the sidecar reaches the actual HF build.
A static Space variable would risk stale identity. Direct HF builds are currently
not proven and will be unsupported without the packaged release contract.

build-identity.ts reads server dist/assets/build-provenance.json then the health
route exposes build identity. entrypoint.sh configures DATA_DIR/ARGUS_SKILL_HOME/
ALLOWED_ROOT_DIRECTORY and authentication; it does not establish immutable source.
index.ts installs a JSON parser and an inline error handler. overview.ts uses
fs.access and zero-valued fallback counts, while ArgusProjectAccess performs
registration, physical-root and metadata-symlink checks. Those paths disagree.

## Storage evidence limits

Historical API failures for a missing registered project demonstrate unavailability,
not a proven volume/mount cause. HF's documented default disk is ephemeral; actual
live mount, backups, state and permissions have not been inspected here. No live
Space state, secrets, project contents, restart, deployment or registration was touched.

Acceptance: baseline and defects captured; proceed to Gate 01. Full source map is
represented by the listed files and the source tree at the start SHA.
