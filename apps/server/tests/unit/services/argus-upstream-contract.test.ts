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
    `import json, os\nP=os.environ['CALLS']\ndef hit(k,data=None):\n d=json.load(open(P)) if os.path.exists(P) else {}\n d[k]=d.get(k,0)+1\n if data is not None: d[k+'_last']=data\n json.dump(d,open(P,'w'))\nclass ArgusPluginService:\n def create_project(self, workdir: str, *, name: str = ''):\n  hit('create_project',{'workdir':workdir,'name':name})\n  if os.environ.get('CREATE_FAIL') == '1': return {'ok':False,'error':'upstream refused'}\n  return {'ok':True,'project':{'sid':'s-123'}}\n def message(self, *args, **kwargs):\n  hit('message'); raise AssertionError('daemon wrapper used')\n`
  );
  await fs.writeFile(
    path.join(root, 'argus_skill', 'webapi', 'manager_bridge.py'),
    `import json, os\nP=os.environ['CALLS']\ndef hit(k,data=None):\n d=json.load(open(P)) if os.path.exists(P) else {}\n d[k]=d.get(k,0)+1\n if data is not None: d[k+'_last']=data\n json.dump(d,open(P,'w'))\ndef manager_message(sid: str, text: str, *, global_root=None, route_override=None, source_channel=None):\n hit('manager_message',{'sid':sid,'text':text,'global_root':global_root,'route_override':route_override,'source_channel':source_channel})\n if 'fully satisfied' in text:\n  return {'kind':'chat','reply':'\`\`\`json\\n{"satisfied":false,"reasoning":"gap","evidence":["merge"],"remainingGaps":[{"title":"Next","description":"Work","evidence":[]}]}\\n\`\`\`'}\n return {'kind':'chat','reply':'{"admitted":true,"reason":"advances objective","evidence":["spec"],"recommendedExecutor":"junior","needsNextSpec":false}'}\ndef manager_plan(sid: str, text: str, *, global_root=None):\n hit('manager_plan',{'sid':sid,'text':text,'global_root':global_root})\n return {'steps':[{'id':'t-1','title':'Task','detail':'Implement it','acceptance_criteria':['Tests pass'],'evidence_required':['Test output']}],'notes':['planned'],'error':None}\n`
  );
  return { root, calls: path.join(root, 'calls.json') };
}

async function bridge(
  root: string,
  calls: string,
  requests: object[],
  extraEnv: Record<string, string> = {}
) {
  const child = spawn('python3', ['-u', path.resolve('scripts/argus_runtime_bridge.py')], {
    env: { PATH: process.env.PATH!, PYTHONPATH: root, CALLS: calls, ...extraEnv },
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
  return responses as Array<{
    ok: boolean;
    result: Record<string, unknown>;
    error?: { code: string; message: string };
  }>;
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
      {
        requestId: 2,
        operation: 'manager_handoff',
        params: { projectId: 'a', projectPath: root, objective: '# Objective', spec: '# Spec' },
      },
      {
        requestId: 3,
        operation: 'planner_next_task',
        params: {
          projectId: 'a',
          projectPath: root,
          sourceSpecRevision: 1,
          objective: '# Objective',
          spec: '# Spec',
          managerDecision: { admitted: true },
        },
      },
      {
        requestId: 4,
        operation: 'evaluate_objective',
        params: {
          projectId: 'a',
          objective: '# Objective',
          spec: '# Spec',
          evidence: { mergedSha: 'm' },
        },
      },
      {
        requestId: 5,
        operation: 'renew_specification',
        params: {
          projectId: 'a',
          objective: '# Objective',
          spec: '# Spec',
          sourceSpecRevision: 2,
          evaluation: {
            satisfied: false,
            reasoning: 'gap',
            evidence: ['done'],
            remainingGaps: [{ title: 'Next', description: 'Work', evidence: [] }],
          },
        },
      },
      { requestId: 6, operation: 'shutdown', params: {} },
    ]);
    expect(responses, JSON.stringify(responses)).toSatisfy((items) =>
      items.every((response) => response.ok)
    );
    expect(responses[0].result.projectId).toBe('s-123');
    expect(responses[1].result).toMatchObject({ admitted: true, recommendedExecutor: 'junior' });
    expect(responses[3].result).toMatchObject({ satisfied: false, reasoning: 'gap' });
    expect(String(responses[4].result.spec)).toContain('## Planned work');
    expect(String(responses[4].result.spec)).not.toContain('undefined');
    const recorded = JSON.parse(await fs.readFile(calls, 'utf8'));
    expect(recorded).toMatchObject({ create_project: 1, manager_message: 2, manager_plan: 2 });
    expect(recorded.create_project_last).toEqual({ workdir: root, name: 'a' });
    expect(recorded.manager_message_last.route_override).toBe('chat');
    expect(recorded.manager_plan_last.text).toContain('next implementation campaign');
    expect(recorded.message).toBeUndefined();
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

  it('surfaces the real project wrapper failure response', async () => {
    const { root, calls } = await stubPackage();
    const responses = await bridge(
      root,
      calls,
      [
        {
          requestId: 1,
          operation: 'ensure_project',
          params: { projectId: 'a', projectPath: root },
        },
      ],
      { CREATE_FAIL: '1' }
    );
    expect(responses[0]).toMatchObject({
      ok: false,
      error: { code: 'ARGUS_PROJECT_CREATE_FAILED', message: 'upstream refused' },
    });
  });
});
