import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const queues = new Map<string, Promise<unknown>>();

async function guardMetadataPath(file: string) {
  const absolute = path.resolve(file);
  const parts = absolute.split(path.sep);
  const metadata = parts.indexOf('.automaker');
  if (metadata < 0) return;
  for (let i = metadata; i < parts.length; i++) {
    const candidate = parts.slice(0, i + 1).join(path.sep) || path.sep;
    try {
      if ((await fs.lstat(candidate)).isSymbolicLink())
        throw new Error('ARGUS_METADATA_SYMLINK_REFUSED');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** Short file transactions coordinate cooperating processes on the same shared volume.
 * Locks on an unknown host are never stolen: ambiguous ownership fails closed. */
export async function withDurableLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const previous = queues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      await guardMetadataPath(key);
      await fs.mkdir(path.dirname(key), { recursive: true, mode: 0o700 });
      const lock = `${key}.lock`;
      const owner = { token: crypto.randomUUID(), pid: process.pid, host: os.hostname() };
      const deadline = Date.now() + 2000;
      for (;;) {
        try {
          const handle = await fs.open(lock, 'wx', 0o600);
          await handle.writeFile(JSON.stringify(owner));
          await handle.sync();
          await handle.close();
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          // Even a dead PID is ambiguous across container PID namespaces, and
          // unlinking a stale lock can race a new owner's acquisition. Fail closed;
          // operators recover crash-left locks after confirming all owners stopped.
          if (Date.now() >= deadline) throw new Error('ARGUS_PERSISTENCE_LOCKED');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      try {
        return await operation();
      } finally {
        const current = await readDurableJson<typeof owner>(lock);
        if (current?.token === owner.token) await fs.unlink(lock);
      }
    });
  queues.set(key, next);
  try {
    return await next;
  } finally {
    if (queues.get(key) === next) queues.delete(key);
  }
}

export async function readDurableJson<T>(file: string): Promise<T | undefined> {
  try {
    await guardMetadataPath(file);
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error; // A malformed authoritative file is not a new project.
  }
}

/** Caller holds its transaction lock. Unique temp files and fsync prevent truncated state. */
export async function writeAtomicFile(file: string, content: string): Promise<void> {
  await guardMetadataPath(file);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp.${crypto.randomUUID()}`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close();
    await fs.unlink(temp).catch(() => {});
  }
}

export async function updateDurableJson<T>(
  file: string,
  update: (current: T | undefined) => T | Promise<T>
): Promise<T> {
  return withDurableLock(file, async () => {
    const next = await update(await readDurableJson<T>(file));
    await writeAtomicFile(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}
