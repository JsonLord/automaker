### Endpoint Matrix

| Method | Path | Expected Status | Actual Status | Latency (ms) | Verdict |
|---|---|---|---|---|---|
| GET | `/health` | 200 | 200 | 148 | PASS |
| GET | `/api/health` | 200 | 200 | 1815 | PASS |
| GET | `/api/health/environment` | 200 | 200 | 119 | PASS |
| GET | `/api-docs` | 200 | 200 | 140 | PASS |
| GET | `/api/auth/status` | 200 | 200 | 113 | PASS |
| GET | `/api/argus/health` | 401 | 401 | 113 | PASS |
| GET | `/api/health/detailed` | 401 | 401 | 120 | PASS |
| GET | `/api/settings/global` | 401 | 401 | 119 | PASS |
| GET | `/api/projects/overview` | 401 | 401 | 110 | PASS |
| GET | `/api/argus/modes` | 401 | 401 | 107 | PASS |
| GET | `/api/argus/health` (invalid X-API-Key) | 403 | 403 | 126 | PASS |
| POST | `/api/auth/login` (malformed JSON) | 400 | 400 | 123 | PASS |
