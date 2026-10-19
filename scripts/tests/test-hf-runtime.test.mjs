import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runSmoke } from '../test-hf-runtime.mjs';

const sha = '1234567890abcdef1234567890abcdef12345678';
async function fixture(handler, exercise) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await exercise(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
function runtime(req, res) {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/health')
    return res.end(JSON.stringify({ status: 'ok', build: { gitSha: sha } }));
  if (req.headers['x-api-key'] !== 'fixture-key') {
    res.statusCode = 401;
    return res.end('{}');
  }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/settings/diagnostics/opencode/inference' && req.method === 'POST')
    return res.end(
      JSON.stringify({
        success: true,
        result: 'LOCAL_PROBE_OK',
        model: 'automaker-compatible/model',
      })
    );
  assert.equal(url.searchParams.get('projectId'), 'registered');
  if (url.pathname === '/api/argus/modes')
    return res.end(
      JSON.stringify({ modes: ['default', 'rea', 'paper2code', 'eval'].map((id) => ({ id })) })
    );
  if (url.pathname === '/api/argus/mode')
    return res.end(JSON.stringify({ activeMode: 'rea', revision: 1, runs: [] }));
  if (url.pathname === '/api/argus/mode/gate')
    return res.end(JSON.stringify({ verdict: 'BLOCKED' }));
  res.statusCode = 404;
  res.end('{}');
}
test('uses authoritative identity and real authenticated project APIs, with bounded inference', async () => {
  await fixture(runtime, async (baseUrl) => {
    const report = await runSmoke({
      baseUrl,
      apiKey: 'fixture-key',
      projectId: 'registered',
      expectedSha: sha,
      inference: true,
    });
    assert.equal(report.conclusion, 'PASS');
    assert.equal(report.results.length, 6);
    assert.ok(report.results.every((item) => item.status === 'PASS'));
    const serialized = JSON.stringify(report);
    assert.ok(
      !serialized.includes('fixture-key') &&
        !serialized.includes('registered') &&
        !serialized.includes('automaker-compatible/model')
    );
  });
});
test('SPA fallback and route discovery cannot pass qualification', async () => {
  await fixture(
    (_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<html>SPA</html>');
    },
    async (baseUrl) => {
      const report = await runSmoke({ baseUrl, apiKey: 'fixture-key', projectId: 'registered' });
      assert.equal(report.conclusion, 'NO_GO');
      assert.ok(!report.results.some((item) => item.status === 'PASS'));
    }
  );
});
test('401 and 403 are blocked authenticated operations, never successful inference', async () => {
  for (const code of [401, 403])
    await fixture(
      (req, res) => {
        if (req.url === '/api/health') return runtime(req, res);
        res.setHeader('content-type', 'application/json');
        res.statusCode = code;
        res.end('{"secret":"must not leak"}');
      },
      async (baseUrl) => {
        const report = await runSmoke({
          baseUrl,
          apiKey: 'wrong',
          projectId: 'registered',
          inference: true,
        });
        assert.equal(report.conclusion, 'NO_GO');
        assert.ok(
          report.results
            .filter(
              (item) => item.name.startsWith('Authenticated') || item.name === 'Bounded inference'
            )
            .every((item) => item.status === 'BLOCKED')
        );
        assert.ok(!JSON.stringify(report).includes('must not leak'));
      }
    );
});
test('missing credentials, unknown/mismatched identity and inference failures do not pass', async () => {
  await fixture(runtime, async (baseUrl) => {
    assert.equal((await runSmoke({ baseUrl })).conclusion, 'NO_GO');
    assert.equal(
      (
        await runSmoke({
          baseUrl,
          apiKey: 'fixture-key',
          projectId: 'registered',
          expectedSha: '0'.repeat(40),
        })
      ).conclusion,
      'NO_GO'
    );
  });
  await fixture(
    (req, res) => {
      if (req.url.includes('inference')) {
        res.setHeader('content-type', 'application/json');
        return res.end('{"success":true,"result":"fabricated"}');
      }
      runtime(req, res);
    },
    async (baseUrl) =>
      assert.equal(
        (
          await runSmoke({
            baseUrl,
            apiKey: 'fixture-key',
            projectId: 'registered',
            inference: true,
          })
        ).conclusion,
        'NO_GO'
      )
  );
});
test('redirects and timed out responses fail closed', async () => {
  await fixture(
    (_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://untrusted.invalid');
      res.end();
    },
    async (baseUrl) => {
      assert.equal((await runSmoke({ baseUrl })).conclusion, 'NO_GO');
    }
  );
  await fixture(
    () => {},
    async (baseUrl) => {
      assert.equal((await runSmoke({ baseUrl, timeoutMs: 100 })).conclusion, 'NO_GO');
    }
  );
});
