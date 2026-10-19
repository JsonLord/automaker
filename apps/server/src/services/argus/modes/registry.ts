import { MODE_UPSTREAMS } from './upstreams.js';
import type { ArgusModeDescriptor, ArgusModeId } from '@automaker/types';
import type { ArgusService } from '../types.js';
import type { ArgusModeAdapter } from './contracts.js';
import { DefaultMode } from './default.js';
import { ReaMode } from './rea.js';
import { Paper2CodeMode } from './paper2code.js';
import { EvalMode } from './eval.js';
export const MODE_DESCRIPTORS: ArgusModeDescriptor[] = [
  {
    id: 'default',
    label: 'Default',
    description: 'Existing Manager → Planner → Jules → PR → CI → Review workflow.',
    adapterVersion: 'automaker-default-v1',
  },
  {
    id: 'rea',
    label: 'REA',
    description:
      'Authorized source/observation research with versioned evidence and bounded experiments.',
    adapterVersion: 'rea-evidence-v1',
    upstream: MODE_UPSTREAMS.rea,
  },
  {
    id: 'paper2code',
    label: 'Paper2Code',
    description: 'Paper analysis, implementation tasks and approved CPU reference reproductions.',
    adapterVersion: 'paper2code-reference-v1',
    upstream: MODE_UPSTREAMS.paper2code,
  },
  {
    id: 'eval',
    label: 'Eval',
    description:
      'Versioned golden datasets, model comparisons and evidence-linked evaluation gates.',
    adapterVersion: 'phoenix-compatible-v1',
    upstream: MODE_UPSTREAMS.eval,
  },
];
export function createModeRegistry(
  argus: ArgusService
): ReadonlyMap<ArgusModeId, ArgusModeAdapter> {
  return new Map<ArgusModeId, ArgusModeAdapter>(
    [new DefaultMode(argus), new ReaMode(), new Paper2CodeMode(argus), new EvalMode(argus)].map(
      (adapter) => [adapter.id, adapter]
    )
  );
}
