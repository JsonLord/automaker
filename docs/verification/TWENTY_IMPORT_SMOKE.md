# Twenty import qualification: NOT_RUN

No live import, registration, project modification, model inference, Jules session,
PR creation for Twenty, merge, deployment or autonomy activation was performed.
This document is a preflight procedure, not live acceptance evidence.

## Existing Space: read-only observations, 2026-10-23 UTC

Public `GET https://huggingface.co/api/spaces/Leon4gr45/automaker` returned:

```json
{
  "id": "Leon4gr45/automaker",
  "sha": "4345261eb957cd1a99e1f26bd80b3af38b1558a9",
  "sdk": "docker",
  "runtime": {
    "stage": "RUNNING",
    "hardware": { "current": "cpu-basic", "requested": "cpu-basic" },
    "replicas": { "current": 1, "requested": 1 },
    "sha": "4345261eb957cd1a99e1f26bd80b3af38b1558a9"
  }
}
```

The first unauthenticated `GET /api/health` returned HTTP 503/non-JSON. A later
read-only recheck on the same date recovered to HTTP 200 with genuine JSON:

```json
{
  "status": "ok",
  "version": "1.0.0",
  "build": {
    "gitSha": null,
    "sourceIdentity": "unknown",
    "buildTimestamp": "2026-10-19T14:35:51.468Z",
    "argus": { "installed": true, "version": "0.1.1" },
    "opencode": { "installed": true, "version": "1.18.35" },
    "lokiAdapterAvailable": false,
    "capabilitiesEnabled": {
      "loki": false,
      "continuousEngineering": false,
      "workerWaves": false,
      "foreman": false
    }
  }
}
```

The application is responsive at recheck, but its exact running source is unknown.
Hosting RUNNING metadata and installed CLI versions do not establish candidate
identity or authenticated import success.

The managed session reports no configured HF secret/runtime-variable/outbound
identity bindings. Consequently existing Space variable/secret names, actual disk
and memory availability, persistent directories, project registry and Argus state
were **not inspected**. No secret values were requested. No API credentials were
extracted, installed, changed or copied. The Space revision is an observed
rollback _candidate_, not a verified healthy rollback image or state backup.

## Authorized staging preflight still required

Before deploying, obtain explicit authorization naming an isolated staging Space,
its data volume and exact candidate SHA. The existing production Space is not
approved. Capture the currently healthy image/source revision and non-secret
configuration-name inventory through an already authorized operator interface.
Back up and hash project registry and durable state using the existing protected
storage mechanism, without exporting credentials. Check free disk/memory and
existing Twenty registration. Do not delete, reset or overwrite an existing
project. A rollback must preserve data and native registration identity; replacing
an image alone does not roll back durable state.

Required configuration names from source (presence must be checked by the operator;
this is not a claim that these are configured on the Space): `DATA_DIR`,
`ALLOWED_ROOT_DIRECTORY`, `ARGUS_SKILL_HOME`, `AUTOMAKER_API_KEY` or
`AUTHENTICATION_TOKEN`, `GITHUB_PAT`, `COMPATIBLE_MODEL`. Keep existing model/provider
secrets in their configured mechanism. Import never authorizes use of them. Do not
enable continuous engineering, campaigns, Jules, or any model/inference smoke flag.

## Exact API contract and bounded smoke procedure

Source contract: `POST /api/projects/import-github`, mounted by projects/index.ts.
Authentication uses the existing `X-API-Key` header, Bearer header, or authenticated
session cookie. Use an already authorized session; do not include credentials in
URLs or reports. A 401/403 is a failed authentication/authorization result, never
an import PASS. The unauthenticated health API is `/api/health`; its `build`
identity is authoritative, not the SPA or hosting revision alone.

Request shape, to be sent **once only after deployment/import authorization**:

```json
{
  "repoUrl": "https://github.com/JsonLord/twenty",
  "projectName": "twenty-staging-registration",
  "parentDir": "<authorized isolated staging directory under ALLOWED_ROOT_DIRECTORY>"
}
```

Do not include a fabricated objective or specification. Resolve the real GitHub
repository, default branch, exact remote SHA and write/branch-rule authorization
immediately before the test. The source route itself requires those metadata
checks; a successful clone or dry-run push is insufficient authorization.

Before that request, inspect existing registration through authenticated project
status and the operator's filesystem/native registry view. If Twenty already
exists, use supported registration recovery; do not re-clone over its directory.
Record source/control-file hashes and project/native identities before and after.
Use a distinct isolated destination only if authorized and confirmed absent.

Require all of the following as evidence, without enabling execution:

1. Authenticated structured API success; canonical Git origin/default branch/SHA
   and valid .git metadata match GitHub.
2. Existing ARGUS.md, spec.md and .automaker/argus.yaml hashes are unchanged; absent
   specification remains absent and creates no task.
3. Exactly one Automaker identity equals native Argus identity, with API/UI status
   `paused + planning`; status rehydration/restart preserves that state.
4. Manager, Planner, model, Jules and PR counters/log records show no new execution;
   existing projects and registry entries remain unchanged.
5. Failures return structured recoverable diagnostics, not a false ready state;
   retained logs/reports contain no credentials.

Stop after registration/non-execution verification. Do not activate autonomy or
start an engineering cycle. Local deterministic tests for these contracts are in
import-github.test.ts, argus-exclusive-files.test.ts, argus.test.ts,
argus-modes.integration.test.ts, and autonomy-runner.test.ts. They are not substitutes
for the explicitly unauthorized deployed smoke test.

## Rollback boundary

No HF mutation occurred, so there is nothing to roll back from this session.
For a future authorized staging deployment: keep the previous image/revision and
volume snapshots; roll back source/image through the normal Space revision
workflow, retain persistent data, restore state only through a separately reviewed
recovery operation, and verify health/identity plus paused registration. Production
rollback cannot be certified from health alone while deployed source identity is unknown.
