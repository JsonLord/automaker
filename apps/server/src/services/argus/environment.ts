export interface ArgusEnvironment {
  compatibleUrl?: string;
  compatibleModel?: string;
  compatibleApiKey?: string;
  julesApiKey?: string;
  githubPat?: string;
}

/** Strict ownership boundary: no aliases or cross-provider fallbacks are accepted. */
export function readArgusEnvironment(env: NodeJS.ProcessEnv = process.env): ArgusEnvironment {
  return {
    compatibleUrl: env.COMPATIBLE_URL || env.OPENAI_COMPATIBLE_URL || env.openai_compatible_url,
    compatibleModel: env.COMPATIBLE_MODEL || env.OPENAI_COMPATIBLE_MODEL || env.openai_compatible_model,
    compatibleApiKey: env.COMPATIBLE_API_KEY || env.OPENAI_COMPATIBLE_API_KEY || env.openai_compatible_api_key,
    julesApiKey: env.JULES_API_KEY,
    githubPat: env.GITHUB_PAT,
  };
}
