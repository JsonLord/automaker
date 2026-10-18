import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createImportGithubHandler } from '../../../../src/routes/projects/routes/import-github.js';
import type { Request, Response } from 'express';
import { execGitCommand } from '@automaker/git-utils';
import type { SettingsService } from '../../../../src/services/settings-service.js';
import fs from 'fs/promises';

vi.mock('@automaker/git-utils', () => ({
  execGitCommand: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  default: {
    stat: vi.fn(),
  },
}));

describe('import-github route', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockJson: ReturnType<typeof vi.fn>;
  let mockStatus: ReturnType<typeof vi.fn>;
  let mockSettingsService: Partial<SettingsService>;

  beforeEach(() => {
    mockJson = vi.fn();
    mockStatus = vi.fn().mockReturnValue({ json: mockJson });
    mockReq = {
      body: {
        repoUrl: 'https://github.com/user/repo.git',
        projectName: 'test-import',
        parentDir: '/app/data/projects',
      },
    };
    mockRes = { status: mockStatus } as Partial<Response>;
    mockSettingsService = {
      getGlobalSettings: vi.fn().mockResolvedValue({ projects: [] }),
      updateGlobalSettings: vi.fn().mockResolvedValue({}),
    };
    vi.clearAllMocks();
  });

  it('fails if required parameters are missing', async () => {
    mockReq.body = {};
    const handler = createImportGithubHandler(mockSettingsService as SettingsService);
    await handler(mockReq as Request, mockRes as Response);

    expect(mockStatus).toHaveBeenCalledWith(400);
    expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it('fails if directory already exists', async () => {
    vi.mocked(fs.stat).mockResolvedValueOnce({} as any);
    vi.mocked(execGitCommand).mockImplementation(async () => '');

    const handler = createImportGithubHandler(mockSettingsService as SettingsService);
    await handler(mockReq as Request, mockRes as Response);

    expect(mockStatus).toHaveBeenCalledWith(409);
    expect(mockJson).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Project directory already exists' })
    );
  });

  it('fails if remote is unreachable or dry-run fails (authorization verification)', async () => {
    vi.mocked(execGitCommand).mockRejectedValueOnce(new Error('ls-remote failed'));

    const handler = createImportGithubHandler(mockSettingsService as SettingsService);
    await handler(mockReq as Request, mockRes as Response);

    expect(mockStatus).toHaveBeenCalledWith(403);
    expect(mockJson).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('write authorization') })
    );
  });

  it('imports successfully when both ls-remote and push pass', async () => {
    vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

    vi.mocked(execGitCommand).mockImplementation(async (args) => {
      if (args[0] === 'ls-remote') return 'refs/heads/main';
      if (args[0] === 'push') return '';
      if (args[0] === 'clone') return '';
      if (args[0] === 'rev-parse') return 'abcd1234abcd1234abcd1234abcd1234abcd1234';
      return '';
    });

    const handler = createImportGithubHandler(mockSettingsService as SettingsService);
    await handler(mockReq as Request, mockRes as Response);

    expect(mockStatus).toHaveBeenCalledWith(200);
    expect(mockJson).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        projectId: expect.any(String),
        projectPath: expect.stringContaining('test-import'),
        baseSha: 'abcd1234abcd1234abcd1234abcd1234abcd1234',
      })
    );

    expect(mockSettingsService.updateGlobalSettings).toHaveBeenCalled();
  });
});
