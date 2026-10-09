# Deployment Guidelines for Automaker to Hugging Face Spaces

This repository contains an `Automaker` instance designed to be deployed directly to Hugging Face Spaces using the Docker SDK.

## 1. Deployment Configuration

### Target Space
- **Profile:** `Leon4gr45`
- **Space:** `automaker`
- **Full Identifier:** `Leon4gr45/automaker`
- **Frontend Port:** `7860` (mandatory for all Hugging Face Spaces)

### Deployment Method
We use the **Docker SDK** for flexibility, as Automaker is a custom Node.js application.

### HF Token
- The environment variable **`HF_TOKEN` will always be provided at execution time**.
- Never hardcode the token. Always read it from the environment.
- All monitoring and log-streaming commands rely on `HF_TOKEN`.

### Required Files
- `Dockerfile`
- `README.md` with Hugging Face YAML frontmatter:
  ```yaml
  ---
  title: Automaker
  sdk: docker
  app_port: 7860
  ---
  ```
- `.hfignore` to exclude unnecessary files
- `Agent.md` (this file)

## 2. API Exposure and Documentation

### Mandatory Endpoints
The backend exposes the following unauthenticated endpoints required by Hugging Face at the top of the middleware stack:

- **`/health`**
  - Returns HTTP 200 `{"status": "ok"}` when the app is ready.
  - Required for Hugging Face to transition the Space from *starting* -> *running*.

- **`/api-docs`**
  - Documents available API endpoints.
  - Reachable at: `https://Leon4gr45-automaker.hf.space/api-docs`

### Functional Endpoints

#### /health
- **Method:** GET
- **Purpose:** Check server health and readiness. Required for HF space status.
- **Request:** (none)
- **Response:** `{"status": "ok"}`

#### /api-docs
- **Method:** GET
- **Purpose:** Document all available API endpoints.
- **Request:** (none)
- **Response:** JSON with API metadata and endpoints list.

#### /api/projects
- **Method:** GET
- **Purpose:** List all configured projects.
- **Request:** (none)
- **Response:** JSON containing projects array.

#### /api/agent/chat
- **Method:** POST
- **Purpose:** Send a message to the AI agent.
- **Request:** `{"message": "Hello", "projectPath": "/app/data/projects/my-project"}`
- **Response:** `{"sessionId": "session-123", "status": "started"}`

#### /api/features
- **Method:** POST
- **Purpose:** Create a new feature card on the Kanban board.
- **Request:** `{"title": "New Feature", "description": "Details...", "projectPath": "..."}`
- **Response:** `{"id": "feat-123", "title": "New Feature", "status": "backlog"}`

#### /api/settings
- **Method:** GET
- **Purpose:** Get global application settings.
- **Request:** (none)
- **Response:** JSON with current settings configuration.

## 3. Deployment Workflow

Standard Hugging Face Hub CLI deployment command:

```bash
hf upload Leon4gr45/automaker --repo-type=space
```

Monitor via Hugging Face SSE endpoints:

```bash
# Build logs
curl -N -H "Authorization: Bearer <TOKEN>" "https://huggingface.co/api/spaces/Leon4gr45/automaker/logs/build"

# Run logs
curl -N -H "Authorization: Bearer <TOKEN>" "https://huggingface.co/api/spaces/Leon4gr45/automaker/logs/run"
```
