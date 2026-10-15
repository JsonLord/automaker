# Jules live verification plan — separate authorized task

Do not execute this plan during the source implementation task. Use a disposable
repository/project, approved model account and a separately published test Space.
Never use the canonical product repository for destructive or unattended experiments.

Record each step as PASS, FAIL, NOT_PROVEN, or
SKIPPED_ENVIRONMENT_RESTRICTION. PASS requires retained timestamped evidence and
exact build/PR/HEAD/base identities. A skipped test, unavailable tool or accepted
HTTP request is not a successful engineering workflow. Redact all credentials.

## 1. Identify build and authenticate

1. Set `SPACE_URL` and `PROJECT_ID` locally. Load the test API credential through
   the operator secret manager; do not paste it into issues, transcripts or URLs.
2. Call `GET /api/argus/health` with the existing session or `X-API-Key` header.
   Compare returned build identity Git SHA with the release provenance and intended
   implementation commit. Record app/Argus/OpenCode versions and enabled capabilities.
3. Repeat without authentication: expect 401. Test an incorrect key: expect 401.
   Confirm no public auto-login flow and production disable-auth bypass is ineffective.
4. With authentication call status for an unregistered path, traversal and a project
   outside the allowed root. Expect 400/403/404 and no new filesystem state.

Example request shape (credential remains a local environment reference):

```sh
curl --fail-with-body -H "X-API-Key: $AUTOMAKER_API_KEY" \
  "$SPACE_URL/api/argus/status?projectId=$PROJECT_ID"
curl --fail-with-body -H "X-API-Key: $AUTOMAKER_API_KEY" \
  -H 'Content-Type: application/json' \
  --data "{\"projectId\":\"$PROJECT_ID\"}" \
  "$SPACE_URL/api/argus/wake"
```

## 2. Starter and model availability

1. Use the existing starter-project UI/API to create a new disposable registered
   project under the persistent allowed project root. Keep real credentials outside it.
2. Verify `ARGUS.md`, `spec.md`, policy files and persistent project registration.
3. Independently run `git -C <project> rev-parse --verify HEAD`. Confirm
   `baseline-commit` is marked complete only with a valid HEAD. Repeat bootstrap;
   confirm one baseline/task. Use a failing commit hook only in a separate test
   fixture and verify truthful partial bootstrap and safe restart recovery.
4. Inspect authenticated provider status; perform one bounded model request using
   the configured compatible model. A listed provider or CLI version is insufficient.
   Record context/session identity and sanitized outcome. Confirm the generated
   config uses an environment key reference and logs/responses contain no key.

## 3. Controls and one disposable coding workflow

1. Pause the project; confirm HTTP 202 queued then durable paused status. Wake and
   reconcile must reject while paused. Restart the Space and confirm pause survives.
2. Resume; concurrent wake/reconcile requests should return promptly with queued
   revisions. Observe Manager admission, Planner task and one Argus-owned board card.
3. Verify the linked Jules source and canonical starting base SHA. Observe exactly
   one create-session intent, one real Jules session, and at most one PR for the task.
4. Move/edit/delete the Argus card using generic endpoints: expect a projection
   conflict. Generic Auto Mode must never execute it. Confirm normal cards still work.
5. Record exact GitHub PR head/base independently of the UI.

## 4. Loki, repair, CI and independent Senior

1. Enable Loki only with an authenticated trusted external worker, permitted Loki
   installation, Docker/test sandbox and worker-side `LOKI_VERIFY_PR=1`. Ensure the
   controller has neither Docker socket nor access to worker test scripts.
2. Make verification required in the disposable environment. Worker unavailable:
   expect UNAVAILABLE/NOT_PROVEN/ERROR and no merge. Confirm timeout is bounded.
3. Introduce a small deterministic regression in the disposable PR. Record actionable
   exact-SHA findings and one repair intent/message to the same active Jules session.
4. Confirm no second session/PR. Wait for authoritative new HEAD; old Loki/CI/Senior
   evidence must be invalidated. Reverify the new HEAD.
