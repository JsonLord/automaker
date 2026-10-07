import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execGitCommand } from '@automaker/git-utils';
import { bootstrapStarterProject } from '../services/bootstrap-starter-project.js';
import { AutoModeServiceFacade } from '../services/auto-mode/facade.js';
import type { Feature } from '@automaker/types';

describe('Starter Project Bootstrap Lifecycle', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'automaker-bootstrap-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('successfully bootstraps a fresh starter project with control files, provenance, and baseline commit', async () => {
    // 1. Setup mock template files
    const readmeContent = '# My Starter Template\n\nWelcome to agentic jumpstart.';
    const pkgJsonContent = JSON.stringify({ name: 'my-starter', version: '1.0.0', scripts: { dev: 'vite' } });

    await fs.writeFile(path.join(tempDir, 'README.md'), readmeContent);
    await fs.writeFile(path.join(tempDir, 'package.json'), pkgJsonContent);

    // Initialize git repo to simulate fresh clone
    await execGitCommand(['init'], tempDir);

    // 2. Run bootstrapStarterProject
    await bootstrapStarterProject({
      projectPath: tempDir,
      projectId: 'project-starter-123',
      projectName: 'my-starter-app',
      projectOverview: 'Build an AI assistant app',
      templateSource: 'https://github.com/webdevcody/agentic-jumpstart-starter-kit',
      templateBranch: 'main',
    });

    // 3. Verify control files exist
    const specMd = await fs.readFile(path.join(tempDir, 'spec.md'), 'utf8');
    const argusMd = await fs.readFile(path.join(tempDir, 'ARGUS.md'), 'utf8');
    const argusYaml = await fs.readFile(path.join(tempDir, '.automaker', 'argus.yaml'), 'utf8');
    const provenanceRaw = await fs.readFile(path.join(tempDir, '.automaker', 'template.json'), 'utf8');

    expect(specMd).toContain('# Campaign 1');
    expect(argusMd).toContain('# Project Objective');
    expect(argusYaml).toContain('version: 1');

    const provenance = JSON.parse(provenanceRaw);
    expect(provenance.template.source).toBe('https://github.com/webdevcody/agentic-jumpstart-starter-kit');

    // 4. Verify baseline commit exists and git rev-parse HEAD succeeds
    const headSha = (await execGitCommand(['rev-parse', '--verify', 'HEAD'], tempDir)).trim();
    expect(headSha).toMatch(/^[0-9a-f]{40}$/);

    const logOutput = await execGitCommand(['log', '-1', '--pretty=%s'], tempDir);
    expect(logOutput.trim()).toBe('chore: initialize project from starter kit');
  });

  it('prevents Auto Mode from picking up Argus autonomy-owned features', () => {
    const normalFeature: Feature = {
      id: 'feat-1',
      category: 'General',
      description: 'Normal user feature',
      status: 'backlog',
    };

    const argusCategoryFeature: Feature = {
      id: 'argus-1',
      category: 'Argus',
      description: 'Argus planned task',
      status: 'backlog',
    };

    const argusOrchestratorFeature: Feature = {
      id: 'argus-2',
      category: 'Features',
      orchestrator: 'argus',
      executionOwner: 'argus-autonomy',
      description: 'Argus autonomy task',
      status: 'backlog',
    };

    expect(AutoModeServiceFacade.isFeatureEligibleForAutoMode(normalFeature, null, 'main')).toBe(true);
    expect(AutoModeServiceFacade.isFeatureEligibleForAutoMode(argusCategoryFeature, null, 'main')).toBe(false);
    expect(AutoModeServiceFacade.isFeatureEligibleForAutoMode(argusOrchestratorFeature, null, 'main')).toBe(false);
  });
});
