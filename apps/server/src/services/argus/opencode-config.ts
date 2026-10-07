import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { readArgusEnvironment } from './environment.js';

export const AUTOMAKER_PROVIDER_ID = 'automaker-compatible';

export function upsertCompatibleProvider(
  current: Record<string, unknown>,
  url: string,
  model: string
): Record<string, unknown> {
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
  configDir = path.join(os.homedir(), '.config', 'opencode')
): Promise<string | undefined> {
  const values = readArgusEnvironment(env);
  if (!values.compatibleUrl || !values.compatibleModel) return undefined;
  await fs.mkdir(configDir, { recursive: true });
  // The installed CLI supports opencode.json. Do not overwrite JSONC, which may contain comments.
  const configPath = path.join(configDir, 'opencode.json');
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const next = upsertCompatibleProvider(current, values.compatibleUrl, values.compatibleModel);
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  let existing = '';
  try {
    existing = await fs.readFile(configPath, 'utf8');
  } catch {
    /* new file */
  }
  if (existing !== serialized) await fs.writeFile(configPath, serialized, { mode: 0o600 });
  await fs.chmod(configPath, 0o600);

  // Validate configuration file was written and contains the managed provider
  try {
    const verified = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, any>;
    if (verified?.provider?.[AUTOMAKER_PROVIDER_ID]) {
      console.log(
        `[OpenCodeConfig] Validated provider "${AUTOMAKER_PROVIDER_ID}" with model "${values.compatibleModel}" at baseURL "${values.compatibleUrl}"`
      );
    } else {
      console.warn(`[OpenCodeConfig] Validation warning: "${AUTOMAKER_PROVIDER_ID}" missing from generated config`);
    }
  } catch (error) {
    console.error(`[OpenCodeConfig] Failed to validate config at ${configPath}:`, error);
  }

  return `${AUTOMAKER_PROVIDER_ID}/${values.compatibleModel}`;
}
