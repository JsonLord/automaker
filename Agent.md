# Deployment Manager Agent.md

This file serves as a guide for further agents regarding deployment best practices and tips for Automaker on Hugging Face Spaces.

## 1. Deployment Configuration

### Target Space
- **Profile:** `Leon4gr45`
- **Space:** `automaker`
- **Full Identifier:** `Leon4gr45/automaker`
- **Frontend Port:** `7860` (mandatory for all Hugging Face Spaces)

### Deployment Method
- **Docker SDK**

### HF Token
- The HF token environment variable will always be provided at execution time.
- Never hardcode the token. Always read it from the environment.
- All monitoring and log‑streaming commands rely on the HF token.

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
- `Agent.md`

---

## 2. API Exposure and Documentation

### Mandatory Endpoints
- **`/health`**: Returns HTTP 200 when ready. Required for Hugging Face to transition the Space from starting to running.
- **`/api-docs`**: Documents all available API endpoints. Reachable at: `https://Leon4gr45-automaker.hf.space/api-docs`

### Functional Endpoints

### /health
- **Method:** GET
- **Path:** `/health`
- **Purpose:** Check server health and readiness
- **Request Example:**
  ```json
  {}
  ```
- **Response Example:**
  ```json
  {
    "status": "ok"
  }
  ```

### /api-docs
- **Method:** GET
- **Path:** `/api-docs`
- **Purpose:** Document all available API endpoints
- **Request Example:**
  ```json
  {}
  ```
- **Response Example:**
  ```json
  {
    "message": "Automaker API Documentation",
    "endpoints": [
      {
        "method": "GET",
        "path": "/health",
        "purpose": "Check server health and readiness"
      }
    ]
  }
  ```

### /api/projects
- **Method:** GET
- **Path:** `/api/projects`
- **Purpose:** List all configured projects
- **Request Example:**
  ```json
  {}
  ```
- **Response Example:**
  ```json
  {
    "projects": [
      {
        "id": "project-1",
        "name": "My Project",
        "path": "/app/data/projects/my-project"
      }
    ]
  }
  ```

### /api/agent/chat
- **Method:** POST
- **Path:** `/api/agent/chat`
- **Purpose:** Send a message to the AI agent
- **Request Example:**
  ```json
  {
    "message": "Hello agent",
    "projectPath": "/app/data/projects/my-project"
  }
  ```
- **Response Example:**
  ```json
  {
    "sessionId": "session-123",
    "status": "started"
  }
  ```

### /api/features
- **Method:** POST
- **Path:** `/api/features`
- **Purpose:** Create a new feature card on the Kanban board
- **Request Example:**
  ```json
  {
    "title": "New Feature",
    "description": "Implement feature details",
    "projectPath": "/app/data/projects/my-project"
  }
  ```
- **Response Example:**
  ```json
  {
    "id": "feat-123",
    "title": "New Feature",
    "status": "backlog"
  }
  ```

### /api/settings
- **Method:** GET
- **Path:** `/api/settings`
- **Purpose:** Get global application settings
- **Request Example:**
  ```json
  {}
  ```
- **Response Example:**
  ```json
  {
    "theme": "dark",
    "concurrentAgents": 3
  }
  ```

---

## 3. Deployment Workflow

Precondition: Use the huggingface hub cli `hf` to check that the space is empty of files and delete any which are still in there and not belonging to the project to be uploaded.

### Standard Deployment Command
After any code change, run:
```bash
hf upload Leon4gr45/automaker . --repo-type=space --token <HF_TOKEN>
```

### Monitoring Logs
Scan build and run logs:
- Get build logs (SSE):
```bash
curl -N -H "Authorization: Bearer <HF_TOKEN>" "https://huggingface.co/api/spaces/Leon4gr45/automaker/logs/build"
```
- Get run logs (SSE) once the build logs succeed:
```bash
curl -N -H "Authorization: Bearer <HF_TOKEN>" "https://huggingface.co/api/spaces/Leon4gr45/automaker/logs/run"
```

Monitor for 300 seconds to see if the deployment has been successful. If any logs indicate failure, fix these issues in the codebase via code modifications, redeploy, and monitor again until the space is running and reacts to API endpoints.
