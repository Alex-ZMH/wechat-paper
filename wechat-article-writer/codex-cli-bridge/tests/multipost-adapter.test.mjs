import { strict as assert } from 'node:assert';
import { createServer as createHttpServer, request } from 'node:http';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createBridgeServer,
  createMultiPostAdapter,
  MultiPostAdapterError,
  MULTIPOST_ADAPTER_SCHEMA_VERSION,
  MULTIPOST_DEFAULT_PORT,
} from '../server.mjs';

function httpJson(port, route, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    let encoded;
    if (body !== undefined) {
      encoded = typeof body === 'string' ? body : JSON.stringify(body);
      requestHeaders['Content-Type'] ??= 'application/json';
      requestHeaders['Content-Length'] = Buffer.byteLength(encoded);
    }
    const req = request({ host: '127.0.0.1', port, path: route, method, headers: requestHeaders }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (encoded !== undefined) req.write(encoded);
    req.end();
  });
}

async function tempConfig() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-multipost-'));
  return {
    directory,
    configPath: path.join(directory, 'multipost-config.v1.json'),
  };
}

async function withMock(handler, callback) {
  const mock = createHttpServer(handler);
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  try { return await callback(mock.address().port); } finally {
    const closed = once(mock, 'close');
    mock.close();
    await closed;
  }
}

async function withBridge(options, callback) {
  const bridge = createBridgeServer({ port: 0, statusProvider: async () => ({ ok: true }), ...options });
  bridge.listen(0, '127.0.0.1');
  await once(bridge, 'listening');
  try { return await callback(bridge.address().port); } finally {
    const closed = once(bridge, 'close');
    bridge.close();
    await closed;
  }
}

test('configuration is atomic and never returns the token', async () => {
  const { configPath } = await tempConfig();
  const token = 'mp-test-secret-001';
  const adapter = createMultiPostAdapter({ configPath });
  assert.deepEqual(await adapter.getConfig(), {
    schemaVersion: MULTIPOST_ADAPTER_SCHEMA_VERSION,
    integration: 'multipost-desktop',
    status: 'not_configured',
    baseUrl: 'http://127.0.0.1:19528',
    configured: false,
    tokenPresent: false,
    source: 'none',
  });
  const saved = await adapter.setConfig({ token });
  assert.equal(saved.configured, true);
  assert.equal(saved.tokenPresent, true);
  assert.equal(saved.source, 'file');
  assert.equal(JSON.stringify(saved).includes(token), false);
  const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(persisted.token, token);
  assert.equal(persisted.schemaVersion, MULTIPOST_ADAPTER_SCHEMA_VERSION);
  assert.equal((await fs.readdir(path.dirname(configPath))).some((name) => name.endsWith('.tmp')), false);
  const deleted = await adapter.deleteConfig();
  assert.equal(deleted.configured, false);
  assert.equal(deleted.source, 'none');
  assert.equal(JSON.stringify(deleted).includes(token), false);
});

test('environment token has precedence and is not persisted or exposed', async () => {
  const { configPath } = await tempConfig();
  const env = { MULTIPOST_DESKTOP_TOKEN: 'env-only-secret' };
  const adapter = createMultiPostAdapter({ configPath, env });
  const status = await adapter.getConfig();
  assert.equal(status.source, 'env');
  assert.equal(status.configured, true);
  assert.equal(JSON.stringify(status).includes('env-only-secret'), false);
});

test('base URL rejects non-loopback hosts and unexpected ports', async () => {
  const { configPath } = await tempConfig();
  const adapter = createMultiPostAdapter({ configPath });
  const localhost = await adapter.setConfig({ token: 'safe-token', baseUrl: 'http://localhost:19528' });
  assert.equal(localhost.baseUrl, 'http://127.0.0.1:19528');
  await assert.rejects(() => adapter.setConfig({ token: 'safe-token', baseUrl: 'http://169.254.169.254:19528' }), (error) => error.code === 'multipost_base_url_invalid' && error.status === 400);
  await assert.rejects(() => adapter.setConfig({ token: 'safe-token', baseUrl: 'http://127.0.0.1:43127' }), (error) => error.code === 'multipost_base_url_invalid' && error.status === 400);
  await assert.rejects(() => adapter.setConfig({ token: 'safe-token', baseUrl: 'http://[::1]:19528' }), (error) => error.code === 'multipost_base_url_invalid' && error.status === 400);
  await assert.rejects(() => adapter.setConfig({ token: 'safe-token', baseUrl: 'https://127.0.0.1:19528' }), (error) => error.code === 'multipost_base_url_invalid' && error.status === 400);
});

