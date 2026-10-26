import { inspectProjectDirectory } from './project-inspection.js';
import path from 'path';
import type { SettingsService } from '../settings-service.js';

export class ArgusAccessError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}
/** Resolve registered physical roots, not arbitrary authenticated filesystem input. */
export class ArgusProjectAccess {
  constructor(private settings: Pick<SettingsService, 'getGlobalSettings'>) {}
  async resolve(input: { projectId?: unknown; projectPath?: unknown }): Promise<string> {
    if (typeof input.projectId !== 'string' && typeof input.projectPath !== 'string')
      throw new ArgusAccessError(400, 'PROJECT_IDENTITY_REQUIRED');
    if (
      typeof input.projectPath === 'string' &&
      (!path.isAbsolute(input.projectPath) || input.projectPath.split(/[\\/]/).includes('..'))
    )
      throw new ArgusAccessError(400, 'INVALID_PROJECT_PATH');
    const projects = (await this.settings.getGlobalSettings()).projects || [];
    const registered = projects.find((project) =>
      input.projectId
        ? project.id === input.projectId
        : path.resolve(project.path) === path.resolve(input.projectPath as string)
    );
    if (
      !registered ||
      (input.projectPath &&
        path.resolve(registered.path) !== path.resolve(input.projectPath as string))
    )
      throw new ArgusAccessError(404, 'REGISTERED_PROJECT_NOT_FOUND');
    const inspection = await inspectProjectDirectory(registered.path);
    if (!inspection.available) throw new ArgusAccessError(inspection.status, inspection.reason);
    return inspection.physicalPath;
  }
}
