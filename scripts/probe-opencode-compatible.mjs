// Bounded, non-mutating smoke test against a local OpenAI-compatible fixture.
// Run after npm run build:server: timeout 120s node scripts/probe-opencode-compatible.mjs
// OPENCODE_BIN may name a locally installed OpenCode executable. No real endpoint is used.
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { OpencodeProvider } from '../apps/server/dist/providers/opencode-provider.js';
import { AgentExecutor } from '../apps/server/dist/services/agent-executor.js';
import { OpenCodeRoleRunner } from '../apps/server/dist/services/argus/opencode-role-runner.js';
import { configureOpenCode } from '../apps/server/dist/services/argus/opencode-config.js';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'automaker-opencode-probe-'));
const originalEnv = { ...process.env };
const cli = process.env.OPENCODE_BIN || 'opencode';
const env = {
  ...process.env,
  PATH: (cli.includes('/') ? path.dirname(path.resolve(cli)) + ':' : '') + process.env.PATH,
  XDG_DATA_HOME: root + '/data',
  XDG_CONFIG_HOME: root + '/config',
  XDG_CACHE_HOME: root + '/cache',
  XDG_STATE_HOME: root + '/state',
  COMPATIBLE_MODEL: 'MiniMax-M2.7',
  COMPATIBLE_API_KEY: crypto.randomUUID(),
};
const requests = [];
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body = {};
  try {
    body = JSON.parse(raw);
  } catch {}
  requests.push({
    path: req.url,
    model: body.model,
    authenticated: req.headers.authorization === 'Bearer ' + env.COMPATIBLE_API_KEY,
  });
  if (req.url?.endsWith('/chat/completions')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const prompt = JSON.stringify(body.messages);
    const reply = prompt.includes('diagnostic probe')
      ? JSON.stringify({
          rootCause: 'routing',
          recommendedFix: 'canonical identity',
          juniorCanRepair: true,
          evidence: [],
          filesLikelyAffected: [],
        })
      : prompt.includes('review probe')
        ? JSON.stringify({
            verdict: 'approve',
            reviewedHeadSha: 'abc',
            findings: [],
            requiredChanges: [],
            evidence: [],
          })
        : 'LOCAL_PROBE_OK';
    const base = {
      id: 'chatcmpl-local',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'MiniMax-M2.7',
    };
    res.write(
      'data: ' +
        JSON.stringify({
          ...base,
          choices: [
            { index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null },
          ],
        }) +
        '\n\n'
    );
    res.write(
      'data: ' +
        JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }) +
        '\n\n'
    );
    res.end('data: [DONE]\n\n');
  } else {
    res.writeHead(404);
    res.end('{}');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
env.COMPATIBLE_URL = `http://127.0.0.1:${server.address().port}/v1`;
process.env.PATH = env.PATH;
Object.assign(process.env, {
  XDG_DATA_HOME: env.XDG_DATA_HOME,
  XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
  XDG_CACHE_HOME: env.XDG_CACHE_HOME,
  XDG_STATE_HOME: env.XDG_STATE_HOME,
});
const cfg = root + '/config/opencode';
await fs.mkdir(cfg, { recursive: true });
await fs.writeFile(cfg + '/opencode.json', JSON.stringify({ permission: { '*': 'deny' } }));
let outcome;
try {
  const cliVersion = execFileSync(cli, ['--version'], {
    env,
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const model = await configureOpenCode(env, cfg);
  env.OPENCODE_CONFIG = cfg + '/opencode.json';
  const runProbe = (selector) =>
    new Promise((resolve) => {
      const child = spawn(cli, ['run', '--format', 'json', '--model', selector], {
        cwd: root,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (b) => (stdout += b));
      child.stderr.on('data', (b) => (stderr += b));
      child.stdin.end(
        'Return LOCAL_PROBE_OK. Do not use any tools, read files or modify anything.'
      );
      const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
      child.on('exit', (exit) => {
        clearTimeout(timer);
        resolve({
          exit,
          textReceived: stdout.includes('LOCAL_PROBE_OK'),
          events: stdout
            .split('\n')
            .filter(Boolean)
            .map((l) => {
              try {
                return JSON.parse(l).type;
              } catch {
                return 'non-json';
              }
            }),
          stderrPresent: !!stderr,
          genericServerError: (stdout + stderr).includes('Unexpected server error'),
        });
      });
    });
  const beforeRequestCount = requests.length;
  const before = await runProbe('opencode/MiniMax-M2.7');
  const wrongProviderReachedEndpoint = requests.length !== beforeRequestCount;
  outcome = await runProbe(model);
  Object.assign(process.env, env);
  const provider = new OpencodeProvider();
  const invocations = [];
  const build = provider.buildCliArgs.bind(provider);
  provider.buildCliArgs = (options) => {
    const args = build(options);
    invocations.push(args);
    return args;
  };
  const noop = async () => {};
  const executor = new AgentExecutor(
    { emitAutoModeEvent: () => {} },
    { saveFeatureSummary: noop, updateFeaturePlanSpec: noop },
    { waitForApproval: noop }
  );
  const normal = await executor.execute(
    {
      workDir: root,
      projectPath: root,
      featureId: 'bounded-cli-probe',
      prompt: 'Return LOCAL_PROBE_OK without tools.',
      abortController: new AbortController(),
      provider,
      effectiveBareModel: 'MiniMax-M2.7',
      model: 'MiniMax-M2.7',
      sdkOptions: { model, maxTurns: 1 },
      planningMode: 'skip',
    },
    {
      waitForApproval: noop,
      saveFeatureSummary: noop,
      updateFeatureSummary: noop,
      buildTaskPrompt: () => '',
    }
  );
  const runner = new OpenCodeRoleRunner();
  const diagnosis = await runner.diagnose({ fixture: 'diagnostic probe' });
  const review = await runner.review({ fixture: 'review probe' });
  const engineer = await runner.execute('Return LOCAL_PROBE_OK without tools.', root);
  console.log(
    JSON.stringify({
      cliVersion,
      identity: model,
      before: { ...before, wrongProviderReachedEndpoint },
      outcome,
      normalFeature: { textReceived: normal.responseText.includes('LOCAL_PROBE_OK'), invocations },
      roles: {
        diagnosisValid: diagnosis.result.rootCause === 'routing',
        reviewValid: review.result.verdict === 'approve',
        engineerValid: engineer.output.includes('LOCAL_PROBE_OK'),
      },
      requests,
    })
  );
  if (
    !normal.responseText.includes('LOCAL_PROBE_OK') ||
    !invocations.some((a) => a.includes(model)) ||
    diagnosis.result.rootCause !== 'routing' ||
    review.result.verdict !== 'approve' ||
    !engineer.output.includes('LOCAL_PROBE_OK') ||
    requests.some((r) => r.model !== 'MiniMax-M2.7' || !r.authenticated)
  )
    process.exitCode = 1;
  if (
    before.exit === 0 ||
    before.textReceived ||
    wrongProviderReachedEndpoint ||
    outcome.exit !== 0 ||
    !outcome.textReceived ||
    !requests.some((r) => r.model === 'MiniMax-M2.7' && r.authenticated)
  )
    process.exitCode = 1;
} catch {
  console.error('OpenCode compatible smoke test failed; inspect sanitized diagnostics above.');
  process.exitCode = 1;
} finally {
  await new Promise((resolve) => server.close(resolve));
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  await fs.rm(root, { recursive: true, force: true });
}