test('health reports a stable unavailable error when Desktop is not listening', async () => {
  const { configPath } = await tempConfig();
  const adapter = createMultiPostAdapter({ configPath, baseUrl: 'http://127.0.0.1:1', expectedPort: 1, timeoutMs: 100 });
  await withBridge({ multiPostAdapter: adapter }, async (port) => {
    const response = await httpJson(port, '/v1/integrations/multipost/health');
    assert.equal(response.status, 503);
    assert.equal(response.body.schemaVersion, MULTIPOST_ADAPTER_SCHEMA_VERSION);
    assert.equal(response.body.code, 'multipost_unavailable');
    assert.equal(response.body.stage, 'multipost');
  });
});

test('health/accounts/platforms proxy only safe data and strip credentials', async () => {
  await withMock((req, res) => {
    const hasAuth = req.headers.authorization === 'Bearer local-secret';
    if (req.url === '/v1/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: 'multipost-desktop-api',
        ok: true,
        apiToken: 'must-not-escape',
        diagnostics: { note: 'Bearer local-secret', nested: [{ text: 'local-secret' }] },
        version: '0.3.6',
      }));
      return;
    }
    if (!hasAuth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.url === '/v1/accounts') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accounts: [{
        id: 'a1',
        username: 'owner',
        displayName: '公众号',
        remark: '研发账号',
        isLoggedIn: true,
        isDefault: true,
        supportedContentTypes: ['text', 'markdown'],
        note: 'Bearer local-secret',
        accessToken: 'secret',
        profile: { cookie: 'secret' },
      }] }));
      return;
    }
    if (req.url === '/v1/platforms') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ platforms: [{
        id: 'wechat',
        name: 'wechat',
        displayName: '微信公众号',
        supportedContentTypes: ['text', 'markdown'],
        note: 'local-secret',
        token: 'secret',
      }] }));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  }, async (mockPort) => {
    const { configPath } = await tempConfig();
    const adapter = createMultiPostAdapter({ configPath, baseUrl: `http://127.0.0.1:${mockPort}`, expectedPort: mockPort });
    await adapter.setConfig({ token: 'local-secret' });
    const health = await adapter.health();
    assert.equal(health.status, 'ready');
    assert.equal(health.official.name, 'multipost-desktop-api');
    assert.equal(health.official.diagnostics.note, 'Bearer [已隐藏]');
    assert.equal(health.official.diagnostics.nested[0].text, '[已隐藏]');
    assert.equal(JSON.stringify(health).includes('must-not-escape'), false);
    assert.equal(JSON.stringify(health).includes('local-secret'), false);
    const accounts = await adapter.accounts();
    assert.equal(accounts.count, 1);
    assert.deepEqual(accounts.accounts[0].displayName, '公众号');
    assert.deepEqual(accounts.accounts[0].remark, '研发账号');
    assert.equal(accounts.accounts[0].isLoggedIn, true);
    assert.equal(accounts.accounts[0].isDefault, true);
    assert.deepEqual(accounts.accounts[0].supportedContentTypes, ['text', 'markdown']);
    assert.equal(JSON.stringify(accounts).includes('secret'), false);
    assert.equal(JSON.stringify(accounts).includes('local-secret'), false);
    const platforms = await adapter.platforms();
    assert.equal(platforms.count, 1);
    assert.equal(platforms.platforms[0].displayName, '微信公众号');
    assert.deepEqual(platforms.platforms[0].supportedContentTypes, ['text', 'markdown']);
    assert.equal(JSON.stringify(platforms).includes('secret'), false);
    assert.equal(JSON.stringify(platforms).includes('local-secret'), false);
  });
});

