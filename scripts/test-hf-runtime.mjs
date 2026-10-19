import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Read-only runtime qualification. No mode selection, task creation or autonomy activation. */
export async function runSmoke({
  baseUrl = process.env.AUTOMAKER_BASE_URL || 'https://Leon4gr45-automaker.hf.space',
  apiKey = process.env.AUTOMAKER_API_KEY,
  projectId = process.env.AUTOMAKER_PROJECT_ID,
  expectedSha = process.env.EXPECTED_GIT_SHA,
  inference = false,
  timeoutMs = Number(process.env.TEST_TIMEOUT_MS || 10000),
} = {}) {
  const target = new URL(baseUrl);
  if (
    !['https:', 'http:'].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new Error('Invalid runtime base URL');
  timeoutMs = Math.min(Math.max(Number.isFinite(timeoutMs) ? timeoutMs : 10000, 100), 15000);
  const results = [];
  const record = (name, status, httpCode, evidence) =>
    results.push({ name, status, httpCode, evidence });
  const headers = apiKey ? { 'X-API-Key': apiKey } : {};
  async function request(route, options = {}, limit = timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    try {
      const response = await fetch(new URL(route, target), {
        ...options,
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.headers.get('content-type')?.includes('application/json'))
        return { status: response.status };
      const reader = response.body.getReader();
      let size = 0;
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 262144) {
          await reader.cancel();
          return { status: response.status };
        }
        chunks.push(Buffer.from(value));
      }
      return { status: response.status, json: JSON.parse(Buffer.concat(chunks).toString()) };
    } catch {
      return { status: 0 };
    } finally {
      clearTimeout(timer);
    }
  }
  const health = await request('/api/health');
  const sha = health.json?.build?.gitSha;
  const knownSha = typeof sha === 'string' && /^(?!0{40}$)[a-f0-9]{40}$/i.test(sha);
  record(
    'Runtime health and identity',
    health.status === 200 &&
      health.json?.status === 'ok' &&
      knownSha &&
      (!expectedSha || expectedSha === sha)
      ? 'PASS'
      : 'FAIL',
    health.status,
    knownSha
      ? { gitSha: sha, matchesExpected: !expectedSha || sha === expectedSha }
      : { identity: 'unverified' }
  );
  const query = new URLSearchParams(projectId ? { projectId } : {}).toString();
  const unauthenticated = await request(`/api/argus/modes?${query}`);
  record(
    'Unauthenticated project API rejection',
    [401, 403].includes(unauthenticated.status) ? 'PASS' : 'FAIL',
    unauthenticated.status,
    'Protected API must reject missing credentials'
  );
  if (!apiKey || !projectId) {
    record(
      'Authenticated project modes',
      'BLOCKED',
      null,
      'AUTOMAKER_API_KEY and AUTOMAKER_PROJECT_ID are required'
    );
  } else {
    for (const [route, validate] of [
      [
        'modes',
        (value) =>
          Array.isArray(value?.modes) &&
          ['default', 'rea', 'paper2code', 'eval'].every((id) =>
            value.modes.some((mode) => mode.id === id)
          ),
      ],
      [
        'mode',
        (value) =>
          ['default', 'rea', 'paper2code', 'eval'].includes(value?.activeMode) &&
          Number.isInteger(value?.revision) &&
          Array.isArray(value?.runs),
      ],
      [
        'mode/gate',
        (value) => value && ['PASS', 'BLOCKED', 'FAIL', 'NOT_PROVEN'].includes(value.verdict),
      ],
    ]) {
      const result = await request(`/api/argus/${route}?${query}`, { headers });
      record(
        `Authenticated project ${route}`,
        [401, 403].includes(result.status)
          ? 'BLOCKED'
          : result.status === 200 && validate(result.json)
            ? 'PASS'
            : 'FAIL',
        result.status,
        'Validated project-scoped JSON response; execution is not qualified by route availability'
      );
    }
  }
  if (inference) {
    if (!apiKey) record('Bounded inference', 'BLOCKED', null, 'AUTOMAKER_API_KEY is required');
    else {
      const result = await request(
        '/api/settings/diagnostics/opencode/inference',
        { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' },
        50000
      );
      const valid =
        result.status === 200 &&
        result.json?.success === true &&
        result.json.result === 'LOCAL_PROBE_OK' &&
        typeof result.json.model === 'string' &&
        result.json.model.includes('/');
      record(
        'Bounded inference',
        [401, 403, 429].includes(result.status) ? 'BLOCKED' : valid ? 'PASS' : 'FAIL',
        result.status,
        valid
          ? 'Genuine text probe completed with deny-all tools and isolated configuration'
          : 'Inference was not proven'
      );
    }
  } else
    record(
      'Bounded inference',
      'NOT_RUN',
      null,
      'Use --inference to invoke one bounded text-only model request'
    );
  // Only fixed messages, validated SHA and numeric HTTP status are recorded. Never serialize response bodies,
  // credentials, project identifiers, provider endpoints, prompts or arbitrary error messages.
  return {
    schemaVersion: 1,
    target: target.origin,
    generatedAt: new Date().toISOString(),
    scope:
      'Authenticated API and optional text inference; does not prove a live Jules engineering cycle',
    conclusion: results.every((item) => item.status === 'PASS' || item.status === 'NOT_RUN')
      ? 'PASS'
      : 'NO_GO',
    results,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runSmoke({ inference: process.argv.includes('--inference') });
  const reportPath = path.resolve(
    process.env.RUNTIME_REPORT_PATH || '/tmp/automaker-hf-runtime.json'
  );
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.conclusion === 'PASS' ? 0 : 1;
}
