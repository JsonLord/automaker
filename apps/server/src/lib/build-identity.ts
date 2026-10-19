import { execFile } from 'child_process';
import { promisify } from 'util';
import { getVersion } from './version.js';
const exec = promisify(execFile);
export type VersionProbe = (command: string, args: string[]) => Promise<string>;
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function readBuildIdentity(
  probe: VersionProbe = async (command, args) =>
    (await exec(command, args, { timeout: 5000, maxBuffer: 16384 })).stdout
) {
  const tool = async (command: string) => {
    try {
      const version = (await probe(command, ['--version'])).match(
        /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/
      )?.[0];
      return { installed: Boolean(version), version: version || null };
    } catch {
      return { installed: false, version: null };
    }
  };
  const [argus, opencode] = await Promise.all([tool('argus'), tool('opencode')]);
  let loki = false;
  try {
    loki = (await probe('loki', ['help', 'verify-pr'])).includes('verify-pr');
  } catch {
    /* unavailable is not verified */
  }
  let gitSha: string | null = null;
  let buildTimestamp: string | null = null;

  try {
    const provenancePath = path.join(
      __dirname,
      '..',
      '..',
      'dist',
      'assets',
      'build-provenance.json'
    );
    const content = await fs.readFile(provenancePath, 'utf8');
    const data = JSON.parse(content);
    if (/^(?!0{40}$)[0-9a-f]{40}$/i.test(data.gitSha)) {
      gitSha = data.gitSha;
    }
    if (data.buildTimestamp && Number.isFinite(Date.parse(data.buildTimestamp))) {
      buildTimestamp = data.buildTimestamp;
    }
  } catch (error) {
    // Use environment variables if file is missing (e.g. tests or local dev without build)
    gitSha = /^(?!0{40}$)[0-9a-f]{40}$/i.test(process.env.BUILD_GIT_SHA || '')
      ? process.env.BUILD_GIT_SHA || null
      : null;
    buildTimestamp =
      process.env.BUILD_TIMESTAMP && Number.isFinite(Date.parse(process.env.BUILD_TIMESTAMP))
        ? process.env.BUILD_TIMESTAMP
        : null;
  }

  return {
    applicationVersion: getVersion(),
    gitSha,
    sourceIdentity: gitSha ? 'known' : 'unknown',
    buildTimestamp,
    argus,
    opencode,
    lokiAdapterAvailable: loki,
    capabilitiesEnabled: {
      loki: process.env.ARGUS_LOKI_ENABLED === 'true',
      continuousEngineering: process.env.ARGUS_CONTINUOUS_ENGINEERING_ENABLED === 'true',
      workerWaves: process.env.ARGUS_WORKER_WAVES_ENABLED === 'true',
      foreman: process.env.ARGUS_FOREMAN_ENABLED === 'true',
    },
  };
}
let cached: ReturnType<typeof readBuildIdentity> | undefined;
export function getBuildIdentity() {
  return (cached ||= readBuildIdentity());
}