test('health rejects a successful response that is not the official Desktop API', async () => {
  await withMock((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: 'unrelated-local-service' }));
  }, async (mockPort) => {
    const { configPath } = await tempConfig();
    const adapter = createMultiPostAdapter({ configPath, baseUrl: `http://127.0.0.1:${mockPort}`, expectedPort: mockPort });
    await assert.rejects(() => adapter.health(), (error) => error.status === 502 && error.code === 'multipost_invalid_response');
  });
});

test('missing and invalid tokens use stable auth errors', async () => {
  await withMock((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Bearer invalid-token', context: ['invalid-token'] } }));
  }, async (mockPort) => {
    const { configPath } = await tempConfig();
    const noToken = createMultiPostAdapter({ configPath, baseUrl: `http://127.0.0.1:${mockPort}`, expectedPort: mockPort });
    await assert.rejects(() => noToken.accounts(), (error) => error.status === 401 && error.code === 'multipost_token_missing');
    await noToken.setConfig({ token: 'invalid-token' });
    await assert.rejects(() => noToken.accounts(), (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.code, 'multipost_auth_invalid');
      assert.equal(error.message.includes('invalid-token'), false);
      assert.equal(JSON.stringify(error.details ?? {}).includes('invalid-token'), false);
      return true;
    });
    await withBridge({ multiPostAdapter: noToken }, async (bridgePort) => {
      const response = await httpJson(bridgePort, '/v1/integrations/multipost/accounts');
      assert.equal(response.status, 401);
      assert.equal(response.raw.includes('invalid-token'), false);
    });
  });
});

test('authenticated transport errors redact the exact token in nested diagnostics', async () => {
  const { configPath } = await tempConfig();
  const token = 'transport-secret';
  const adapter = createMultiPostAdapter({
    configPath,
    requestJson: async () => {
      throw new MultiPostAdapterError(502, 'multipost_upstream_failed', `upstream ${token}`, {
        message: `Bearer ${token}`,
        nested: [{ text: token }],
      });
    },
  });
  await adapter.setConfig({ token });
  await assert.rejects(() => adapter.accounts(), (error) => {
    assert.equal(error.code, 'multipost_upstream_failed');
    assert.equal(error.message, 'upstream [已隐藏]');
    assert.equal(error.details.message, 'Bearer [已隐藏]');
    assert.equal(error.details.nested[0].text, '[已隐藏]');
    assert.equal(JSON.stringify(error).includes(token), false);
    return true;
  });
  await withBridge({ multiPostAdapter: adapter }, async (bridgePort) => {
    const response = await httpJson(bridgePort, '/v1/integrations/multipost/accounts');
    assert.equal(response.status, 502);
    assert.equal(response.raw.includes(token), false);
  });
});

test('disabled API and zero accounts remain honest and deterministic', async () => {
  await withMock((req, res) => {
    if (req.url === '/v1/health') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accounts: [] }));
    }
  }, async (mockPort) => {
    const { configPath } = await tempConfig();
    const adapter = createMultiPostAdapter({ configPath, baseUrl: `http://127.0.0.1:${mockPort}`, expectedPort: mockPort });
    await adapter.setConfig({ token: 'safe-token' });
    await assert.rejects(() => adapter.health(), (error) => error.status === 503 && error.code === 'multipost_api_disabled');
    const accounts = await adapter.accounts();
    assert.equal(accounts.status, 'no_accounts');
    assert.equal(accounts.code, 'multipost_no_accounts');
    assert.equal(accounts.count, 0);
  });
});

