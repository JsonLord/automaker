# Gate 03 — real malformed-JSON request pipeline

Start SHA: `ee3f1f408289676cf939060ae3dbe5f5bac53151`. End SHA is recorded in the gate ledger.

http-app.ts is the production transport factory now used by index.ts, preserving
pre-parser CORS/logging, JSON limit, cookies and content-type enforcement. The
named jsonParserErrorHandler handles only body-parser parse/size errors, returns
bounded structured JSON and never echoes body, message, stack or paths. Other
SyntaxErrors retain their normal error path. Content-type matching now enforces
the documented exact application/json media type, including charset parameters,
and rejects application/jsonp rather than accepting a misleading substring.

Eight Supertest cases exercise this real shared assembly and the real auth routes/
auth middleware. Valid login creates a fixture session; missing credentials remain
401 and wrong API key remains 403. Malformed JSON returns stable MALFORMED_JSON,
and the actual 50 MB limit returns sanitized 413 PAYLOAD_TOO_LARGE. No copied
middleware or toy error-handler implementation is used in these tests.

The real compiled apps/server/dist/index.js was then started on loopback port 7860
with an isolated temporary HOME/DATA_DIR/projects, fixture API key, fake native
bridge, no provider/GitHub/Jules credentials and no registered projects. Actual
HTTP results: malformed login 400/application-json; valid login 200; unsupported
text 415; unauthenticated overview 401; wrong-key overview 403. The child process
was stopped and only its owned temporary fixture cleaned up. No HF restart or
production data was touched. Exact response metadata appears in the JSON companion.

Server build and lint passed. Acceptance PASS; proceed to full qualification.
