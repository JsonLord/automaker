# Gate 01 — deployable provenance contract

Start SHA: `0ee817ac` (full SHA in final gate ledger). Source tested by the actual
Docker context validator: `3b30cca468b0635f1b2c98633df82229a532e89c`. End SHA is in the ledger.

The only supported release route is committed-source export with
`node scripts/export-hf-deployment.mjs <archive>`. The archive now contains
release-source.json, including the raw commit object, tracked Git blob identities,
modes, exact commit SHA and deterministic commit timestamp. Validation recomputes
Git commit/tree/blob identities against actual context bytes and rejects extra
untracked files. It does not trust a valid-looking SHA or a sidecar. Source and
optional HF_SPACE_REVISION are distinct health fields. A static Space variable
cannot override packaged source identity in production.

Direct HF Git builds without this packaged manifest are deliberately unsupported
and fail closed. An authorized operator must export the reviewed SHA, check archive
digest, stage exactly that context (including safe committed .env examples), and
compare health SHA against the approved artifact SHA. The manifest proves content
binding, not maintainer approval; approval remains an external human decision.
The same context flow is used by Argus Platform image qualification, which checks
out the PR source head rather than qualifying a synthetic GitHub merge commit.

11 deterministic tests pass: reproducibility, no-.git valid release, missing/zero/
malformed/wrong/stale identity, commit/tree/content/timestamp tampering and injected
files. Server build passed. Compiled production health route readback returned
HTTP 200, exact packaged SHA (see JSON); installed tool probes honestly report
unavailable on the host. Production build identity no longer falls back to an
arbitrary environment SHA if its packaged provenance file is missing.

Actual Docker build command:

```sh
BUILDX_CONFIG=/tmp/pr22-buildx docker --host=unix:///var/run/docker.sock build \
  --progress=plain -t automaker-pr22:gate01 /tmp/pr22-context01b
```

Archive digest: `747924ee460e99e31384a66bdf600eb7889827f38a112ad0483542f54426f78d`.
The real builder accepted the manifest and printed the exact source SHA. The
build then FAILED in dependency installation with npm's `Exit handler never called!`.
Corepack also reported a registry request error. This does not establish a precise
network or npm root cause. **No final image, image ID or image HTTP response exists.**
IMAGE_PROVEN=NO / NOT_PROVEN. Do not substitute compiled host readback for image
qualification. The first Docker cache write problem was resolved by relocating
only BUILDX_CONFIG; registry credentials and TLS verification were preserved.
Gate 04 will retry image qualification after implementation is complete. The
blocked image subgate does not authorize deployment or prevent safe Gate 02 work.
