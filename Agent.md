# Deployment Manager Agent.md

This file serves as a guide for further agents regarding deployment best practices and tips for Automaker on Hugging Face Spaces.

## 1. Deployment Configuration
The app is configured to run as a Docker container on port 7860.

### Target Spaces
- **Target:** `GraziePrego/automaker`
- **Frontend Port:** `7860`

### Mandatory Endpoints
- **`/health`**: Returns HTTP 200 when ready.
- **`/api-docs`**: Documents all API endpoints.

## 2. API Documentation

### /api/health
- **Method:** GET
- **Purpose:** Check server health
- **Response:**
  ```json
  {
    "status": "ok",
    "timestamp": "ISO Date String",
    "version": "1.0.0"
  }
  ```

### /api/auth/session
- **Method:** GET
- **Purpose:** Check current session status

### /api/agent/chat
- **Method:** POST
- **Purpose:** Send message to AI agent

## 3. Deployment Workflow

To redeploy, use:
```bash
# Deploy to GraziePrego/automaker
hf upload GraziePrego/automaker . --repo-type=space
```

### OpenCode CLI Authentication
The Space is configured to automatically log in to OpenCode if the `OPENCODE_AUTH_TOKEN` environment variable is set in the Space secrets.

### GitHub CLI Authentication
To enable GitHub operations (like PR creation), provide a GitHub Personal Access Token (PAT) via the `GITHUB_API_TOKEN` environment variable in the Space secrets.

Monitor logs via:
- Build logs: `curl -N -H "Authorization: Bearer <TOKEN>" "https://huggingface.co/api/spaces/<SPACE_ID>/logs/build"`
- Run logs: `curl -N -H "Authorization: Bearer <TOKEN>" "https://huggingface.co/api/spaces/<SPACE_ID>/logs/run"`

## Tips
- Ensure the Dockerfile builds both the UI and Server.
- The server must serve the UI static files and provide a catch-all route for SPA.
- Data is stored in `/app/data` inside the container.
