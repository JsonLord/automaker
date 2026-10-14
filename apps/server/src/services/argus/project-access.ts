import fs from 'fs/promises';
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
const within = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

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
    let actual: string;
    try {
      actual = await fs.realpath(registered.path);
    } catch {
      throw new ArgusAccessError(404, 'PROJECT_DIRECTORY_UNAVAILABLE');
    }
    if (process.env.ALLOWED_ROOT_DIRECTORY) {
      const root = await fs.realpath(process.env.ALLOWED_ROOT_DIRECTORY);
      if (!within(root, actual)) throw new ArgusAccessError(403, 'PROJECT_OUTSIDE_ALLOWED_ROOT');
    }
    try {
      if ((await fs.lstat(path.join(actual, '.automaker'))).isSymbolicLink())
        throw new ArgusAccessError(403, 'ARGUS_METADATA_SYMLINK_REFUSED');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return actual;
  }
}
