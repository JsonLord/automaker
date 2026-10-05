import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { ARGUS_UPSTREAM_CONTRACT } from '../../../src/services/argus/index.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function stubPackage() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-contract-'));
  dirs.push(root);
  await fs.mkdir(path.join(root, 'argus_skill', 'plugin'), { recursive: true });
  await fs.mkdir(path.join(root, 'argus_skill', 'webapi'), { recursive: true });
  for (const file of [
    'argus_skill/__init__.py',
    'argus_skill/plugin/__init__.py',
    'argus_skill/webapi/__init__.py',
  ])
    await fs.writeFile(path.join(root, file), '');
  await fs.writeFile(
    path.join(root, 'argus_skill', 'plugin', 'service.py'),
    `import json, os\nP=os.environ['CALLS']\ndef hit(k):\n d=json.load(open(P)) if os.path.exists(P) else {}\n d[k]=d.get(k,0)+1\n json.dump(d,open(P,'w'))\nclass ArgusPluginService:\n def create_project(self, objective, workdir):\n  hit('create_project'); return {'sid':'s-123'}\n def message(self, *args, **kwargs):\n  hit('message'); raise AssertionError('daemon wrapper used')\n`
  );
  await fs.writeFile(
    path.join(root, 'argus_skill', 'webapi', 'manager_bridge.py'),
    `import json, os\nP=os.environ['CALLS']\ndef hit(k):\n d=json.load(open(P)) if os.path.exists(P) else {}\n d[k]=d.get(k,0)+1\n json.dump(d,open(P,'w'))\ndef manager_message(sid,text):\n hit('manager_message'); return {'reason':'admitted'}\ndef manager_plan(sid):\n hit('manager_plan'); return {'steps':[{'id':'t-1','title':'Task'}],'notes':'planned'}\n`
  );
  return { root, calls: path.join(root, 'calls.json') };
}

async function bridge(root: string, calls: string, requests: object[]) {
  const child = spawn('python3', ['-u', path.resolve('scripts/argus_runtime_bridge.py')], {
    env: { PATH: process.env.PATH!, PYTHONPATH: root, CALLS: calls },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const responses: unknown[] = [];
  lines.on('line', (line) => responses.push(JSON.parse(line)));
  requests.forEach((request) => child.stdin.write(`${JSON.stringify(request)}\n`));
  child.stdin.end();
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`bridge exited ${code}`))
    );
  });
  return responses as Array<{ ok: boolean; result: Record<string, unknown> }>;
}

describe('pinned Argus upstream contract', () => {
  it('records the exact immutable source interfaces', () => {
    expect(ARGUS_UPSTREAM_CONTRACT).toMatchObject({
      revision: '746f76b7a74a1217507c9ee348eecd3b782f7c92',
      packageVersion: '0.1.1',
      projectCreation: { module: 'argus_skill.plugin.service', method: 'create_project' },
      manager: { module: 'argus_skill.webapi.manager_bridge', function: 'manager_message' },
      planner: { module: 'argus_skill.webapi.manager_bridge', function: 'manager_plan' },
    });
  });

  it('uses native create/Manager/Planner without the daemon-starting service wrapper', async () => {
    const { root, calls } = await stubPackage();
    const responses = await bridge(root, calls, [
      { requestId: 1, operation: 'ensure_project', params: { projectId: 'a', projectPath: root } },
      { requestId: 2, operation: 'manager_handoff', params: { projectId: 'a' } },
      {
        requestId: 3,
        operation: 'planner_next_task',
        params: { projectId: 'a', sourceSpecRevision: 1 },
      },
      { requestId: 4, operation: 'shutdown', params: {} },
    ]);
    expect(responses, JSON.stringify(responses)).toSatisfy((items) =>
      items.every((response) => response.ok)
    );
    expect(responses[0].result.projectId).toBe('s-123');
    expect(JSON.parse(await fs.readFile(calls, 'utf8'))).toEqual({
      create_project: 1,
      manager_message: 1,
      manager_plan: 1,
    });
  });

  it('reuses a persisted native SID across bridge process lifetimes', async () => {
    const { root, calls } = await stubPackage();
    await bridge(root, calls, [
      { requestId: 1, operation: 'ensure_project', params: { projectId: 'a', projectPath: root } },
      { requestId: 2, operation: 'shutdown', params: {} },
    ]);
    const second = await bridge(root, calls, [
      {
        requestId: 1,
        operation: 'ensure_project',
        params: { projectId: 'a', nativeProjectId: 's-123', projectPath: root },
      },
      { requestId: 2, operation: 'shutdown', params: {} },
    ]);
    expect(second[0].result.projectId).toBe('s-123');
    expect(JSON.parse(await fs.readFile(calls, 'utf8')).create_project).toBe(1);
  });
});