5. Complete two failed repair attempts using safe fixtures if needed; verify bounded
   escalation. For a terminal Jules session, no repair message or replacement PR is
   allowed. Default local Senior implementation must report unavailable; test a real
   isolated Senior executor only after separately installing and approving one.
6. Obtain green deterministic CI on candidate HEAD, independent exact-head Senior
   approval, strict enforced branch protection and integration CI on the exact
   GitHub test merge commit (current base + candidate HEAD).
7. Record all proof and any evidence gaps. No standalone local Loki review or
   untrusted repository test execution in the control-plane process is acceptable.

## 5. Merge and restart recovery

1. In the disposable repo only, make two approved PRs eligible concurrently. Observe
   one repository tag claim owner; the other must wait/block. Advance base between
   checks and verify integration evidence is refreshed or merge is rejected.
2. Change HEAD after review: merge must refuse stale proof.
3. Inject a transport timeout at the adapter boundary around the disposable merge;
   inspect GitHub before retrying. Restart after confirmed merge but before local
   persistence; expect one remote merge and exact-state recovery, no second merge.
4. Verify canonical sync SHA and retained immutable recovery refs for deliberately
   dirty/divergent test checkouts. Confirm `.automaker` is not tracked in Git.
5. For expired/unknown claims, stop all affected operators/workers, inspect durable
   owner/remote tag/PR outcome, then release only confirmed inactive ownership.
   Never delete or steal a claim merely because its TTL elapsed.

## 6. Objective, discovery and shortened soak

1. Run one incomplete-objective cycle: verify completed evidence is archived before
   spec renewal, `ARGUS.md` unchanged, next task admitted only by Runner budget checks.
2. Run objective satisfaction with discovery disabled: no new implementation.
3. Enable `ARGUS_CONTINUOUS_ENGINEERING_ENABLED=true` in the disposable environment.
   Supply a real persisted verification gap; verify typed hypothesis, Ideation entry,
   Manager decision and a discriminating test task with negative/positive controls.
   No evidence must yield NO_ACTION/QUIESCENT. Sensitive proposals must await human approval.
4. Experimental variants require a separately installed isolated evaluator. Validate
   reproducible baseline, exact variant SHAs, identical commands, objective measurements,
   inconclusive/tie handling and only winner admission. Missing evaluator is NOT_PROVEN.
5. Start a ten-minute campaign with a one-minute drain:
   `POST /api/argus/campaign/start` JSON
   `{"projectId":"<registered-id>","options":{"durationMs":600000,"drainMs":60000,"maxNewTasks":3,"maxRepairAttempts":2}}`.
6. Issue simultaneous starts: same campaign ID/deadline. Observe multiple safe cycles,
   pause/resume, restart at mid-run, final minute without new tasks, then deadline
   finalization without remote-session cancellation. Retrieve `/campaign/report` and
   compare exact commits, PRs, counters and proof against GitHub and persisted files.
7. Disconnect worker/GitHub/model temporarily in the test environment. Verify honest
   blocked/unavailable status and retained remote ownership, never fake verification.

## 7. Eight-hour unattended run and optional infrastructure

1. With operator-approved budgets and disposable repository, start default overnight
   campaign. Record start, 7.5h drain and 8h deadline using UTC timestamps.
2. Do not manually advance states. Monitor availability externally without sending
   wake commands. Restart once within the window; the original deadline must remain.
3. Next morning retrieve the structured report. Reconcile counts, pending remote work,
   exact commits and proof; label missing token/cost accounting NOT_PROVEN.
4. Foreman testing is optional and separately configured. Use read-only credentials
   and explicit nonproduction host allowlist. List/inspect only; allocate/release
   logical claims and test timeout/unavailable behavior. No provision/power changes,
   deletion, arbitrary shell API or production host destruction. Default disabled
   infrastructure must leave ordinary Jules workflows operational.

Attach a redacted result table, exact build/remote commit identities and artifact
references. Production publishing and irreversible changes need their own task.
