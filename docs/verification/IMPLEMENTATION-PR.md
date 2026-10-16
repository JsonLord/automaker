# Add bounded Argus campaigns, isolated verification and engineering discovery

Base: `jules-14354056622111766374-42608c2c`.

Fixes false bootstrap baseline completion, unsafe persistent state writes and
unbounded/unregistered remote controls. Adds isolated exact-SHA Loki evidence and
same-session repair, repository-wide merge ownership/current-base proof, durable
8-hour campaigns with a 30-minute drain and evidence-backed reports, bounded
Manager-admitted test discovery and measured experiment selection, canonical board
projection/campaign controls, and optional worker/Foreman interfaces.

ArgusAutonomyRunner remains the sole scheduler. Loki runs only on an external
sandbox worker. Default local Senior implementation fails closed. Discovery,
Foreman and parallel-wave execution remain disabled by default; production task
execution remains sequential. There is no deployment or live secret change.

Validation: local server/UI builds, UI type checking, error-level server/UI lint,
full server and package/UI unit suites. Exact results are recorded in
`docs/verification/CLOUD-IMPLEMENTATION-RESULTS.md`. A new secret-free GitHub
Actions workflow runs these checks. Hosted CI success is not claimed.

Docker smoke remains NOT_PROVEN: the managed Docker build network could not resolve
its session proxy during apt. Real model/Jules/Loki/Foreman and unattended tests
belong to the separate live test plan. External workers are operator-supplied;
installation is not implied by the adapter tests. Source packaging preserves all
apps/libs and records commit/timestamp/archive digest.

Review: [architecture](../architecture/ARGUS-CONTINUOUS-ENGINEERING.md),
[live verification](JULES-LIVE-TEST-PLAN.md),
[HF publishing](../deployment/HF-RELEASE-CHECKLIST.md).
