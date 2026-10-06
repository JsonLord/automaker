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
    compatibleUrl: env.COMPATIBLE_URL,
    compatibleModel: env.COMPATIBLE_MODEL,
    compatibleApiKey: env.COMPATIBLE_API_KEY,
    julesApiKey: env.JULES_API_KEY,
    githubPat: env.GITHUB_PAT,
  };
}
