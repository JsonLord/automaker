import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { Feature } from '@automaker/types';
export type ProjectInspection =
  | { available: true; physicalPath: string }
  | { available: false; reason: string; status: number };
const within = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
};
/** Filesystem facts only. Registration/identity authorization stays with ArgusProjectAccess. */
export async function inspectProjectDirectory(
  projectPath: string,
  allowedRoot = process.env.ALLOWED_ROOT_DIRECTORY
): Promise<ProjectInspection> {
  const fail = (reason: string, status = 404): ProjectInspection => ({
    available: false,
    reason,
    status,
  });
  let link;
  try {
    link = await fs.lstat(projectPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return fail(
      code === 'EACCES' || code === 'EPERM'
        ? 'PROJECT_PARENT_INACCESSIBLE'
        : code === 'ENOTDIR'
          ? 'PROJECT_PARENT_NOT_DIRECTORY'
          : code === 'ENOENT'
            ? 'PROJECT_PATH_MISSING'
            : 'PROJECT_DIRECTORY_UNAVAILABLE',
      code === 'EACCES' || code === 'EPERM' ? 403 : 404
    );
  }
  let actual: string;
  try {
    actual = await fs.realpath(projectPath);
  } catch (error) {
    return fail(
      link.isSymbolicLink() && (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'PROJECT_BROKEN_SYMLINK'
        : 'PROJECT_DIRECTORY_UNAVAILABLE'
    );
  }
  try {
    if (!(await fs.stat(actual)).isDirectory()) return fail('PROJECT_NOT_DIRECTORY');
    if (allowedRoot) {
      let root: string;
      try {
        root = await fs.realpath(allowedRoot);
      } catch {
        return fail('ALLOWED_ROOT_UNAVAILABLE', 403);
      }
      if (!within(root, actual)) return fail('PROJECT_OUTSIDE_ALLOWED_ROOT', 403);
    }
    try {
      await fs.access(actual, constants.R_OK | constants.X_OK);
    } catch {
      return fail('PROJECT_DIRECTORY_DENIED', 403);
    }
    try {
      const metadata = await fs.lstat(path.join(actual, '.automaker'));
      if (metadata.isSymbolicLink()) return fail('ARGUS_METADATA_SYMLINK_REFUSED', 403);
      if (!metadata.isDirectory()) return fail('ARGUS_METADATA_NOT_DIRECTORY', 403);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        return fail('ARGUS_METADATA_INACCESSIBLE', 403);
    }
    return { available: true, physicalPath: actual };
  } catch {
    return fail('PROJECT_DIRECTORY_UNAVAILABLE');
  }
}
/** No recovery writes, directory creation or symlink traversal in a dashboard read. */
export async function inspectProjectFeatures(
  root: string
): Promise<{ complete: boolean; reason?: string; features: Feature[] }> {
  const features: Feature[] = [];
  const unknown = (reason: string) => ({ complete: false, reason, features });
  const directory = path.join(root, '.automaker', 'features');
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return unknown('FEATURE_STATE_INVALID');
    await fs.access(directory, constants.R_OK | constants.X_OK);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (entries.length > 10000) return unknown('FEATURE_STATE_LIMIT');
    let incomplete = false;
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        incomplete = true;
        continue;
      }
      try {
        const file = path.join(directory, entry.name, 'feature.json');
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
          incomplete = true;
          continue;
        }
        const feature = JSON.parse(await fs.readFile(file, 'utf8')) as Feature;
        if (
          !feature ||
          typeof feature.id !== 'string' ||
          feature.id !== entry.name ||
          typeof feature.status !== 'string'
        ) {
          incomplete = true;
          continue;
        }
        features.push(feature);
      } catch {
        incomplete = true;
      }
    }
    return incomplete ? unknown('FEATURE_STATE_INCOMPLETE') : { complete: true, features };
  } catch (error) {
    return unknown(
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'FEATURE_STATE_MISSING'
        : 'FEATURE_STATE_UNREADABLE'
    );
  }
}
