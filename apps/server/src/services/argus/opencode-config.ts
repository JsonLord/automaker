import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { readArgusEnvironment } from './environment.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AUTOMAKER_OPENCODE_PROVIDER, resolveOpenCodeModel } from '@automaker/model-resolver';

export const AUTOMAKER_PROVIDER_ID = AUTOMAKER_OPENCODE_PROVIDER;

export function upsertCompatibleProvider(
  current: Record<string, unknown>,
  url: string,
  model: string
): Record<string, unknown> {
  model = model.replace(/^automaker-compatible\//, '');
  const providers = { ...((current.provider as Record<string, unknown>) || {}) };
  providers[AUTOMAKER_PROVIDER_ID] = {
    npm: '@ai-sdk/openai-compatible',
    name: 'Automaker Compatible',
    options: { baseURL: url, apiKey: '{env:COMPATIBLE_API_KEY}' },
    models: { [model]: { name: model } },
  };
  return { ...current, provider: providers };
}

export async function configureOpenCode(
  env: NodeJS.ProcessEnv = process.env,
  configDir = path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode')
): Promise<string | undefined> {
  const values = readArgusEnvironment(env);
  if (!values.compatibleUrl && !values.compatibleModel && !values.compatibleApiKey)
    return undefined;
  const missing = ['COMPATIBLE_URL', 'COMPATIBLE_MODEL', 'COMPATIBLE_API_KEY'].filter(
    (name) => !env[name]
  );
  if (missing.length)
    throw new Error(`OPENCODE_COMPATIBLE_PROVIDER_FAILED: missing ${missing.join(', ')}`);
  const identity = resolveOpenCodeModel(values.compatibleModel!, AUTOMAKER_PROVIDER_ID, env);
  await fs.mkdir(configDir, { recursive: true });
  // The installed CLI supports opencode.json. Do not overwrite JSONC, which may contain comments.
  const configPath = path.join(configDir, 'opencode.json');
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const next = upsertCompatibleProvider(current, values.compatibleUrl!, identity.model);
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  let existing = '';
  try {
    existing = await fs.readFile(configPath, 'utf8');
  } catch {
    /* new file */
  }
  if (existing !== serialized) await fs.writeFile(configPath, serialized, { mode: 0o600 });
  await fs.chmod(configPath, 0o600);

  const verified = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const provider = verified.provider?.[AUTOMAKER_PROVIDER_ID];
  if (!provider) throw new Error('OPENCODE_PROVIDER_NOT_CONFIGURED');
  if (!provider.models?.[identity.model]) throw new Error('OPENCODE_MODEL_NOT_CONFIGURED');
  if (provider.options?.apiKey !== '{env:COMPATIBLE_API_KEY}') {
    throw new Error('OPENCODE_COMPATIBLE_PROVIDER_FAILED: invalid credential reference');
  }
  console.log(
    `[OpenCodeConfig] Validated provider "${identity.provider}" model "${identity.model}"`
  );

  // `models [provider]` is a discovery command, not a coding task. Validate the
  // current CLI contract when it is installed; direct config validation above
  // remains available on machines without the optional CLI.
  try {
    const { stdout } = await promisify(execFile)('opencode', ['models', identity.provider], {
      env: { ...process.env, ...env, OPENCODE_CONFIG: configPath },
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    if (
      !stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .includes(identity.id)
    ) {
      throw new Error('OPENCODE_MODEL_NOT_CONFIGURED');
    }
    console.log(`[OpenCodeConfig] CLI discovered ${identity.id}`);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    if (failure.code === 'ENOENT' || failure.killed) {
      console.warn('[OpenCodeConfig] CLI discovery unavailable; generated configuration validated');
    } else {
      // CLI stderr can contain credentials: never echo the raw failure.
      throw new Error(
        failure.message === 'OPENCODE_MODEL_NOT_CONFIGURED'
          ? failure.message
          : 'OPENCODE_COMPATIBLE_PROVIDER_FAILED: CLI discovery failed'
      );
    }
  }
  return identity.id;
}