test('official error codes distinguish missing publish/account from a disabled API', async () => {
  await withMock((req, res) => {
    const payload = req.url?.includes('/publish/')
      ? { error: { code: 'publish_not_found' } }
      : req.url === '/v1/accounts'
        ? { data: { error: { code: 'account_not_found' } } }
        : { code: 'api_disabled' };
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }, async (mockPort) => {
    const { configPath } = await tempConfig();
    const adapter = createMultiPostAdapter({ configPath, baseUrl: `http://127.0.0.1:${mockPort}`, expectedPort: mockPort });
    await adapter.setConfig({ token: 'safe-token' });
    await assert.rejects(() => adapter.publishStatus('missing-group'), (error) => error.status === 404 && error.code === 'multipost_publish_not_found');
    await assert.rejects(() => adapter.accounts(), (error) => error.status === 422 && error.code === 'multipost_account_not_found');
    await assert.rejects(() => adapter.platforms(), (error) => error.status === 503 && error.code === 'multipost_api_disabled');
  });
});

test('Bridge exposes only read-only integration routes and never starts publishing', async () => {
  let requests = 0;
  const adapter = {
    getConfig: async () => ({ schemaVersion: MULTIPOST_ADAPTER_SCHEMA_VERSION, integration: 'multipost-desktop', status: 'not_configured', baseUrl: 'http://127.0.0.1:19528', configured: false, tokenPresent: false, source: 'none' }),
    setConfig: async () => { throw new Error('should not be called'); },
    deleteConfig: async () => { throw new Error('should not be called'); },
    health: async () => { requests += 1; return { schemaVersion: MULTIPOST_ADAPTER_SCHEMA_VERSION, integration: 'multipost-desktop', status: 'ready' }; },
    accounts: async () => { throw new Error('should not be called'); },
    platforms: async () => { throw new Error('should not be called'); },
  };
  await withBridge({ multiPostAdapter: adapter }, async (port) => {
    const health = await httpJson(port, '/v1/integrations/multipost/health');
    assert.equal(health.status, 200);
    assert.equal(requests, 1);
    const publish = await httpJson(port, '/v1/integrations/multipost/publish', { method: 'POST', body: { title: 'must never send' } });
    assert.equal(publish.status, 404);
    assert.equal(requests, 1);
    const wrongMethod = await httpJson(port, '/v1/integrations/multipost/health', { method: 'POST', body: {} });
    assert.equal(wrongMethod.status, 405);
    const options = await httpJson(port, '/v1/integrations/multipost/config', { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000' } });
    assert.equal(options.status, 204);
    assert.match(options.headers.allow ?? '', /GET,POST,DELETE,OPTIONS/);
    assert.match(options.headers['access-control-allow-headers'] ?? '', /X-Content-Desk-Adapter/);
    const unknownOptions = await httpJson(port, '/v1/integrations/multipost/publish', { method: 'OPTIONS' });
    assert.equal(unknownOptions.status, 404);
  });
});

test('Bridge config route accepts the shared adapter schema without leaking credentials', async () => {
  const { configPath } = await tempConfig();
  const adapter = createMultiPostAdapter({ configPath });
  await withBridge({ multiPostAdapter: adapter }, async (port) => {
    const token = 'bridge-route-secret';
    const saved = await httpJson(port, '/v1/integrations/multipost/config', {
      method: 'POST',
      body: { schemaVersion: MULTIPOST_ADAPTER_SCHEMA_VERSION, token },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.configured, true);
    assert.equal(saved.body.tokenPresent, true);
    assert.equal(saved.raw.includes(token), false);
    const read = await httpJson(port, '/v1/integrations/multipost/config');
    assert.equal(read.status, 200);
    assert.equal(read.body.source, 'file');
    assert.equal(read.raw.includes(token), false);
    const badSchema = await httpJson(port, '/v1/integrations/multipost/config', {
      method: 'POST',
      body: { schemaVersion: 'multipost-desktop.v0', token },
    });
    assert.equal(badSchema.status, 400);
    assert.equal(badSchema.body.code, 'multipost_schema_invalid');
    assert.equal(badSchema.raw.includes(token), false);
  });
});

test('default adapter contract remains pinned to the expected local port', () => {
  assert.equal(MULTIPOST_DEFAULT_PORT, 19528);
  const adapter = createMultiPostAdapter();
  assert.equal(adapter.adapterSchemaVersion, MULTIPOST_ADAPTER_SCHEMA_VERSION);
});
