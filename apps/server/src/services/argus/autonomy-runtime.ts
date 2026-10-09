import type { ArgusAutonomyRunner } from './autonomy-runner.js';

let runner: ArgusAutonomyRunner | undefined;

export function setArgusAutonomyRunner(value: ArgusAutonomyRunner | undefined) {
  runner = value;
}

export function getArgusAutonomyRunner() {
  return runner;
}

export function wakeAutonomousProject(projectPath: string, reason?: string) {
  return runner?.wake(projectPath, reason);
}

export function getArgusAutonomyHealth() {
  return runner?.health();
}
