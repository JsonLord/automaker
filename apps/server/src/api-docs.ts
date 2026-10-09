import { Request, Response } from 'express';

export function handleApiDocs(req: Request, res: Response) {
  const host = req.get('host');
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const publicUrl =
    process.env.AUTOMAKER_PUBLIC_URL ||
    (host ? `${protocol}://${host}` : 'https://Leon4gr45-automaker.hf.space');
  res.status(200).json({
    message: 'Automaker API Documentation',
    baseUrl: publicUrl,
    apiBaseUrl: `${publicUrl}/api`,
    authentication: {
      bearer: true,
      xApiKey: true,
      sessionCookie: true,
      queryParamApiKey: true,
      envVarForApiKey: 'AUTHENTICATION_TOKEN',
    },
    endpoints: [
      {
        method: 'GET',
        path: '/health',
        purpose: 'Check server health and readiness',
        request: {},
        response: { status: 'ok' },
      },
      {
        method: 'GET',
        path: '/api-docs',
        purpose: 'Document all available API endpoints',
        request: {},
        response: { message: 'Automaker API Documentation', endpoints: [] },
      },
      {
        method: 'GET',
        path: '/api/auth/status',
        purpose: 'Check authentication status and mode safely',
        request: {},
        response: { success: true, authenticated: true, required: true, keySource: 'environment' },
      },
      {
        method: 'POST',
        path: '/api/auth/login',
        purpose: 'Authenticate session (Public/Unauthenticated endpoint)',
        request: { apiKey: '...' },
        response: { success: true },
      },
      {
        method: 'GET',
        path: '/api/auth/token',
        purpose: 'Get short-lived websocket token (Authenticated endpoint)',
        request: {},
        response: { token: 'wsToken...', expiresAt: 123456789 },
      },
      {
        method: 'POST',
        path: '/api/auth/logout',
        purpose: 'Invalidate current session (Authenticated endpoint)',
        request: {},
        response: { success: true },
      },
      {
        method: 'GET',
        path: '/api/projects',
        purpose: 'List all configured projects',
        request: {},
        response: {
          projects: [
            { id: 'project-1', name: 'My Project', path: '/app/data/projects/my-project' },
          ],
        },
      },
      {
        method: 'POST',
        path: '/api/templates/clone',
        purpose:
          'Clone a starter project. Bootstraps: fresh git, ARGUS.md, spec.md, argus.yaml, baseline commit, project registration, and Argus wake.',
        request: {
          repoUrl: 'https://github.com/owner/repo',
          projectName: 'my-project',
          parentDir: '...',
          overview: 'optional objective',
        },
        response: {
          success: true,
          projectId: '...',
          projectPath: '...',
          bootstrap: {
            controlFiles: true,
            baselineHead: '...',
            argusRegistered: true,
            argusWoken: true,
          },
        },
      },
      {
        method: 'GET',
        path: '/api/argus/health',
        purpose: 'Check Argus service health and operational capabilities',
        request: {},
        response: {
          running: true,
          upstreamInstalled: true,
          version: '0.1.1',
          provider: 'automaker-compatible',
          model: '...',
          roleBackends: {
            MANAGER: 'opencode',
            PLANNER: 'opencode',
            ENGINEER: 'opencode',
            REVIEWER: 'opencode',
          },
          autonomy: {
            runtime: 'running',
            pendingProjects: 1,
            blockedProjects: 0,
          },
        },
      },
      {
        method: 'GET',
        path: '/api/argus/status',
        purpose: 'Get detailed Argus status for a project',
        request: { projectPath: '...' },
        response: {
          enabled: true,
          running: true,
          argusProjectId: '...',
          specRevision: 1,
          phase: 'manager',
          managerStatus: 'completed',
          plannerStatus: 'completed',
          objectiveStatus: 'active',
          activeTask: { taskId: '...' },
          reconciliation: { nextAt: 1234567, reason: 'api-wake' },
          latestStatus: 'ARGUS_WOKEN_BY_API',
        },
      },
      {
        method: 'POST',
        path: '/api/argus/pause',
        purpose: 'Pause future autonomous Argus reconciliation for a project',
        request: { projectPath: '...' },
        response: { success: true, status: 'paused' },
      },
      {
        method: 'POST',
        path: '/api/argus/resume',
        purpose: 'Resume Argus autonomous reconciliation for a project',
        request: { projectPath: '...' },
        response: { success: true, status: 'enabled' },
      },
      {
        method: 'POST',
        path: '/api/argus/wake',
        purpose: 'Wake/schedule Argus reconciliation immediately',
        request: { projectPath: '...', reason: 'optional bounded string' },
        response: { success: true },
      },
      {
        method: 'POST',
        path: '/api/argus/reconcile',
        purpose: 'Operator/debug control to explicitly invoke reconciliation runner',
        request: { projectPath: '...' },
        response: { success: true },
      },
      {
        method: 'POST',
        path: '/api/features',
        purpose: 'Create a new feature card on the Kanban board',
        request: {
          title: 'New Feature',
          description: 'Implement feature details',
          projectPath: '/app/data/projects/my-project',
        },
        response: { id: 'feat-123', title: 'New Feature', status: 'backlog' },
      },
      {
        method: 'GET',
        path: '/api/settings',
        purpose: 'Get global application settings',
        request: {},
        response: { theme: 'dark', concurrentAgents: 3 },
      },
      {
        method: 'WS',
        path: '/api/events',
        purpose:
          'Subscribe to Automaker websocket events. Connect using short-lived wsToken from /api/auth/token.',
        request: {},
        response: {},
      },
      {
        method: 'WS',
        path: '/api/terminal/ws',
        purpose: 'Connect to terminal. Connect using short-lived wsToken from /api/auth/token.',
        request: {},
        response: {},
      },
    ],
  });
}
