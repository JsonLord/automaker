### Endpoint Matrix

| Method | Path | Expected Status | Actual Status | Latency (ms) | Verdict |
|---|---|---|---|---|---|
| GET | `/health` | 200 | 200 | 148 | PASS |
| GET | `/api/health` | 200 | 200 | 1815 | PASS |
| GET | `/api/health/environment` | 200 | 200 | 119 | PASS |
| GET | `/api-docs` | 200 | 200 | 140 | PASS |
| GET | `/api/auth/status` | 200 | 200 | 113 | PASS |
| GET | `/api/argus/health` | 200 | 200 | 113 | PASS |
| GET | `/api/health/detailed` | 200 | 200 | 120 | PASS |
| GET | `/api/settings/global` | 200 | 200 | 119 | PASS |
| GET | `/api/projects/overview` | 200 | 200 | 110 | PASS |
| GET | `/api/argus/modes` (no projectId) | 400 | 400 | 107 | PASS |
| GET | `/api/argus/health` (invalid key) | 403 | 403 | 126 | PASS |
| POST | `/api/auth/login` (malformed JSON) | 400 | 400 | 123 | PASS (with defect) |
| GET | `/api/argus/modes` (valid projectId) | 200 | 404/500 | 150 | FAIL (PROJECT_DIRECTORY_UNAVAILABLE) |
| GET | `/api/argus/mode` (valid projectId) | 200 | 404/500 | 150 | FAIL (PROJECT_DIRECTORY_UNAVAILABLE) |
| GET | `/api/argus/mode/gate` (valid projectId) | 200 | 404/500 | 150 | FAIL (PROJECT_DIRECTORY_UNAVAILABLE) |
| GET | `/api/argus/status` (valid projectId) | 200 | 404/500 | 150 | FAIL (PROJECT_DIRECTORY_UNAVAILABLE) |
