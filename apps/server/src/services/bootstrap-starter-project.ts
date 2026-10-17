import { withDurableLock, writeAtomicFile } from './argus/durable-store.js';
/**
 * Starter Project Bootstrap Service
 * Owns the post-clone lifecycle for Automaker starter kit projects.
 */

import fs from 'fs/promises';
import path from 'path';
import { execGitCommand } from '@automaker/git-utils';
import { createLogger } from '@automaker/utils';
import {
  ensureArgusControlFiles,
  ensureArgusMetadataDirectory,
} from './argus/project-lifecycle.js';
import type { ArgusService } from './argus/types.js';
import type { ArgusAutonomyRunner } from './argus/autonomy-runner.js';
import type { SettingsService } from './settings-service.js';

const logger = createLogger('StarterBootstrap');

export interface BootstrapStarterProjectOptions {
  projectPath: string;
  projectId: string;
  projectName: string;
  destinationRepoUrl?: string;
  projectOverview?: string;
  templateSource?: string;
  templateBranch?: string;
  argusService?: ArgusService;
  autonomyRunner?: ArgusAutonomyRunner;
  settingsService?: SettingsService;
}

export interface BootstrapState {
  completedPhases: string[];
  bootstrappedAt: string;
  lastError?: string;
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Inspects project files read-only to produce evidence-based summary context for initial spec.
 */
async function inspectProjectContext(projectPath: string): Promise<string> {
  const readme =
    (await readOptionalFile(path.join(projectPath, 'README.md'))) ||
    (await readOptionalFile(path.join(projectPath, 'README'))) ||
    '';
  const pkgJsonStr = await readOptionalFile(path.join(projectPath, 'package.json'));

  let pkgDetails = '';
  if (pkgJsonStr) {
    try {
      const pkg = JSON.parse(pkgJsonStr);
      pkgDetails = `Name: ${pkg.name || 'unknown'}, Description: ${pkg.description || 'N/A'}, Scripts: ${Object.keys(pkg.scripts || {}).join(', ')}`;
    } catch {
      pkgDetails = 'Invalid package.json';
    }
  }

  const entries = await fs.readdir(projectPath).catch(() => []);
  const topLevel = entries
    .filter((e) => !e.startsWith('.'))
    .slice(0, 30)
    .join(', ');

  return `
Template README Snippet:
${readme.slice(0, 800)}

Package Info:
${pkgDetails}

Directory Structure:
${topLevel}
`.trim();
}

/**
 * Generate initial spec content for Campaign 1.
 */
function generateInitialSpec(
  projectName: string,
  overview: string,
  contextSummary: string
): string {
  return `# Campaign 1

## Current baseline
${contextSummary}

## Existing architecture
This project was generated from a starter kit template for ${projectName}. The codebase includes standard framework configuration, source files, and dependencies.

## Goal for this campaign
${overview || `Establish the baseline application structure for ${projectName} and implement initial core features.`}

## Planned work
- Validate initial project structure and build setup.
- Develop initial features according to project requirements while preserving baseline stability.

## Acceptance criteria
- Application builds cleanly without errors.
- Unit and integration tests pass.
- Primary feature requirements are satisfied.

## Evidence required
- Successful build and test execution logs.
- Verified functional implementation.

## Constraints
- Do not modify ARGUS.md or .automaker/argus-state.json.
- Preserve existing project architecture and conventions.

## Non-goals
- Deployment
- Release
- Publishing
`;
}

/**
 * Ensures git local user identity is configured so initial commit succeeds even in headless/container environments.
 */
async function ensureLocalGitIdentity(projectPath: string): Promise<void> {
  try {
    const name = await execGitCommand(['config', 'user.name'], projectPath).catch(() => '');
    if (!name.trim()) {
      await execGitCommand(['config', '--local', 'user.name', 'Automaker Bot'], projectPath);
      await execGitCommand(['config', '--local', 'user.email', 'bot@automaker.ai'], projectPath);
      logger.info(`[StarterBootstrap] Configured local git identity for ${projectPath}`);
    }
  } catch (error) {
    logger.warn('[StarterBootstrap] Could not configure local git identity:', error);
  }
}

export async function bootstrapStarterProject(
  options: BootstrapStarterProjectOptions
): Promise<void> {
  return withDurableLock(
    path.join(options.projectPath, '.automaker', 'bootstrap-transaction'),
    () => bootstrapStarterProjectLocked(options)
  );
}

async function bootstrapStarterProjectLocked(
  options: BootstrapStarterProjectOptions
): Promise<void> {
  const {
    projectPath,
    projectId,
    projectName,
    destinationRepoUrl,
    projectOverview,
    templateSource,
    templateBranch,
    argusService,
    autonomyRunner,
    settingsService,
  } = options;

  logger.info(
    `[StarterBootstrap] Starting bootstrap for project ${projectName} (${projectId}) at ${projectPath}`
  );

  const automakerDir = await ensureArgusMetadataDirectory(projectPath);

  const statePath = path.join(automakerDir, 'bootstrap-state.json');
  let state: BootstrapState = { completedPhases: [], bootstrappedAt: new Date().toISOString() };
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    state = JSON.parse(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const markPhase = async (phase: string) => {
    if (!state.completedPhases.includes(phase)) {
      state.completedPhases.push(phase);
      await writeAtomicFile(statePath, JSON.stringify(state, null, 2));
    }
  };

  // Phase 1: Save Provenance
  if (!state.completedPhases.includes('provenance')) {
    const provenance = {
      template: {
        source: templateSource || 'https://github.com/webdevcody/agentic-jumpstart-starter-kit',
        branch: templateBranch || 'main',
        bootstrappedAt: new Date().toISOString(),
      },
    };
    await writeAtomicFile(
      path.join(automakerDir, 'template.json'),
      JSON.stringify(provenance, null, 2)
    );
    await markPhase('provenance');
    logger.info('[StarterBootstrap] Saved template provenance');
  }

  // Phase 2: Spec & Control Files
  if (!state.completedPhases.includes('control-files')) {
    const contextSummary = await inspectProjectContext(projectPath);
    const specContent = generateInitialSpec(projectName, projectOverview || '', contextSummary);
    const defaultObjective = `Develop ${projectName} from the selected starter architecture while preserving a working, testable baseline and implementing the explicitly defined project requirements.`;
    const objective = projectOverview
      ? `${projectOverview}\n\n${defaultObjective}`
      : defaultObjective;

    await ensureArgusControlFiles(projectPath, specContent, objective);
    await markPhase('control-files');
    logger.info('[StarterBootstrap] Created ARGUS.md, spec.md, and argus.yaml');
  }

  // A recorded phase is not evidence that Git still has a valid baseline.
  const validHead = async () =>
    (await execGitCommand(['rev-parse', '--verify', 'HEAD'], projectPath).catch(() => '')).trim();
  let head = await validHead();
  if (!head) {
    state.completedPhases = state.completedPhases.filter((phase) => phase !== 'baseline-commit');
    await ensureLocalGitIdentity(projectPath);
    try {
      await execGitCommand(['add', '-A', '--', '.', ':(top,exclude).automaker'], projectPath);
      await execGitCommand(
        ['commit', '-m', 'chore: initialize project from starter kit'],
        projectPath
      );
    } catch {
      /* Verify HEAD independently; a failing hook is not a completed phase. */
    }
    head = await validHead();
  }
  if (!head) {
    state.lastError = 'BOOTSTRAP_BASELINE_HEAD_MISSING';
    await writeAtomicFile(statePath, JSON.stringify(state, null, 2));
    return; // No downstream autonomous execution against an unborn repository.
  }
  delete state.lastError;
  await markPhase('baseline-commit');

  // Phase 3.5: Configure GitHub Remote
  if (!state.completedPhases.includes('configure-remote') && destinationRepoUrl) {
    try {
      // Must verify the remote actually exists and is accessible.
      // We do this by attempting to read from it (ls-remote).
      try {
        await execGitCommand(['ls-remote', destinationRepoUrl], projectPath);
      } catch (lsRemoteError) {
        state.lastError = 'BOOTSTRAP_REMOTE_VERIFICATION_FAILED';
        await writeAtomicFile(statePath, JSON.stringify(state, null, 2));
        throw new Error(`Failed to verify destination repository: ${destinationRepoUrl}`);
      }

      await execGitCommand(['remote', 'add', 'origin', destinationRepoUrl], projectPath).catch(
        () => {
          return execGitCommand(['remote', 'set-url', 'origin', destinationRepoUrl], projectPath);
        }
      );

      logger.info(`[StarterBootstrap] Configured remote origin: ${destinationRepoUrl}`);
      await markPhase('configure-remote');
      delete state.lastError;
      await writeAtomicFile(statePath, JSON.stringify(state, null, 2));
    } catch (error) {
      logger.error(`[StarterBootstrap] Error configuring remote:`, error);
      return; // Do not proceed to registration/wake if the core invariant of having a remote failed.
    }
  }

  // Phase 4: Register with Automaker Settings
  if (!state.completedPhases.includes('register-project') && settingsService) {
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
        logger.info(`[StarterBootstrap] Registered project ${projectId} in Automaker settings`);
      }
      await markPhase('register-project');
    } catch (error) {
      logger.warn('[StarterBootstrap] Error registering project in settings:', error);
    }
  }

  // Phase 5: Argus Registration & Autonomy Wake
  if (!state.completedPhases.includes('wake-argus') && argusService) {
    try {
      await argusService.start();
      const model = process.env.COMPATIBLE_MODEL || 'alias-kimi-k2.7-code';
      await argusService.createOrResolveProject({
        projectId,
        projectPath,
        model,
      });
      await argusService.resumeProject(projectPath);

      if (autonomyRunner) {
        autonomyRunner.register(projectPath);
        await autonomyRunner.requestReconcile(projectPath, 'starter-bootstrap');
        logger.info('[StarterBootstrap] Registered and woken Argus autonomy runner');
      }
      await markPhase('wake-argus');
    } catch (error) {
      logger.error('[StarterBootstrap] Error waking Argus service:', error);
    }
  }

  logger.info(`[StarterBootstrap] Successfully completed bootstrap for ${projectName}`);
}
