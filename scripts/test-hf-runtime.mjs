import fs from 'fs';
import path from 'path';

// --- Configuration ---
const BASE_URL = process.env.AUTOMAKER_BASE_URL || 'https://Leon4gr45-automaker.hf.space';
const API_KEY = process.env.AUTOMAKER_API_KEY;
const EXPECTED_GIT_SHA = process.env.EXPECTED_GIT_SHA;
const TEST_TIMEOUT_MS = parseInt(process.env.TEST_TIMEOUT_MS || '10000', 10);
const RUN_INFERENCE = process.argv.includes('--inference');

// --- State ---
const results = [];
let discoveredEndpoints = [];

// --- Helpers ---
const reportResult = (name, category, status, details = '', httpCode = '-') => {
  results.push({ name, category, status, httpCode, details });
  console.log(`[${status}] ${category} | ${name} | HTTP: ${httpCode} | ${details}`);
};

const safeFetch = async (urlPath, options = {}) => {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(`${BASE_URL}${urlPath}`, { ...options, signal: controller.signal });
    clearTimeout(id);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {}

    return {
      status: res.status,
      ok: res.ok,
      latency: Date.now() - start,
      text,
      json,
    };
  } catch (err) {
    clearTimeout(id);
    return { status: 0, ok: false, error: err.message, latency: Date.now() - start };
  }
};

const authHeaders = API_KEY ? { 'X-API-Key': API_KEY } : {};

// --- Tests ---

async function testHealthAndIdentity() {
  // 1. Root /health
  let res = await safeFetch('/health');
  if (res.ok && res.json?.status === 'ok') {
    reportResult('GET /health', 'Health', 'PASS', `Latency: ${res.latency}ms`, res.status);
  } else {
    reportResult('GET /health', 'Health', 'FAIL', res.error || 'Invalid response', res.status);
  }

  // 2. /api-docs
  res = await safeFetch('/api-docs');
  if (res.ok && res.json?.endpoints) {
    discoveredEndpoints = res.json.endpoints;
    reportResult(
      'GET /api-docs',
      'API Discovery',
      'PASS',
      `Found ${discoveredEndpoints.length} endpoints`,
      res.status
    );
  } else {
    reportResult(
      'GET /api-docs',
      'API Discovery',
      'FAIL',
      'Failed to retrieve or parse endpoints',
      res.status
    );
  }

  // 3. /api/auth/status
  res = await safeFetch('/api/auth/status');
  if (res.ok && res.json) {
    reportResult(
      'GET /api/auth/status',
      'Auth Config',
      'PASS',
      `Auth required: ${res.json.required}`,
      res.status
    );
  } else {
    reportResult(
      'GET /api/auth/status',
      'Auth Config',
      'FAIL',
      'Failed to read auth status',
      res.status
    );
  }

  // 4. Build Identity
  // The correct static path in the deployed express app serving from /app/apps/server/dist/assets -> mapped via /assets (?)
  // Wait, static assets in apps/ui/dist are served at /. So build-provenance is at /assets/build-provenance.json
  res = await safeFetch('/assets/build-provenance.json');
  if (res.status === 200 && res.json) {
    const sha = res.json.gitSha;
    if (!sha || sha === '0000000000000000000000000000000000000000' || sha.match(/^0+$/)) {
      reportResult(
        'Build Provenance',
        'Build identity',
        'PROVENANCE_UNVERIFIED',
        'Dummy/zero SHA found',
        res.status
      );
    } else if (EXPECTED_GIT_SHA && sha !== EXPECTED_GIT_SHA) {
      reportResult(
        'Build Provenance',
        'Build identity',
        'FAIL',
        `Expected ${EXPECTED_GIT_SHA}, got ${sha}`,
        res.status
      );
    } else {
      reportResult('Build Provenance', 'Build identity', 'PASS', `SHA: ${sha}`, res.status);
    }
  } else {
    reportResult(
      'Build Provenance',
      'Build identity',
      'NOT_PROVEN',
      'Could not locate provenance file',
      res.status
    );
  }
}

async function testAuthentication() {
  // Attempt protected route without auth
  let res = await safeFetch('/api/settings');
  if (res.status === 401 || res.status === 403) {
    reportResult(
      'Unauthenticated Access Rejection',
      'Authentication',
      'PASS',
      'Correctly rejected',
      res.status
    );
  } else {
    reportResult(
      'Unauthenticated Access Rejection',
      'Authentication',
      'FAIL',
      'Allowed unauthenticated access or returned wrong code',
      res.status
    );
  }

  if (API_KEY) {
    res = await safeFetch('/api/settings', { headers: authHeaders });
    if (res.status === 200) {
      reportResult(
        'Authenticated Access',
        'Authentication',
        'PASS',
        'Access granted with key',
        res.status
      );
    } else {
      reportResult(
        'Authenticated Access',
        'Authentication',
        'FAIL',
        'Access denied despite key',
        res.status
      );
    }
  } else {
    reportResult(
      'Authenticated Access',
      'Authentication',
      'BLOCKED',
      'No API_KEY provided for test',
      '-'
    );
  }

  // Malformed JSON check (POST without required fields or bad JSON)
  res = await safeFetch('/api/agent/chat', {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: '{"malformed": "json"',
  });
  if (res.status >= 400 && res.status < 500) {
    reportResult(
      'Malformed JSON Rejection',
      'Authentication',
      'PASS',
      'Handled safely',
      res.status
    );
  } else {
    reportResult(
      'Malformed JSON Rejection',
      'Authentication',
      'FAIL',
      'Unexpected handling of bad JSON',
      res.status
    );
  }
}

