/**
 * GET /opencode-status endpoint - Get OpenCode CLI installation and auth status
 */

import type { Request, Response } from 'express';
import { OpencodeProvider } from '../../../providers/opencode-provider.js';
import { configureOpenCode } from '../../../services/argus/opencode-config.js';
import { getErrorMessage, logError } from '../common.js';

/**
 * Creates handler for GET /api/setup/opencode-status
 * Returns OpenCode CLI installation and authentication status
 */
export function createOpencodeStatusHandler() {
  const installCommand = 'curl -fsSL https://opencode.ai/install | bash';
  const loginCommand = 'opencode auth login';

  return async (_req: Request, res: Response): Promise<void> => {
    try {
      // Ensure managed OpenCode configuration is written before checking status
      await configureOpenCode().catch(() => {});

      const provider = new OpencodeProvider();
      const status = await provider.detectInstallation();

      let authMethod = 'none';
      if (status.authMode === 'compatible-provider') {
        authMethod = 'compatible-provider';
      } else if (status.authenticated) {
        authMethod = status.hasApiKey ? 'api_key_env' : 'cli_authenticated';
      }

      const isManagedMode = status.authMode === 'compatible-provider' || !!status.reason;

      res.json({
        success: true,
        installed: status.installed,
        ready: status.ready ?? (status.installed && (status.authenticated || false)),
        authMode: status.authMode || 'none',
        provider: status.provider || null,
        model: status.model || null,
        reason: status.reason || null,
        version: status.version || null,
        path: status.path || null,
        auth: {
          authenticated: status.authenticated || false,
          method: authMethod,
          hasApiKey: status.hasApiKey || false,
          hasEnvApiKey: status.authMode === 'compatible-provider' || !!process.env.ANTHROPIC_API_KEY || !!process.env.OPENAI_API_KEY,
          hasOAuthToken: status.hasOAuthToken || false,
        },
        recommendation: !status.installed
          ? 'Install OpenCode CLI to use multi-provider AI models.'
          : status.reason || undefined,
        installCommand,
        loginCommand: isManagedMode ? undefined : loginCommand,
        installCommands: {
          macos: installCommand,
          linux: installCommand,
          npm: 'npm install -g opencode-ai',
        },
      });
    } catch (error) {
      logError(error, 'Get OpenCode status failed');
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
      });
    }
  };
}
