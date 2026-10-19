# Automaker HF Runtime Baseline Report

**Target URL:** https://Leon4gr45-automaker.hf.space
**Generated:** 2026-10-19T00:38:40.385Z

| Test                             | Status          | HTTP/result | Evidence                                 |
| -------------------------------- | --------------- | ----------- | ---------------------------------------- |
| GET /health                      | PASS            | 200         | Latency: 175ms                           |
| GET /api-docs                    | PASS            | 200         | Found 19 endpoints                       |
| GET /api/auth/status             | PASS            | 200         | Auth required: true                      |
| Build Provenance                 | NOT_PROVEN      | 404         | Could not locate provenance file         |
| Unauthenticated Access Rejection | PASS            | 401         | Correctly rejected                       |
| Authenticated Access             | BLOCKED         | -           | No API_KEY provided for test             |
| Malformed JSON Rejection         | PASS            | 400         | Handled safely                           |
| List Projects                    | PASS            | 401         | Endpoint exists and responds             |
| Agent Chat Route                 | PASS            | -           | Registered in api-docs                   |
| Settings Route                   | PASS            | -           | Registered in api-docs                   |
| Argus Health                     | BLOCKED         | 401         | Authentication required to test          |
| OpenCode Provider Integration    | BLOCKED         | 401         | Authentication required to test          |
| Mode /default                    | NOT_IMPLEMENTED | 200         | Checked existence (not failing baseline) |
| Mode /rea                        | NOT_IMPLEMENTED | 200         | Checked existence (not failing baseline) |
| Mode /paper2code                 | NOT_IMPLEMENTED | 200         | Checked existence (not failing baseline) |
| Mode /eval                       | NOT_IMPLEMENTED | 200         | Checked existence (not failing baseline) |
| Playwright Rendering             | NOT_IMPLEMENTED | -           | Headless manual test stubbed             |
