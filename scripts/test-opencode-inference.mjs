// Qualifies the pinned, installed CLI against a loopback fixture, never a live provider.
// Requires npm run build:server. OPENCODE_BIN may select an installation outside PATH.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeRoleRunner } from '../apps/server/dist/services/argus/opencode-role-runner.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-inference-contract-'));
const original = { ...process.env };
const cli = process.env.OPENCODE_BIN || 'opencode';
let scenario = 'success';
let calls = 0;
const sentinel = path.join(root, 'unrelated.txt');
await fs.writeFile(sentinel, 'PRIVATE_SENTINEL_DO_NOT_READ');
const requests = [];
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  assert.ok(!raw.includes('PRIVATE_SENTINEL_DO_NOT_READ'));
  assert.equal(body.model, 'fixture/model');
  assert.equal(req.headers.authorization, 'Bearer fixture-provider-key');
  requests.push({
    model: body.model,
    scenario,
    toolResults: body.messages?.filter((message) => message.role === 'tool') || [],
    tools: body.tools || [],
    main: !body.messages?.some(
      (message) => message.role === 'system' && /title generator/.test(message.content)
    ),
  });
  if (scenario === 'error') {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"fixture authentication failure"}}');
    return;
  }
  const base = {
    id: 'fixture',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fixture/model',
  };
  const main = !body.messages?.some(
    (message) => message.role === 'system' && /title generator/.test(message.content)
  );
  const tool = scenario === 'tool' && main && calls++ === 0;
  const delta = tool
    ? {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'denied-read',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ filePath: sentinel }) },
          },
          {
            index: 1,
            id: 'denied-write',
            type: 'function',
            function: {
              name: 'bash',
              arguments: JSON.stringify({
                command: `echo MUTATED > ${sentinel}`,
                description: 'Must be denied',
              }),
            },
          },
        ],
      }
    : { role: 'assistant', content: 'LOCAL_PROBE_OK' };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
  );
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
  );
  res.end('data: [DONE]\n\n');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  Object.assign(process.env, {
    PATH:
      (cli.includes('/') ? path.dirname(path.resolve(cli)) + path.delimiter : '') +
      process.env.PATH,
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_STATE_HOME: path.join(root, 'state'),
    COMPATIBLE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    COMPATIBLE_MODEL: 'fixture/model',
    COMPATIBLE_API_KEY: 'fixture-provider-key',
    GITHUB_PAT: 'excluded-github-fixture',
    JULES_API_KEY: 'excluded-jules-fixture',
    HF_TOKEN: 'excluded-hf-fixture',
  });
  const version = execFileSync(cli, ['--version'], {
    env: process.env,
    encoding: 'utf8',
    timeout: 15000,
  }).trim();
  assert.equal(version, '1.18.35', 'Requalify explicitly when the Docker CLI pin changes');
  const output = await OpenCodeRoleRunner.probe('automaker-compatible/fixture/model');
  assert.equal(output.result, 'LOCAL_PROBE_OK');
  scenario = 'error';
  await assert.rejects(OpenCodeRoleRunner.probe('automaker-compatible/fixture/model'));
  scenario = 'tool';
  await OpenCodeRoleRunner.probe('automaker-compatible/fixture/model').catch(() => null);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'PRIVATE_SENTINEL_DO_NOT_READ');
  assert.ok(calls > 0, 'Fixture must attempt read and write calls in the actual inference request');
  assert.ok(
    requests.filter((request) => request.main).every((request) => request.tools.length === 0),
    'Deny-all must remove every tool from inference capabilities'
  );
  assert.ok(
    requests.some((req) => req.scenario === 'success') &&
      requests.some((req) => req.scenario === 'error') &&
      requests.some((req) => req.scenario === 'tool')
  );
  console.log(
    JSON.stringify({
      cliVersion: version,
      canonicalModel: output.model,
      genuineText: 'PASS',
      terminalError: 'PASS',
      deniedTools: 'PASS',
      unrelatedFileUnchanged: true,
      provider: 'loopback fixture only',
    })
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  await fs.rm(root, { recursive: true, force: true });
}
