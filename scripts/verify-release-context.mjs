import fs from 'node:fs';
import path from 'node:path';
import { manifestName, verifyContext } from './release-identity.mjs';
try {
  const identity = verifyContext(
    process.cwd(),
    JSON.parse(fs.readFileSync(manifestName, 'utf8')),
    process.env.BUILD_GIT_SHA
  );
  if (
    process.env.BUILD_TIMESTAMP &&
    new Date(process.env.BUILD_TIMESTAMP).toISOString() !== identity.buildTimestamp
  )
    throw new Error('RELEASE_TIMESTAMP_MISMATCH');
  const output =
    process.env.PROVENANCE_FILE || '/app/apps/server/dist/assets/build-provenance.json';
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(identity, null, 2) + '\n');
  console.log(JSON.stringify(identity));
} catch (error) {
  console.error(`RELEASE_CONTEXT_REJECTED: ${error.code || error.message}`);
  process.exitCode = 1;
}
