# Hugging Face release checklist — separate publishing task

No HF deployment or live secret update is authorized by the source implementation
work. This checklist prepares the separately authorized publishing operation.

## Source and export

- Select the reviewed implementation commit/PR targeting the requested Jules base.
  Do not deploy an unrelated PR #9 or reset/rebase/merge main as part of packaging.
- Use Node 22, Python 3 and the committed lockfile. Run the deterministic CI commands
  documented in `docs/architecture/ARGUS-CONTINUOUS-ENGINEERING.md`.
- Commit all source changes first. Export committed source only:

```sh
node scripts/export-hf-deployment.mjs /tmp/automaker-hf.tar
mkdir -p /tmp/automaker-hf-context
tar -xf /tmp/automaker-hf.tar -C /tmp/automaker-hf-context
cd /tmp/automaker-hf-context
docker build \
  --build-arg BUILD_GIT_SHA=<provenance-gitSha> \
  --build-arg BUILD_TIMESTAMP=<provenance-buildTimestamp> \
  -t automaker:<reviewed-sha> .
```

- Save `<archive>.provenance.json`: commit, commit timestamp and archive SHA-256.
  Re-exporting the same commit must yield the same digest. The source export is
  reproducible; network-fetched OS/browser packages mean image bytes are not promised identical.
- Retain Dockerfile, entrypoint.sh, update_settings.py, package.json/package-lock.json,
  all required `apps/**`, `libs/**`, scripts and build configuration. Do not exclude
  shared packages or server/UI source needed by the Docker build. Never include
  `.git`, `.automaker`, `.env`, `.aws`, `.ssh`, node_modules or runtime data in context.
- Inspect the archive with a secret scanner before publishing. The exporter rejects
  common credential/state paths but does not replace secret scanning.
- Docker includes pinned ArgusAgent/OpenCode, gh, UI/server/shared packages. It does
  not install Loki's restricted implementation or Foreman. Loki is an external adapter.
- This cloud's attempted Docker build was blocked at apt because the build network
  could not resolve its managed `proxy`. Repeat a real build/smoke test in the approved
  publishing environment; do not call the image validated based on static checks.

## HF runtime configuration

| Variable                                           | Requirement                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| `PORT`                                             | `7860`, single public application port                              |
| `NODE_ENV`                                         | `production`                                                        |
| `DATA_DIR`                                         | persistent writable mount, e.g. `/data/automaker`                   |
| `ARGUS_SKILL_HOME`                                 | persistent Argus data, e.g. `/data/automaker/argus`                 |
| `ALLOWED_ROOT_DIRECTORY`                           | persistent project subtree, e.g. `/data/automaker/projects`         |
| `AUTHENTICATION_TOKEN` or `AUTOMAKER_API_KEY`      | required private authentication secret                              |
| `AUTOMAKER_AUTO_LOGIN`                             | `false`; entrypoint enforces this                                   |
| `AUTOMAKER_DISABLE_AUTH`                           | `false`; no production bypass                                       |
| `AUTOMAKER_HIDE_API_KEY`                           | `true`; never expose generated keys                                 |
| `JULES_API_KEY`                                    | secret for approved Jules account/source                            |
| `GITHUB_PAT` / `GH_TOKEN`                          | private repository/PR/check/merge/ref permissions                   |
| `COMPATIBLE_URL`                                   | approved compatible provider endpoint                               |
| `COMPATIBLE_MODEL`                                 | exact available provider model                                      |
| `COMPATIBLE_API_KEY`                               | model secret, environment reference only                            |
| `BUILD_GIT_SHA`, `BUILD_TIMESTAMP`                 | built into image from reviewed provenance                           |
| `ARGUS_LOKI_ENABLED`                               | initially `false`                                                   |
| `ARGUS_LOKI_VERIFY_PR`                             | `true` when worker is installed                                     |
| `ARGUS_LOKI_REQUIRED_FOR_MERGE`                    | `true` for the separately validated required-verifier policy        |
| `ARGUS_LOKI_MAX_REPAIR_ATTEMPTS`                   | at most `2`                                                         |
| `ARGUS_LOKI_WORKER_URL`, `ARGUS_LOKI_WORKER_TOKEN` | trusted HTTPS sandbox worker and private credential, when installed |
| `ARGUS_CONTINUOUS_ENGINEERING_ENABLED`             | initially `false`; enable after disposable soak tests               |

Foreman activation, worker inventory and isolated experiment executor are private
composition interfaces; no public host-management endpoints or implicit provisioning
are enabled. Leave disabled until separately integrated and tested. Do not invent
`FOREMAN_*` settings expecting an automatic connection that the runtime does not create.

## Storage and security

- Ensure UID 1000 can write persistent DATA_DIR, Argus home and project root. Keep
  root outside application source and mounted across replacements/restarts.
- Back up settings, registered projects, `.automaker` authority/campaigns/evidence,
  task archives, worker claims and Git recovery refs. Do not commit them to source.
- Confirm `.automaker` is untracked. Retain one authoritative active Runner per
  project; independent instances coordinate merge ownership through GitHub refs.
- Never mount a privileged Docker socket. Untrusted checkout/setup/test execution
  belongs on a separately isolated worker without HF/provider/controller credentials.
- Use least-privilege GitHub access and strict enforced branch protection, including
  required integration CI. Missing permission/proof must fail closed.
- Do not log real keys or set them via Docker build arguments. Use HF's secret store
  only during the separate publishing task.

## After separately authorized publishing

- Verify unauthenticated API 401; authenticated `/api/argus/health` matches the
  intended SHA, build timestamp and versions. Installation status is not operational proof.
- Verify registered-root filesystem restrictions, queued controls, pause across restart,
  UI/card projection and persistent shortened campaign report.
- Run the separate [Jules live plan](../verification/JULES-LIVE-TEST-PLAN.md) using a
  disposable repository. Keep real unattended engineering disabled until it passes.
- Record actual GitHub check run URLs/results. A workflow file or local test pass is
  not a green hosted check.

## Rollback

Pause/drain scheduling first; record active remote sessions, PRs, merge intents and
worker leases. Back up persistent state and recovery refs. Restore the previous
reviewed image without deleting or blindly replacing newer authority files. If the
older code cannot read the current schema, keep autonomy paused and restore a
consistent backed-up dataset only after reconciling remote outcomes. Recheck auth,
build SHA and project state. Never steal leases, duplicate remote sessions, force-push
canonical branches or delete recovery refs to make rollback appear clean.
