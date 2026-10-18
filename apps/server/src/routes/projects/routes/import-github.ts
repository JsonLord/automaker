import type { Request, Response } from 'express';
import { createLogger } from '@automaker/utils';
import type { SettingsService } from '../../../services/settings-service.js';
import { execGitCommand } from '@automaker/git-utils';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs/promises';

const logger = createLogger('ImportGithub');

interface ImportGithubRequest {
  repoUrl: string;
  projectName: string;
  parentDir: string;
}

export function createImportGithubHandler(settingsService: SettingsService) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { repoUrl, projectName, parentDir } = req.body as ImportGithubRequest;

      // Basic validation
      if (!repoUrl || typeof repoUrl !== 'string' || !repoUrl.startsWith('https://github.com/')) {
        res.status(400).json({ success: false, error: 'repoUrl must be a valid GitHub HTTPS URL' });
        return;
      }

      if (!projectName || !/^[a-zA-Z0-9-_]+$/.test(projectName)) {
        res.status(400).json({ success: false, error: 'projectName contains invalid characters' });
        return;
      }

      if (!parentDir) {
        res.status(400).json({
          success: false,
          error: 'Missing required parameters (repoUrl, projectName, parentDir)',
        });
        return;
      }

      const allowedBaseDir = process.env.ALLOWED_ROOT_DIRECTORY || '/app/data/projects';
      const projectPath = path.resolve(parentDir, projectName);

      // Security Check: Ensure projectPath is inside allowed boundaries
      if (!projectPath.startsWith(path.resolve(allowedBaseDir))) {
        res.status(403).json({ success: false, error: 'Invalid parentDir or traversal attempted' });
        return;
      }

      const projectId = randomUUID();

      logger.info(`Starting import of ${repoUrl} to ${projectPath}`);

      // 1. Verify destination repo visibility and ancestry BEFORE cloning or importing
      try {
        // Must be a valid repo
        await execGitCommand(['ls-remote', repoUrl], process.cwd());

        // Verify we have write permissions by doing a dry-run push against a sentinel branch.
        await execGitCommand(
          ['push', '--dry-run', repoUrl, 'HEAD:refs/heads/automaker-import-test'],
          process.cwd()
        );
      } catch (err) {
        logger.error(`Failed to verify remote repo ${repoUrl} authorization or connectivity:`, err);
        res.status(403).json({
          success: false,
          error:
            'Failed to verify destination repository write authorization. Dry-run push failed or repo not found.',
        });
        return;
      }

      // 2. We do a raw clone of the original repo. We do NOT strip .git.
      try {
        await fs.stat(projectPath);
        res.status(409).json({ success: false, error: 'Project directory already exists' });
        return;
      } catch (e) {
        // Directory doesn't exist, proceed
      }

      try {
        await execGitCommand(['clone', repoUrl, projectPath], process.cwd());
      } catch (err) {
        logger.error(`Failed to clone ${repoUrl}:`, err);
        res.status(500).json({ success: false, error: 'Failed to clone repository' });
        return;
      }

      // 3. Resolve the actual SHA we cloned
      let baseSha = 'unknown';
      try {
        baseSha = (await execGitCommand(['rev-parse', 'HEAD'], projectPath)).trim();
      } catch (err) {
        logger.error(`Failed to resolve HEAD for imported repo:`, err);
        res.status(500).json({ success: false, error: 'Failed to resolve repository HEAD' });
        return;
      }

      // 4. Register with Automaker Settings (similar to bootstrap)
      try {
        const globalSettings = await settingsService.getGlobalSettings();
        const existingProjects = globalSettings.projects || [];
        const exists = existingProjects.some((p) => p.path === projectPath || p.id === projectId);
        if (!exists) {
          existingProjects.push({
            id: projectId,
            name: projectName,
            path: projectPath,
          });
          await settingsService.updateGlobalSettings({ projects: existingProjects });
          logger.info(`Registered imported project ${projectId} in Automaker settings`);
        }
      } catch (error) {
        logger.error('Error registering project in settings:', error);
        res.status(500).json({ success: false, error: 'Failed to register project settings' });
        return;
      }

      res.status(200).json({
        success: true,
        projectId,
        projectPath,
        projectName,
        baseSha,
        message: 'Repository imported successfully and authorized for Argus execution',
      });
    } catch (err: any) {
      logger.error(`Unhandled error:`, err);
      res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
    }
  };
}
