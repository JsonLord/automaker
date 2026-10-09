/** OpenCode's transport name is distinct from its provider/model identity. */
export const AUTOMAKER_OPENCODE_PROVIDER = 'automaker-compatible';
export const LEGACY_AUTOMAKER_OPENCODE_PROVIDER = 'automaker-compatible-provider';

export interface OpenCodeModelIdentity {
  provider: string;
  model: string;
  id: string;
}

export function isManagedOpenCodeProvider(provider?: string): boolean {
  return (
    provider === AUTOMAKER_OPENCODE_PROVIDER || provider === LEGACY_AUTOMAKER_OPENCODE_PROVIDER
  );
}

export function resolveOpenCodeModel(
  selected: string,
  providerId?: string,
  env: Record<string, string | undefined> = typeof process === 'undefined' ? {} : process.env
): OpenCodeModelIdentity {
  const prefix = `${AUTOMAKER_OPENCODE_PROVIDER}/`;
  const configured = env.COMPATIBLE_MODEL?.replace(/^automaker-compatible\//, '');
  let id = selected;
  if (id.startsWith(prefix)) {
    // Already canonical; only resolve the legacy managed 'auto' sentinel.
    if (id === prefix + 'auto' && configured) id = prefix + configured;
  } else if (isManagedOpenCodeProvider(providerId)) {
    id = prefix + (id === 'auto' && configured ? configured : id);
  } else if (
    !providerId &&
    !id.startsWith('opencode-') &&
    env.COMPATIBLE_URL &&
    configured &&
    id === configured
  ) {
    // Migrate the exact bare ID saved by older managed-provider deployments.
    id = prefix + configured;
  } else {
    id = id.replace(/^opencode-/, '');
    if (!id.includes('/')) id = `opencode/${id}`;
  }
  const separator = id.indexOf('/');
  const provider = id.slice(0, separator);
  const model = id.slice(separator + 1);
  if (!provider || !model) throw new Error('OPENCODE_MODEL_NOT_CONFIGURED');
  return { provider, model, id };
}
