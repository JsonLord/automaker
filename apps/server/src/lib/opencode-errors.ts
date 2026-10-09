/** Sanitize before bounding, so a truncation cannot expose a credential prefix. */
export function redactOpenCodeOutput(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let result = text.replace(/\x1b\[[0-9;]*m/g, '');
  for (const [name, value] of Object.entries(env)) {
    if (value && /(?:KEY|TOKEN|SECRET|PASSWORD|COMPATIBLE_API)$/i.test(name)) {
      result = result.split(value).join('[REDACTED]');
    }
  }
  return result
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,"}]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:api_?key|token|key)=)[^\s&"']+/gi, '$1[REDACTED]');
}

export function sanitizeOpenCodeOutput(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return redactOpenCodeOutput(text, env).slice(0, 4096);
}

/** Redact raw event strings before consumers can persist debug events or tool output. */
export function redactOpenCodeEvent(event: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof event === 'string') return redactOpenCodeOutput(event, env);
  if (Array.isArray(event)) return event.map((value) => redactOpenCodeEvent(value, env));
  if (event && typeof event === 'object') {
    return Object.fromEntries(
      Object.entries(event).map(([key, value]) => [key, redactOpenCodeEvent(value, env)])
    );
  }
  return event;
}

export function openCodeFailure(
  text: string,
  model: { provider: string; model: string },
  exitCode?: number | null,
  sessionId?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const clean =
    sanitizeOpenCodeOutput(text, env)
      .replace(/^Error:\s*/i, '')
      .trim()
      .slice(0, 3072) || 'Unknown OpenCode error';
  const code = /ProviderModelNotFoundError|model (?:not found|not configured)/i.test(clean)
    ? 'OPENCODE_MODEL_NOT_CONFIGURED'
    : /ProviderNotFoundError|provider (?:not found|not configured)/i.test(clean)
      ? 'OPENCODE_PROVIDER_NOT_CONFIGURED'
      : model.provider === 'automaker-compatible'
        ? 'OPENCODE_COMPATIBLE_PROVIDER_FAILED'
        : 'OPENCODE_EXECUTION_FAILED';
  return sanitizeOpenCodeOutput(
    `${code}: ${clean} [provider=${model.provider}, model=${model.model}, exit=${exitCode ?? 'unknown'}, session=${sessionId || 'none'}]`,
    env
  );
}
