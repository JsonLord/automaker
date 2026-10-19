# PR #14 deployment blocker qualification

Scope: GitHub import, bounded OpenCode diagnostics, and runtime smoke evidence on
`fix/hf-deployment-agent-md-and-build-3606839938468972213`, starting at
`86ed9e6dfab20f3e8f195a800292ebb637bf55a5`. No mode registry, UI, Jules protocol,
autonomy or merge behavior is redesigned.

## GitHub import

The importer validates the original URL and `URL` fields, permits only an exact
HTTPS `github.com/owner/repository[.git]` URL, and rejects credentials, explicit
ports, queries, fragments and normalized traversal. Git and metadata redirects
are disabled. Git receives a bounded environment, no global/system rewrite or
hook configuration, HTTPS-only transport and repository-scoped authentication.

Existing parents and the allowed root are resolved with `realpath`; containment
uses `path.relative`. Destinations are reserved atomically, checked again before
and after clone, and never overwrite existing directories or dangling symlinks.
Duplicate registered paths and HTTPS/SSH origins are rejected. Failed registration
removes only the import's unchanged, canonical destination.

Repository metadata must establish the exact identity, clone URL, numeric ID,
non-archived state, push permission and resolved default branch. Effective branch
rules and classic protection (when protected) must be readable. Locked or
update-restricted branches fail closed. The symbolic remote HEAD, advertised
branch SHA, cloned HEAD, checked-out branch and origin must agree before project
registration. No dry-run push from Automaker's checkout is used. Import permission
is not direct push or merge permission: changes still require reviewed PRs and
all existing branch gates.

Deployment requires GitHub API access plus a repository-scoped `GITHUB_PAT` with
metadata/read, contents/read-write and permission to inspect applicable branch
protection/rules. A token that cannot read those rules fails closed. Never paste
credentials into chat or reports. Git history and `.git` remain intact.

## OpenCode inference

The authenticated `POST /api/settings/diagnostics/opencode/inference` endpoint
uses the shared role runner and provider/model resolver. The probe gets a fresh
empty cwd, isolated home/config/data/cache, generated provider configuration,
`--pure`, disabled project configuration and enforced `{"*":"deny"}` permissions.
An explicit title avoids an additional title-generation model call. Only the
compatible provider credential and required process/network/CA variables are
passed; GitHub, Jules, HF and unrelated provider credentials are excluded.

Only genuine `text` events containing the exact probe response can succeed.
Terminal errors, nonzero exit, tool events, fabricated assistant events and
unexpected text fail. One active probe per server, a 45-second deadline and
64 KiB output bounds remain enforced. Raw provider errors are never returned.

`node scripts/test-opencode-inference.mjs` tests the Docker-pinned OpenCode
1.18.35 against a loopback OpenAI-compatible fixture: canonical identity,
genuine text, terminal API error, deny-all tool capability removal, unsolicited
read/write calls and an unchanged unrelated sentinel file. This qualifies the
installed CLI contract; it is not evidence of a live external provider call.
The Docker qualification job runs this same fixture inside the built image.

## Runtime smoke evidence

Run `node scripts/test-hf-runtime.mjs --inference` with `AUTOMAKER_BASE_URL`,
`AUTOMAKER_API_KEY`, `AUTOMAKER_PROJECT_ID` (an already registered project), and
`EXPECTED_GIT_SHA` set securely. `RUNTIME_REPORT_PATH` optionally selects the JSON
report; its default is `/tmp/automaker-hf-runtime.json`, outside tracked source.
The script never selects a mode, creates a task, or activates autonomy.

Identity comes from `/api/health` and must be a real nonzero SHA. The script
checks missing-key rejection, then authenticated project-scoped `/api/argus/modes`,
`/api/argus/mode` and `/api/argus/mode/gate` JSON contracts. A blocked release
recommendation can be a valid response; it does not mean an engineering run
passed. `--inference` invokes the actual bounded diagnostic endpoint and requires
its exact successful response. Redirects, SPA HTML, 401/403 authenticated responses,
unknown/mismatched identity and missing credentials cannot yield an overall pass.
Reports contain fixed evidence messages and validated identity, never arbitrary
response bodies, credentials, project paths or provider error text.

The six required workflows remain Format Check, Security Audit, Test Suite,
E2E Tests, PR Build Check and Argus Platform (including Docker provenance and the
installed CLI fixture). A green fixture run permits controlled staging
qualification, not unattended work on JsonLord/twenty. Before live engineering,
verify the staged runtime's exact published SHA, authenticated smoke report,
repository write/protection metadata, real configured provider and a separately
approved bounded Jules engineering cycle. No HF publication or merge is performed
by this change.
