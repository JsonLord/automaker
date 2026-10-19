import path from 'path';
import { readDurableJson, withDurableLock } from '../durable-store.js';
import type { ArgusModeState, ArgusModeId } from '@automaker/types';
const modes = new Set(['default', 'rea', 'paper2code', 'eval']);
export const modeStateFile = (root: string) => path.join(root, '.automaker', 'modes', 'state.json');
export const withModeFence = <T>(root: string, operation: () => Promise<T>) =>
  withDurableLock(path.join(root, '.automaker', 'modes', 'control'), operation);
export async function activeProjectMode(root: string): Promise<ArgusModeId | null> {
  const state = await readDurableJson<ArgusModeState>(modeStateFile(root));
  if (!state) return 'default'; // Compatibility for existing Argus projects.
  if (
    state.version !== 1 ||
    !Number.isInteger(state.revision) ||
    !Array.isArray(state.runs) ||
    !state.configs
  )
    throw new Error('MODE_STATE_CORRUPT');
  // The UI safely displays Default for an unknown selection. Scheduling stays
  // stopped until an explicit selection repairs the persisted identity.
  return modes.has(state.activeMode) ? state.activeMode : null;
}