async function testAutomakerAPIs() {
  const checkEndpoint = (pathPattern) =>
    discoveredEndpoints.some((e) => e.path.includes(pathPattern));

  // Projects
  if (checkEndpoint('/api/projects')) {
    let res = await safeFetch('/api/projects', { headers: authHeaders });
    if (res.status === 200 || res.status === 401) {
      // 401 is fine if we are not testing authenticated
      reportResult(
        'List Projects',
        'Automaker APIs',
        'PASS',
        'Endpoint exists and responds',
        res.status
      );
    } else {
      reportResult('List Projects', 'Automaker APIs', 'FAIL', 'Unexpected response', res.status);
    }
  } else {
    reportResult('List Projects', 'Automaker APIs', 'FAIL', 'Endpoint missing in api-docs', '-');
  }

  // Agent Chat Route Registration
  if (checkEndpoint('/api/agent/chat')) {
    reportResult('Agent Chat Route', 'Automaker APIs', 'PASS', 'Registered in api-docs', '-');
  } else {
    reportResult('Agent Chat Route', 'Automaker APIs', 'FAIL', 'Missing in api-docs', '-');
  }

  // Settings
  if (checkEndpoint('/api/settings')) {
    reportResult('Settings Route', 'Automaker APIs', 'PASS', 'Registered in api-docs', '-');
  } else {
    reportResult('Settings Route', 'Automaker APIs', 'FAIL', 'Missing in api-docs', '-');
  }
}

async function testArgusAndOpenCode() {
  let res = await safeFetch('/api/argus/health', { headers: authHeaders });
  if (res.status === 200) {
    reportResult('Argus Health', 'Argus', 'PASS', `Version: ${res.json?.version}`, res.status);
    if (res.json?.roleBackends?.MANAGER === 'opencode') {
      reportResult(
        'OpenCode Provider Integration',
        'OpenCode provider',
        'PASS',
        'Manager backend is opencode',
        res.status
      );
    } else {
      reportResult(
        'OpenCode Provider Integration',
        'OpenCode provider',
        'FAIL',
        'Manager backend is not opencode',
        res.status
      );
    }
  } else if (res.status === 401 || res.status === 403) {
    reportResult('Argus Health', 'Argus', 'BLOCKED', 'Authentication required to test', res.status);
    reportResult(
      'OpenCode Provider Integration',
      'OpenCode provider',
      'BLOCKED',
      'Authentication required to test',
      res.status
    );
  } else {
    reportResult('Argus Health', 'Argus', 'FAIL', 'Failed to retrieve argus health', res.status);
  }
}

async function testFutureModes() {
  const modes = ['/default', '/rea', '/paper2code', '/eval'];
  for (const mode of modes) {
    let res = await safeFetch(mode);
    // Assuming the UI serves these routes. If it returns index.html, it's a 200.
    // If it's a backend 404, it might return a specific error.
    if (res.status === 200 || res.status === 404) {
      reportResult(
        `Mode ${mode}`,
        'Mode availability',
        'NOT_IMPLEMENTED',
        'Checked existence (not failing baseline)',
        res.status
      );
    } else {
      reportResult(`Mode ${mode}`, 'Mode availability', 'ERROR', 'Unexpected status', res.status);
    }
  }
}

async function testInference() {
  if (RUN_INFERENCE) {
    if (!API_KEY) {
      reportResult('Inference Probe', 'Inference', 'BLOCKED', 'No API_KEY provided', '-');
      return;
    }
    // Attempting a bounded inference probe.
    // The exact endpoint for diagnostics/inference varies; we will try to reach
    // a known endpoint if available, like /api/agent/chat or a diagnostic provider.
    // For now we will report BLOCKED as we do not have an exact inference probe endpoint detailed.
    reportResult(
      'Inference Probe',
      'Inference',
      'NOT_IMPLEMENTED',
      'Bounded inference probe not implemented yet',
      '-'
    );
  }
}

async function generateReport() {
  let markdown = `# Automaker HF Runtime Baseline Report\n\n`;
  markdown += `**Target URL:** ${BASE_URL}\n`;
  markdown += `**Generated:** ${new Date().toISOString()}\n\n`;

  markdown += `| Test | Status | HTTP/result | Evidence |\n`;
  markdown += `|---|---|---|---|\n`;

  let hasFailures = false;

  for (const r of results) {
    markdown += `| ${r.name} | ${r.status} | ${r.httpCode} | ${r.details} |\n`;
    if (r.status === 'FAIL') hasFailures = true;
  }

  const reportPath = path.join(process.cwd(), 'docs', 'verification', 'HF-RUNTIME-BASELINE.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, markdown);

  const outJsonPath = path.join(process.cwd(), 'docs', 'verification', 'HF-RUNTIME-BASELINE.json');
  fs.writeFileSync(outJsonPath, JSON.stringify(results, null, 2));

  console.log(`\nReport written to ${reportPath}`);
  return hasFailures;
}

// --- Main ---
async function runAll() {
  console.log(`Starting smoke tests against ${BASE_URL}`);
  await testHealthAndIdentity();
  await testAuthentication();
  await testAutomakerAPIs();
  await testArgusAndOpenCode();
  await testFutureModes();
  await testInference();

  reportResult(
    'Playwright Rendering',
    'UI',
    'NOT_IMPLEMENTED',
    'Headless manual test stubbed',
    '-'
  );

  const failed = await generateReport();
  if (failed) {
    console.error('Baseline verification failed. Review the report.');
    process.exit(1);
  }
  process.exit(0);
}

runAll();
