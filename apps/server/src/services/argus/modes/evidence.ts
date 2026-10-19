import fs from 'fs/promises';
import path from 'path';
import { constants } from 'fs';
import { invariant } from './contracts.js';

/** Explicit file inputs only: never recursively crawl projects, metadata or credentials. */
export async function readEvidenceFile(root: string, relative: string) {
  invariant(
    !path.isAbsolute(relative) &&
      !relative.split(/[\\/]/).some((p) => !p || p === '.' || p === '..' || p.startsWith('.')),
    'MODE_SOURCE_PATH_DENIED',
    403
  );
  invariant(
    /\.(?:md|txt|json|ts|tsx|js|mjs|py|yaml|yml|html|css)$/i.test(relative),
    'MODE_SOURCE_TYPE_UNAVAILABLE'
  );
  invariant(
    !/(?:secret|credential|password|token|private[-_]?key)/i.test(relative),
    'MODE_SOURCE_PATH_DENIED',
    403
  );
  const base = await fs.realpath(root);
  const file = path.join(base, relative);
  let cursor = base;
  for (const part of relative.split(/[\\/]/)) {
    cursor = path.join(cursor, part);
    invariant(!(await fs.lstat(cursor)).isSymbolicLink(), 'MODE_SOURCE_SYMLINK_DENIED', 403);
  }
  invariant((await fs.realpath(file)) === file, 'MODE_SOURCE_PATH_DENIED', 403);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    invariant(stat.isFile() && stat.size <= 16384, 'MODE_SOURCE_TOO_LARGE');
    const buffer = Buffer.alloc(16385);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    invariant(
      bytesRead <= 16384 && !buffer.subarray(0, bytesRead).includes(0),
      'MODE_SOURCE_BINARY_OR_TOO_LARGE'
    );
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}
