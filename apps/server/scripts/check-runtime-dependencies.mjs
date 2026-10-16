#!/usr/bin/env node

// Use Node's production ESM resolver: TypeScript and mocked provider tests can
// accept a dependency whose published JavaScript fails during server startup.
// Importing these entry points does not construct clients or start remote work.
const entryPoints = [
  '@anthropic-ai/claude-agent-sdk',
  '@github/copilot-sdk',
  '@modelcontextprotocol/sdk/client/index.js',
  '@modelcontextprotocol/sdk/client/stdio.js',
  '@modelcontextprotocol/sdk/client/sse.js',
  '@modelcontextprotocol/sdk/client/streamableHttp.js',
  '@openai/codex-sdk',
  'morgan',
  'ws',
  'yaml',
  'node-pty',
];

for (const entryPoint of entryPoints) {
  try {
    await import(entryPoint);
    console.log(`Runtime import passed: ${entryPoint}`);
  } catch (error) {
    console.error(`Runtime import failed: ${entryPoint}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
