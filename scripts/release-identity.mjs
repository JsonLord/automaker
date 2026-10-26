// Git object verification binds the exported context to a specific source commit.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
export const manifestName = 'release-source.json';
export const gitObject = (kind, bytes) =>
  createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
export function treeHash(files) {
  const root = new Map();
  for (const file of files) {
    if (
      !/^(100644|100755|120000)$/.test(file.mode) ||
      !/^[a-f0-9]{40}$/.test(file.oid) ||
      !file.path ||
      file.path.includes('\\') ||
      file.path.startsWith('/') ||
      file.path.split('/').some((p) => !p || p === '.' || p === '..')
    )
      throw new Error('RELEASE_INVALID_ENTRY');
    let node = root;
    const parts = file.path.split('/');
    for (const part of parts.slice(0, -1)) {
      if (!node.has(part)) node.set(part, new Map());
      node = node.get(part);
      if (!(node instanceof Map)) throw new Error('RELEASE_ENTRY_COLLISION');
    }
    if (node.has(parts.at(-1))) throw new Error('RELEASE_DUPLICATE_ENTRY');
    node.set(parts.at(-1), file);
  }
  const hash = (node) => {
    const entries = [...node].sort(([a, av], [b, bv]) =>
      Buffer.compare(
        Buffer.from(a + (av instanceof Map ? '/' : '')),
        Buffer.from(b + (bv instanceof Map ? '/' : ''))
      )
    );
    return gitObject(
      'tree',
      Buffer.concat(
        entries.map(([name, v]) =>
          Buffer.concat([
            Buffer.from(`${v instanceof Map ? '40000' : v.mode} ${name}\0`),
            Buffer.from(v instanceof Map ? hash(v) : v.oid, 'hex'),
          ])
        )
      )
    );
  };
  return hash(root);
}
export function verifyContext(root, manifest, expectedSha) {
  if (
    manifest.schema !== 1 ||
    !/^(?!0{40}$)[a-f0-9]{40}$/.test(manifest.sourceSha || '') ||
    !Array.isArray(manifest.files) ||
    !manifest.commitBase64
  )
    throw new Error('RELEASE_MANIFEST_INVALID');
  const commit = Buffer.from(manifest.commitBase64, 'base64');
  if (
    gitObject('commit', commit) !== manifest.sourceSha ||
    (expectedSha && expectedSha.toLowerCase() !== manifest.sourceSha)
  )
    throw new Error('RELEASE_SOURCE_MISMATCH');
  const body = commit.toString('utf8');
  if (treeHash(manifest.files) !== /^tree ([a-f0-9]{40})$/m.exec(body)?.[1])
    throw new Error('RELEASE_TREE_MISMATCH');
  const seconds = /^committer .* (\d+) [+-]\d{4}$/m.exec(body)?.[1];
  if (!seconds || manifest.buildTimestamp !== new Date(Number(seconds) * 1000).toISOString())
    throw new Error('RELEASE_TIMESTAMP_MISMATCH');
  const expectedPaths = new Set(manifest.files.map((file) => file.path));
  const walk = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relative + '/');
      else if (relative !== manifestName && !expectedPaths.has(relative))
        throw new Error('RELEASE_UNTRACKED_CONTENT');
    }
  };
  walk(root);
  for (const file of manifest.files) {
    // Root .npmrc is excluded by Docker. Export separately enforces comments only.
    if (file.path === '.npmrc' && !fs.existsSync(path.join(root, file.path))) continue;
    let parent = root;
    for (const part of file.path.split('/').slice(0, -1)) {
      parent = path.join(parent, part);
      if (fs.lstatSync(parent).isSymbolicLink()) throw new Error('RELEASE_PARENT_SYMLINK');
    }
    if (!fs.existsSync(path.join(root, file.path)) && file.mode !== '120000')
      throw new Error(`RELEASE_ENTRY_MISSING:${file.path}`);
    const target = path.join(root, file.path),
      stat = fs.lstatSync(target);
    if (
      stat.isSymbolicLink() !== (file.mode === '120000') ||
      (!stat.isSymbolicLink() && !stat.isFile())
    )
      throw new Error('RELEASE_FILE_TYPE_MISMATCH');
    const bytes =
      file.mode === '120000' ? Buffer.from(fs.readlinkSync(target)) : fs.readFileSync(target);
    if (
      gitObject('blob', bytes) !== file.oid ||
      (file.mode !== '120000' && Boolean(stat.mode & 0o111) !== (file.mode === '100755'))
    )
      throw new Error('RELEASE_CONTENT_MISMATCH');
  }
  return {
    gitSha: manifest.sourceSha,
    sourceIdentity: 'known',
    buildTimestamp: manifest.buildTimestamp,
    releaseTree: /^tree ([a-f0-9]{40})$/m.exec(body)[1],
  };
}
