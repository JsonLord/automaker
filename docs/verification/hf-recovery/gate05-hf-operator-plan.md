# Gate 05 — approved-operator storage and staging plan

This gate writes a plan only. No HF deployment, restart, volume attachment, secret
change, project repair, registration, retirement or autonomy activation was performed.
Start SHA is recorded in gate05-preflight.json; end SHA is in the gate ledger/final
handoff. PLAN_READY does not mean STORAGE_READY or LIVE_RUNTIME_PROVEN.

## Storage choice and authoritative documentation

Selected staging layout: an explicitly approved read-write HF volume mounted at
`/data`, with application state under `/data/automaker`:

| Name                   | Required value                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| DATA_DIR               | /data/automaker                                                                          |
| ARGUS_SKILL_HOME       | /data/automaker/argus                                                                    |
| ALLOWED_ROOT_DIRECTORY | /data/automaker/projects                                                                 |
| Runtime UID            | 1000                                                                                     |
| PORT                   | 7860                                                                                     |
| Authentication         | Existing approved AUTOMAKER_API_KEY/AUTHENTICATION_TOKEN mechanism; no values in reports |

Current official [Disk usage on Spaces](https://huggingface.co/docs/hub/spaces-storage),
read on 2026-10-26, states that default disk is ephemeral and recommends attaching
Storage Buckets as volumes at a specified path, read-write or read-only. It also
states that the Space actions dropdown lists source, mount path and access mode.
**Do not assume that /data is automatically persistent or POSIX-compatible.**
The chosen path is an explicit mount request, not evidence of an existing mount.
A bucket-backed filesystem may lack required hard-link/fsync/locking semantics.
If the selected HF volume cannot satisfy them, stop: STORAGE_READY=NO. Obtain an
approved POSIX-capable storage strategy in a separately reviewed change; do not
weaken atomic no-clobber or silently replace link() with stat()+rename().

## Approval and freeze before any operator action

1. Name the staging Space, approved source SHA, source archive SHA-256, final image
   identifier and capacity/billing owner. No production target is implicitly approved.
2. Require successful fresh hosted checks for the exact candidate, then separate
   approval for the staging deployment, mount configuration and bounded disposable
   registration/restart test. Missing CI or approval is STOP/NO-GO.
3. Record current HF repository revision, runtime health/source SHA, image digest
   if available, configured variable/secret _names_, existing mount/access mode,
   UID/GID, disk/memory and all registered project IDs/paths. Historical observed
   revision 4345261eb957cd1a99e1f26bd80b3af38b1558a9 is not a certified rollback.
4. With explicit operator authorization, freeze admissions and pause/drain active
   campaigns/executors through supported controls. Do not edit durable JSON to
   bypass ownership. Record queued/in-flight work and confirm it is quiescent.
   Never resume previously paused projects as part of migration.

## Inventory and secure backups

Before rebuild/restart, make operator-controlled, access-restricted encrypted
backups/snapshots of settings and project registry, native Argus state under
ARGUS_SKILL_HOME, project working trees including .git objects/remotes/branches,
all .automaker state/config/spec/history/tasks, campaigns, locks, pending intents,
stashes and immutable refs/automaker/recovery/\* references. Include uncommitted and
untracked work in a protected backup; a Git bundle alone is insufficient. Preserve
file permissions, symlink metadata and project/native UUID correspondence.

Never put backups, project content, settings bodies, API keys or session cookies
into this repository or evidence logs. Reports contain IDs, counts, redacted paths,
hashes and backup verification outcomes only. Secret values stay in the approved
secret manager. Prove a restore in an isolated authorized staging area and record
the snapshot ID and schema version before changing the runtime. A readable image
is not a state backup. If originals are already missing, record that absence and
the limits of recoverability; do not certify an empty replacement as recovery.

## Mandatory filesystem preflight on the approved mount

Inspect HF volume metadata and actual mount information through the approved
operator interface. Confirm /data resolves to the intended read-write persistent
volume, not a writable ephemeral directory. Under runtime UID 1000, in a separately
approved disposable probe directory, verify:

- traversal/read/write, capacity/headroom and ownership for all three configured paths;
- create with wx/exclusive creation and file fsync;
- publish by hard link; concurrent separate processes must leave exactly one winner;
- EEXIST preserves existing empty/nonempty/symlink destinations byte-for-byte;
- directory fsync, rename/lock behavior, crash-before/after-publication recovery;
- the same files/hashes/UID and canonical physical roots survive an approved restart.

Use the repository's argus-exclusive-files tests and durable-store contract as the
probe specification. Host fixture tests passing does not qualify the HF filesystem.
A permission, link, fsync, mount or schema failure is STOP, not permission to create
fallback directories or discard state. Probe cleanup requires explicit permission
and ownership verification; failed probes are retained for inspection.

## Handling twenty-argus-live-20261020

Keep its original registration identity, original path and native mapping intact
while investigating. The overview must report unavailability with a reason; a
missing path proves no particular storage cause. Compare backups, mount metadata,
Git object/recovery inventories and native identities. Never mkdir an empty path
just to turn the status green, clone into a guessed replacement, assign a new UUID
silently, or claim that a fresh clone restored lost working-tree/recovery history.

Human choices, each requiring explicit approval:

- Restore the original repository/state from a verified backup to the approved
  mount and use supported registration recovery with the same canonical identity.
- If recovery is impossible, preserve an audit record of the lost identity and
  obtain approval for retirement or explicit re-registration with documented
  ancestry/state loss. Do not remove the old registration or manufacture history
  as part of this corrective development task.

## Bounded disposable staging smoke and restart acceptance

After deployment/storage/test approval, use a separately named, operator-approved
fixture repository and destination known to be absent. Do not use Twenty or overwrite
any registered project. Record pre-test registry/native IDs and file/Git hashes.
Send exactly one authenticated POST /api/projects/import-github with repoUrl,
projectName and approved parentDir. Keep provider/Jules capabilities disabled.
No objective/specification is fabricated. Require paused + planning, no active
engineering task, identical Automaker/native UUID, canonical origin/default branch/
remote SHA, valid .git metadata and byte-identical preexisting controls.

Use actual project-scoped routes, not SPA fallbacks:

- GET /api/argus/status?projectId=<fixture-id>
- GET /api/argus/modes?projectId=<fixture-id>
- GET /api/argus/mode?projectId=<fixture-id>
- GET /api/argus/mode/gate?projectId=<fixture-id>

The four registered mode IDs are `default`, `rea`, `paper2code`, `eval`. With explicit
permission limited to this disposable project's configuration, select each using
PUT /api/argus/mode with projectId, mode and the current expectedRevision. Preserve
permissions.repositoryChanges=false and permissions.modelCalls=false. Read back
mode/status/gate and verify paused state and non-execution for every mode. This is
API/state coverage, not a claim that research, experiments, inference or engineering
runs passed. Do not call mode/plan, mode/run, task approval, autonomy resume or Jules.

Restart only after separate explicit restart approval. Re-read the same IDs,
canonical paths, native identity, origin/HEAD, complete Git/recovery refs, control/
state hashes (allowing only documented lifecycle timestamps) and selected-mode
revision. All preexisting projects must remain unchanged. Verify zero new Manager/
Planner/model/Jules sessions, tasks, PRs or merges. Assert authenticated API/UI
agreement, 400 MALFORMED_JSON, 415 unsupported content type, 401 absent auth and
403 wrong key without body/stack/token leakage. Stop after non-execution proof.
Cleanup/retirement of the disposable project requires explicit permission.

## Source/image proof and promotion stops

Build only the reviewed source exported from the GitHub commit. Unpack the archive
with `tar --extract --same-permissions --file=<archive> -C <owned-context>`; preserve
canonical directory/file modes so UID 1000 can read root-owned application code.
Do not overlay stale files, change README front matter, or add a static source-SHA
variable. Raw Git/direct HF builds lacking release-source.json fail closed.
The existing README already declares sdk: docker and app_port: 7860.

Verify archive digest, in-context commit/tree/blob identity and reviewed SHA before
uploading an exact staging context. Record the resulting HF revision separately
from the GitHub source SHA. The optional HF_SPACE_REVISION field is not source proof.
Require /api/health JSON build.gitSha to equal the approved built source SHA,
sourceIdentity=known, expected build timestamp, pinned OpenCode/Argus versions and
a disabled continuous-engineering capability. Compare the actual running image
identifier/digest to the approved image through an authorized operator interface.
If HF rebuilds the context with mutable external OS/Python dependencies, identical
source SHA alone does not prove a bit-identical image; qualify that exact staging
image and record its digest, or mark exact-image matching NOT_PROVEN. Never treat
hosting RUNNING status, CLI presence, a health 200 or an old null gitSha as sufficient.

Promotion remains NO-GO until fresh exact-head CI, final image readback, storage
semantics, backup/restore, authenticated disposable import and approved restart
persistence all pass, and a human explicitly approves promotion. No autonomy or
Twenty work is authorized by that decision unless separately stated.

## Rollback and failed-preflight behavior

Keep the previous verified image/source revision, configuration-name inventory and
validated volume snapshots. On unreadable mount/schema or mismatched identity,
stop new admissions, retain both old and new volumes without deletion, preserve
failed evidence and restore the prior approved runtime/paths through the operator's
normal rollback mechanism. Do not initialize a new empty state, downgrade schemas
blindly or reset project repositories. Restore data only with reviewed snapshot/
schema compatibility and explicit approval. Revalidate health identity, canonical
project/native IDs, Git history/recovery refs, paused status and authentication.
If no healthy rollback/source snapshot is known, STOP and escalate to the human
owner; the historical HF revision cannot be declared safe by assumption.
