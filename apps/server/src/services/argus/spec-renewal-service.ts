import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type { ArgusProjectState, ObjectiveEvaluation } from './types.js';
import { saveArgusState } from './project-lifecycle.js';

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export class SpecRenewalService {
  async renew(
    projectPath: string,
    state: ArgusProjectState,
    nextSpec: string,
    evaluation: ObjectiveEvaluation
  ) {
    const specPath = path.join(projectPath, 'spec.md');
    const previous = await fs.readFile(specPath, 'utf8');
    const previousHash = hash(previous),
      newHash = hash(nextSpec);
    if (previousHash === newHash || state.previousSpecHashes?.includes(newHash))
      throw new Error('SPEC_RENEWAL_NO_PROGRESS');
    const consecutive = state.consecutiveSpecRenewalsWithoutCompletedTask || 0;
    if (consecutive >= 3) throw new Error('SPEC_RENEWAL_LIMIT_REACHED');
    const history = path.join(projectPath, '.automaker', 'spec-history');
    await fs.mkdir(history, { recursive: true });
    const oldRevision = state.specRevision;
    const archive = `${String(oldRevision).padStart(4, '0')}-${previousHash.slice(0, 12)}.md`;
    await fs
      .writeFile(path.join(history, archive), previous, { flag: 'wx' })
      .catch(async (error) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
    const temp = `${specPath}.renew-${crypto.randomUUID()}`;
    const handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(nextSpec);
    await handle.sync();
    await handle.close();
    await fs.rename(temp, specPath);
    const metadata = {
      previousRevision: oldRevision,
      previousHash,
      newRevision: oldRevision + 1,
      newHash,
      reason: evaluation.reasoning,
      evidence: evaluation.evidence,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(
        history,
        `${String(oldRevision + 1).padStart(4, '0')}-${newHash.slice(0, 12)}.json`
      ),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { mode: 0o600 }
    );
    state.previousSpecHashes = [...(state.previousSpecHashes || []), previousHash];
    state.specRevision = oldRevision + 1;
    state.specHash = newHash;
    state.consecutiveSpecRenewalsWithoutCompletedTask = consecutive + 1;
    state.activeTask = null;
    state.phase = 'planning';
    state.latestStatus = 'SPEC_RENEWED';
    await saveArgusState(projectPath, state);
    return metadata;
  }
}
