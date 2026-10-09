## Authentication prerequisite

AUTHENTICATION_TOKEN_NOT_CONFIGURED

## Deployment

Space URL: https://leon4gr45-automaker.hf.space
health state: HTTP 200 OK
API docs state: HTTP 200 OK

## Authentication

SKIPPED_ENVIRONMENT_RESTRICTION (no authentication token configured)

## API surface

- GET /health
- GET /api-docs
- GET /api/projects
- POST /api/agent/chat
- POST /api/features
- GET /api/settings

## Argus health

API_GAP (No endpoint discovered in `/api-docs`)

## OpenCode

API_GAP (No endpoint discovered in `/api-docs`)

## Disposable project

API_GAP (No endpoint for creating a starter project discovered in `/api-docs`)

## Argus files

SKIPPED_ENVIRONMENT_RESTRICTION

## Argus lifecycle

SKIPPED_ENVIRONMENT_RESTRICTION

## Remote control matrix

API_GAP (No endpoints for status, pause, resume, wake, reconcile discovered in `/api-docs`)

## Kanban

SKIPPED_ENVIRONMENT_RESTRICTION

## Events

API_GAP (No websocket endpoints discovered in `/api-docs`)

## Jules

SKIPPED_ENVIRONMENT_RESTRICTION

## Loki

API_GAP (No endpoints discovered)

## Security

SKIPPED_ENVIRONMENT_RESTRICTION

## Restart

SKIPPED_ENVIRONMENT_RESTRICTION

## API gaps

The `/api-docs` endpoint does not expose any Argus remote control endpoints (health, status, pause, resume, wake, reconcile). It also does not expose endpoints to create starter projects, authenticate sessions, or access websocket events.

## Overall verdict

LIVE_API_NOT_READY
