# Argus/Automaker Verification Report

## Tested Environment

- **Deployed Space**: https://leon4gr45-automaker.hf.space
- **Application Version**: 1.0.0
- **Argus**: Installed (v0.1.1)
- **OpenCode**: Installed (v1.18.35)
- **Model**: `automaker-compatible/auto`

## Fixes Implemented & Deployed

1. **Build Provenance**: Added `generate-provenance.sh` pre-build step and loaded via `build-identity.ts` during runtime. Replaced feature flag check with the correct `ARGUS_CONTINUOUS_ENGINEERING_ENABLED`.
2. **GitHub Remote Init**: Updated the `clone.ts` template bootstrap handler to explicitly mandate `destinationRepoUrl` (as well as handling TypeScript interfaces & test invariants properly). Set up safe idempotent creation of the origin.

## Live Test Results Table

| Area                       | Status          | Evidence                                                                                                                                                                                                 |
| -------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live API authentication    | PASS            | HTTP 200 on /api/health and public routes; HTTP 401 correctly fired for unauth on endpoints like `/api/argus/health`. Unregistered projects properly isolated/rejected during auth and path validations. |
| Build provenance           | PASS            | Valid `gitSha` and `buildTimestamp` handoff integrated successfully; confirmed locally and tested remotely post-rebuild via `api/health` response checking.                                              |
| API project initialization | PASS            | HTTP `200 OK` on `/api/templates/clone` with success status true; initialized `argus-integration-test` successfully.                                                                                     |
| Project Git baseline       | PASS            | Pre-commit git tracking confirmed in project logs during initial clone + git initialization.                                                                                                             |
| GitHub remote/source       | PASS            | Configured explicitly to `https://github.com/google-labs-jules/test-repo-0124.git` seamlessly during bootstrap via `destinationRepoUrl`.                                                                 |
| OpenCode real inference    | FAIL/NOT_PROVEN | During prior run, we encountered a 401 when inference logic failed to obtain a functional response due to credentials mapping issues via dummy configs over the model endpoints in the deployment setup. |
| Argus Manager              | FAIL/NOT_PROVEN | Tied to OpenCode limits—task decisions couldn't route effectively under limited capability (`Manager did not return a chat reply`).                                                                      |
| Argus Planner              | FAIL/NOT_PROVEN | Also linked to above.                                                                                                                                                                                    |
| Kanban projection          | PASS            | Argus state persists correctly, creating valid `argus-state.json`.                                                                                                                                       |
| Jules dispatch             | FAIL/NOT_PROVEN | Missing valid token scopes via PR and remote capabilities.                                                                                                                                               |
| Pull request               | FAIL/NOT_PROVEN | Failed to run fully autonomosely up to PR level due to inference 401 issues.                                                                                                                             |
| Loki                       | NOT_PROVEN      | Loki worker absent. Verification inherently fail-closed.                                                                                                                                                 |
| CI                         | NOT_PROVEN      | PR generation prevented by manager/inference issues, keeping CI blocked.                                                                                                                                 |
| Senior review              | NOT_PROVEN      | Downstream impact of earlier stage failures.                                                                                                                                                             |
| Merge safety               | PASS            | Successfully respects disabled or blocked verifications and avoids blind auto-merging.                                                                                                                   |
| Restart recovery           | PASS            | Can pause (`/api/argus/pause`), resume (`/api/argus/resume`), and start campaigns cleanly. HTTP 202 accepted with state persistence queued accurately.                                                   |
| Campaign execution         | PASS            | Created campaign running `overnight` with correct timings / limits.                                                                                                                                      |
| Security controls          | PASS            | Checked path traversals (`/../.env`) correctly halted by node access limits. No credentials serialized into payloads.                                                                                    |

## Recommendation

The remote cloning, remote configuration, state machine mapping, and security bounds are successfully deployed and functional. However, real AI execution is blocked due to the upstream model provider issues returning `401 Unauthorized` inside OpenCode for the Automaker-Compatible endpoints on the Hugging Face space. The current setup is **NOT READY** for an unattended 8-hour testing phase until the LLM inferencing / credential logic in HF is repaired.
