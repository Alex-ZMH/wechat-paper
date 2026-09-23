import { request as httpRequest } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The v26 MultiPost adapter keeps token handling and all Desktop HTTP calls in
 * this Bridge process.  The delivery workflow owns the explicit two-stage
 * publish/submit/retry state machine; this module only exposes typed calls to
 * that local API and never writes delivery state itself.
 */
export const MULTIPOST_ADAPTER_SCHEMA_VERSION = 'multipost-desktop.v1';
export const MULTIPOST_DEFAULT_BASE_URL = 'http://127.0.0.1:19528';
export const MULTIPOST_DEFAULT_PORT = 19528;
export const MULTIPOST_CONFIG_FILE_NAME = 'multipost-config.v1.json';
export const MULTIPOST_DEFAULT_TIMEOUT_MS = 3000;
export const MULTIPOST_MAX_TOKEN_CHARS = 4096;
export const MULTIPOST_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const SENSITIVE_KEY = /(?:token|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|api[_-]?key|credential|private[_-]?key)/iu;
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EPIPE',
]);

export class MultiPostAdapterError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'MultiPostAdapterError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(status, code, message, details = undefined) {
  throw new MultiPostAdapterError(status, code, message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value, max = 512) {
  if (typeof value !== 'string') return '';
  // The adapter never sends or returns control characters in a diagnostic.
  return value.replace(/[\u0000-\u001F\u007F]/gu, '').slice(0, max);
}

function resolveLocalAppData(env = process.env) {
  const configured = typeof env.LOCALAPPDATA === 'string' ? env.LOCALAPPDATA.trim() : '';
  if (configured) return path.resolve(configured);
  if (process.platform === 'win32') return path.join(os.homedir(), 'AppData', 'Local');
  const xdg = typeof env.XDG_STATE_HOME === 'string' ? env.XDG_STATE_HOME.trim() : '';
  return xdg ? path.resolve(xdg) : path.join(os.homedir(), '.local', 'state');
}

export function defaultMultiPostConfigPath(env = process.env) {
  return path.join(resolveLocalAppData(env), 'ContentDesk', MULTIPOST_CONFIG_FILE_NAME);
}

/**
 * Restrict every production URL to the local MultiPost Desktop listener.  A
 * caller may pass a test-only expectedPort when its mock server is bound to an
 * ephemeral loopback port; the Bridge itself always leaves it at 19528.  The
 * only accepted host aliases are `localhost` and `127.0.0.1`; IPv6 loopback is
 * deliberately excluded so every outbound request has one canonical target.
 */
export function validateMultiPostBaseUrl(value, { expectedPort = MULTIPOST_DEFAULT_PORT } = {}) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : MULTIPOST_DEFAULT_BASE_URL;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(400, 'multipost_base_url_invalid', 'MultiPost 地址无效');
  }
  const hostname = parsed.hostname.toLowerCase();
  const loopback = hostname === 'localhost'
    || hostname === '127.0.0.1';
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 80;
  if (parsed.protocol !== 'http:' || !loopback || !Number.isInteger(port) || port !== expectedPort
    || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    fail(400, 'multipost_base_url_invalid', 'MultiPost 地址必须是本机预期端口');
  }
  // URL normalisation is useful for comparisons and never retains a token.
  return `http://127.0.0.1:${port}`;
}

function validateToken(value) {
  if (typeof value !== 'string') fail(400, 'multipost_token_invalid', 'MultiPost Token 必须是文本');
  const token = value.trim();
  if (!token) fail(400, 'multipost_token_missing', 'MultiPost Token 不能为空');
  if (token.length > MULTIPOST_MAX_TOKEN_CHARS || /[\u0000-\u001F\u007F]/u.test(token)) {
    fail(400, 'multipost_token_invalid', 'MultiPost Token 格式无效');
  }
  return token;
}

function redactExactToken(value, token) {
  const text = safeText(value, 2000);
  if (typeof token !== 'string' || !token) return text;
  // Avoid a regular expression here: a user token can contain arbitrary
  // punctuation that would otherwise need escaping.  Exact substring
  // replacement also covers values such as `Bearer <token>`.
  return text.split(token).join('[已隐藏]');
}

function sanitize(value, depth = 0, token = undefined) {
  if (depth > 8) return '[已省略]';
  if (typeof value === 'string') return redactExactToken(value, token);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitize(item, depth + 1, token));
  if (!isPlainObject(value)) return undefined;
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 200)) {
    if (SENSITIVE_KEY.test(key) || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    result[redactExactToken(key, token)] = sanitize(item, depth + 1, token);
  }
  return result;
}

function extractCollection(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (!isPlainObject(payload)) return undefined;
  if (Array.isArray(payload[key])) return payload[key];
  if (Array.isArray(payload.items)) return payload.items;
  if (isPlainObject(payload.data) && Array.isArray(payload.data[key])) return payload.data[key];
  if (isPlainObject(payload.data) && Array.isArray(payload.data.items)) return payload.data.items;
  if (Array.isArray(payload.data)) return payload.data;
  return undefined;
}

function statusDetails(response) {
  return { upstreamStatus: Number.isInteger(response?.statusCode) ? response.statusCode : undefined };
}

async function requestJsonViaHttp(url, {
  token = undefined,
  timeoutMs = MULTIPOST_DEFAULT_TIMEOUT_MS,
  method = 'GET',
  body = undefined,
} = {}) {
  return new Promise((resolve, reject) => {
    const encodedBody = body === undefined ? undefined : JSON.stringify(body);
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'ContentDesk-MultiPost-Adapter/1',
    };
    if (encodedBody !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(encodedBody);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    let settled = false;
    let total = 0;
    const chunks = [];
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      settle(reject, new MultiPostAdapterError(400, 'multipost_base_url_invalid', 'MultiPost 地址无效'));
      return;
    }
    const request = httpRequest({
      hostname: parsed.hostname,
      port: parsed.port,
      method,
      path: `${parsed.pathname}${parsed.search}`,
      headers,
      timeout: timeoutMs,
    }, (response) => {
      response.on('data', (chunk) => {
        total += Buffer.byteLength(chunk);
        if (total > MULTIPOST_MAX_RESPONSE_BYTES) {
          response.destroy();
          settle(reject, new MultiPostAdapterError(502, 'multipost_response_too_large', 'MultiPost 响应超出限制'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        if (raw.trim()) {
          try { body = JSON.parse(raw); } catch {
            settle(reject, new MultiPostAdapterError(502, 'multipost_invalid_response', 'MultiPost 返回不是有效 JSON', statusDetails(response)));
            return;
          }
        }
        settle(resolve, { statusCode: response.statusCode ?? 0, headers: response.headers, body });
      });
      response.once('error', (error) => settle(reject, error));
    });
    request.once('error', (error) => settle(reject, error));
    request.once('timeout', () => {
      request.destroy();
      settle(reject, new MultiPostAdapterError(503, 'multipost_unavailable', 'MultiPost Desktop 未响应'));
    });
    if (encodedBody !== undefined) request.write(encodedBody);
    request.end();
  });
}

function normaliseRequestError(error, token = undefined) {
  if (error instanceof MultiPostAdapterError) {
    // A custom requestJson implementation (used by tests or a future native
    // transport) may attach upstream diagnostics.  Keep the stable adapter
    // status/code while redacting the exact Bearer value from every string.
    return new MultiPostAdapterError(
      error.status,
      redactExactToken(error.code, token),
      redactExactToken(error.message, token),
      sanitize(error.details, 0, token),
    );
  }
  if (NETWORK_ERROR_CODES.has(error?.code)) return new MultiPostAdapterError(503, 'multipost_unavailable', 'MultiPost Desktop 未启动或 API 不可达');
  return new MultiPostAdapterError(503, 'multipost_unavailable', 'MultiPost Desktop 请求失败');
}

const OFFICIAL_ERROR_CODES = new Set(['publish_not_found', 'account_not_found', 'api_disabled']);

function extractOfficialErrorCode(value, depth = 0) {
  if (depth > 5 || !isPlainObject(value)) return undefined;
  const direct = [value.code, value.error?.code, value.data?.code, value.data?.error?.code];
  for (const candidate of direct) {
    if (typeof candidate === 'string' && OFFICIAL_ERROR_CODES.has(candidate.trim())) return candidate.trim();
  }
  // Some Desktop builds wrap the payload under `result` or `details`.
  for (const key of ['error', 'data', 'result', 'details']) {
    const nested = extractOfficialErrorCode(value[key], depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function mapUpstreamFailure(response, { requiresAuth = false } = {}) {
  const status = Number(response?.statusCode ?? 0);
  const officialCode = extractOfficialErrorCode(response?.body);
  if (officialCode === 'publish_not_found') {
    return new MultiPostAdapterError(404, 'multipost_publish_not_found', 'MultiPost 发布任务不存在', statusDetails(response));
  }
  if (officialCode === 'account_not_found') {
    return new MultiPostAdapterError(422, 'multipost_account_not_found', 'MultiPost 账号不存在', statusDetails(response));
  }
  if (officialCode === 'api_disabled') {
    return new MultiPostAdapterError(503, 'multipost_api_disabled', 'MultiPost Desktop API 未启用', statusDetails(response));
  }
  if (status === 401 || status === 403) return new MultiPostAdapterError(401, 'multipost_auth_invalid', 'MultiPost Token 无效或已过期', statusDetails(response));
  if (status === 404 || status === 405) return new MultiPostAdapterError(503, 'multipost_api_disabled', 'MultiPost Desktop API 未启用', statusDetails(response));
  if (status === 408 || status === 429) return new MultiPostAdapterError(503, 'multipost_rate_limited', 'MultiPost Desktop 暂时不可用', statusDetails(response));
  if (status >= 500) return new MultiPostAdapterError(503, 'multipost_api_failed', 'MultiPost Desktop API 返回服务错误', statusDetails(response));
  if (status < 200 || status >= 300) return new MultiPostAdapterError(requiresAuth ? 502 : 503, 'multipost_api_failed', 'MultiPost Desktop API 返回错误', statusDetails(response));
  return undefined;
}

function responseEnvelope({ status = 'ready', code = undefined, baseUrl, data = undefined } = {}) {
  return {
    schemaVersion: MULTIPOST_ADAPTER_SCHEMA_VERSION,
    integration: 'multipost-desktop',
    status,
    ...(code ? { code } : {}),
    baseUrl,
    ...(data && isPlainObject(data) ? data : {}),
  };
}

async function readPersistedConfig(filePath, { expectedPort }) {
  try {
    const value = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (!isPlainObject(value) || value.schemaVersion !== MULTIPOST_ADAPTER_SCHEMA_VERSION) {
      fail(500, 'multipost_config_invalid', '本地 MultiPost 配置无效');
    }
    const token = validateToken(value.token);
    const baseUrl = validateMultiPostBaseUrl(value.baseUrl, { expectedPort });
    return { token, baseUrl };
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    if (error instanceof MultiPostAdapterError) {
      // A malformed persisted file is a local configuration fault, not a
      // caller validation fault. Keep this response stable and never expose
      // the invalid value (which could itself contain a secret).
      if (error.code === 'multipost_config_invalid') throw error;
      fail(500, 'multipost_config_invalid', '本地 MultiPost 配置无效');
    }
    fail(500, 'multipost_config_invalid', '本地 MultiPost 配置无效');
  }
}

export function createMultiPostAdapter({
  configPath = defaultMultiPostConfigPath(),
  baseUrl = undefined,
  expectedPort = MULTIPOST_DEFAULT_PORT,
  env = process.env,
  requestJson = requestJsonViaHttp,
  timeoutMs = MULTIPOST_DEFAULT_TIMEOUT_MS,
} = {}) {
  const target = path.resolve(configPath);
  let mutation = Promise.resolve();
  let inMemory = undefined;

  const configuredBaseUrl = () => {
    const fromEnv = typeof env.MULTIPOST_DESKTOP_BASE_URL === 'string' && env.MULTIPOST_DESKTOP_BASE_URL.trim()
      ? env.MULTIPOST_DESKTOP_BASE_URL
      : baseUrl;
    return validateMultiPostBaseUrl(fromEnv || MULTIPOST_DEFAULT_BASE_URL, { expectedPort });
  };

  const snapshot = async () => {
    const envToken = typeof env.MULTIPOST_DESKTOP_TOKEN === 'string' && env.MULTIPOST_DESKTOP_TOKEN.trim()
      ? validateToken(env.MULTIPOST_DESKTOP_TOKEN)
      : undefined;
    const persisted = envToken ? undefined : (inMemory ?? await readPersistedConfig(target, { expectedPort }));
    const token = envToken || persisted?.token;
    const persistedBaseUrl = persisted?.baseUrl;
    const resolvedBaseUrl = validateMultiPostBaseUrl(
      (typeof env.MULTIPOST_DESKTOP_BASE_URL === 'string' && env.MULTIPOST_DESKTOP_BASE_URL.trim())
        ? env.MULTIPOST_DESKTOP_BASE_URL
        : persistedBaseUrl || baseUrl || MULTIPOST_DEFAULT_BASE_URL,
      { expectedPort },
    );
    return {
      token,
      baseUrl: resolvedBaseUrl,
      configured: Boolean(token),
      tokenPresent: Boolean(token),
      source: envToken ? 'env' : token ? 'file' : 'none',
    };
  };

  const writeConfig = ({ token, baseUrl: nextBaseUrl = undefined }) => {
    const task = mutation.then(async () => {
      const next = {
        schemaVersion: MULTIPOST_ADAPTER_SCHEMA_VERSION,
        baseUrl: validateMultiPostBaseUrl(nextBaseUrl || (await snapshot()).baseUrl, { expectedPort }),
        token: validateToken(token),
      };
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
      try {
        await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
      inMemory = next;
      const current = await snapshot();
      return responseEnvelope({
        status: current.configured ? 'configured' : 'not_configured',
        baseUrl: current.baseUrl,
        data: {
          configured: current.configured,
          tokenPresent: current.tokenPresent,
          source: current.source,
        },
      });
    });
    mutation = task.catch(() => {});
    return task;
  };

  const removeConfig = () => {
    const task = mutation.then(async () => {
      inMemory = undefined;
      await fs.rm(target, { force: true }).catch((error) => {
        if (error?.code !== 'ENOENT') throw new MultiPostAdapterError(500, 'multipost_config_delete_failed', 'MultiPost 配置删除失败');
      });
      const current = await snapshot();
      return responseEnvelope({
        status: current.configured ? 'configured' : 'not_configured',
        baseUrl: current.baseUrl,
        data: {
          configured: current.configured,
          tokenPresent: current.tokenPresent,
          source: current.source,
        },
      });
    });
    mutation = task.catch(() => {});
    return task;
  };

  const call = async (endpoint, {
    tokenRequired = false,
    method = 'GET',
    body = undefined,
  } = {}) => {
    const config = await snapshot();
    if (tokenRequired && !config.token) fail(401, 'multipost_token_missing', '尚未配置 MultiPost Token');
    let response;
    try {
      response = await requestJson(new URL(endpoint, `${config.baseUrl}/`).toString(), {
        token: tokenRequired ? config.token : undefined,
        timeoutMs,
        method,
        body,
      });
    } catch (error) {
      throw normaliseRequestError(error, config.token);
    }
    const upstreamFailure = mapUpstreamFailure(response, { requiresAuth: tokenRequired });
    if (upstreamFailure) throw upstreamFailure;
    return { config, response };
  };

  const getConfig = async () => {
    const config = await snapshot();
    return responseEnvelope({
      status: config.configured ? 'configured' : 'not_configured',
      baseUrl: config.baseUrl,
      data: {
        configured: config.configured,
        tokenPresent: config.tokenPresent,
        source: config.source,
      },
    });
  };

  const health = async () => {
    const { config, response } = await call('/v1/health');
    // A 200 from an unrelated local service is not proof that MultiPost is
    // ready.  Require the official Desktop API identity before interpreting
    // any optional readiness flags.
    if (!isPlainObject(response.body) || response.body.name !== 'multipost-desktop-api') {
      fail(502, 'multipost_invalid_response', 'MultiPost 健康响应格式无效');
    }
    const official = sanitize(response.body, 0, config.token);
    const officialRecord = isPlainObject(official) ? official : {};
    if (officialRecord.apiEnabled === false || officialRecord.enabled === false || officialRecord.available === false || officialRecord.ok === false) {
      fail(503, 'multipost_api_disabled', 'MultiPost Desktop API 未启用');
    }
    return responseEnvelope({
      status: 'ready',
      baseUrl: config.baseUrl,
      data: { ok: true, available: true, apiEnabled: true, official },
    });
  };

  const accounts = async () => {
    const { config, response } = await call('/v1/accounts', { tokenRequired: true });
    const list = extractCollection(response.body, 'accounts');
    if (!list) fail(502, 'multipost_invalid_response', 'MultiPost 账户响应格式无效');
    const accountsList = sanitize(list, 0, config.token);
    if (!Array.isArray(accountsList)) fail(502, 'multipost_invalid_response', 'MultiPost 账户响应格式无效');
    const empty = accountsList.length === 0;
    return responseEnvelope({
      status: empty ? 'no_accounts' : 'ready',
      code: empty ? 'multipost_no_accounts' : undefined,
      baseUrl: config.baseUrl,
      data: { ok: true, accounts: accountsList, count: accountsList.length },
    });
  };

  const platforms = async () => {
    const { config, response } = await call('/v1/platforms', { tokenRequired: true });
    const list = extractCollection(response.body, 'platforms');
    if (!list) fail(502, 'multipost_invalid_response', 'MultiPost 平台响应格式无效');
    const platformsList = sanitize(list, 0, config.token);
    if (!Array.isArray(platformsList)) fail(502, 'multipost_invalid_response', 'MultiPost 平台响应格式无效');
    return responseEnvelope({
      status: platformsList.length ? 'ready' : 'no_platforms',
      code: platformsList.length ? undefined : 'multipost_no_platforms',
      baseUrl: config.baseUrl,
      data: { ok: true, platforms: platformsList, count: platformsList.length },
    });
  };

  const validatePathSegment = (value, label) => {
    const segment = typeof value === 'string' ? value.trim() : '';
    if (!segment || segment.length > 256 || /[\u0000-\u001F\u007F/\\]/u.test(segment)) {
      fail(400, 'multipost_path_invalid', `${label} 格式无效`);
    }
    return encodeURIComponent(segment);
  };

  const publish = async (payload) => {
    const { config, response } = await call('/v1/publish', {
      tokenRequired: true,
      method: 'POST',
      body: payload,
    });
    const official = sanitize(response.body, 0, config.token);
    if (!isPlainObject(official)) fail(502, 'multipost_invalid_response', 'MultiPost 发布响应格式无效');
    return responseEnvelope({
      status: 'accepted',
      baseUrl: config.baseUrl,
      data: {
        groupId: typeof official.groupId === 'string' ? official.groupId : undefined,
        upstreamStatus: response.statusCode,
        official,
      },
    });
  };

  const publishStatus = async (groupId) => {
    const segment = validatePathSegment(groupId, 'groupId');
    const { config, response } = await call(`/v1/publish/${segment}`, { tokenRequired: true });
    const official = sanitize(response.body, 0, config.token);
    if (!isPlainObject(official)) fail(502, 'multipost_invalid_response', 'MultiPost 状态响应格式无效');
    return responseEnvelope({
      status: 'polled',
      baseUrl: config.baseUrl,
      data: {
        groupId,
        upstreamStatus: response.statusCode,
        official,
      },
    });
  };

  const submit = async (groupId) => {
    const segment = validatePathSegment(groupId, 'groupId');
    const { config, response } = await call(`/v1/publish/${segment}/submit`, {
      tokenRequired: true,
      method: 'POST',
    });
    const official = sanitize(response.body, 0, config.token);
    if (!isPlainObject(official)) fail(502, 'multipost_invalid_response', 'MultiPost 提交响应格式无效');
    return responseEnvelope({
      status: 'submitted',
      baseUrl: config.baseUrl,
      data: {
        groupId,
        upstreamStatus: response.statusCode,
        official,
      },
    });
  };

  const retryTarget = async (groupId, accountId) => {
    const groupSegment = validatePathSegment(groupId, 'groupId');
    const accountSegment = validatePathSegment(accountId, 'accountId');
    const { config, response } = await call(`/v1/publish/${groupSegment}/targets/${accountSegment}/retry`, {
      tokenRequired: true,
      method: 'POST',
    });
    const official = sanitize(response.body, 0, config.token);
    if (!isPlainObject(official)) fail(502, 'multipost_invalid_response', 'MultiPost 重试响应格式无效');
    return responseEnvelope({
      status: 'retry_accepted',
      baseUrl: config.baseUrl,
      data: {
        groupId,
        accountId,
        upstreamStatus: response.statusCode,
        official,
      },
    });
  };

  return Object.freeze({
    adapterSchemaVersion: MULTIPOST_ADAPTER_SCHEMA_VERSION,
    configPath: target,
    getConfig,
    setConfig: writeConfig,
    deleteConfig: removeConfig,
    health,
    accounts,
    platforms,
    publish,
    publishStatus,
    submit,
    retryTarget,
  });
}

export function multiPostRouteInfo(route) {
  if (route === '/v1/integrations/multipost/config') return { action: 'config', methods: ['GET', 'POST', 'DELETE', 'OPTIONS'] };
  if (route === '/v1/integrations/multipost/health') return { action: 'health', methods: ['GET', 'OPTIONS'] };
  if (route === '/v1/integrations/multipost/accounts') return { action: 'accounts', methods: ['GET', 'OPTIONS'] };
  if (route === '/v1/integrations/multipost/platforms') return { action: 'platforms', methods: ['GET', 'OPTIONS'] };
  if (route === '/v1/integrations/multipost/deliveries') return { action: 'deliveries', methods: ['GET', 'POST', 'OPTIONS'] };
  const prefillRetryMatch = /^\/v1\/integrations\/multipost\/deliveries\/([^/]+)\/retry-prefill$/u.exec(route);
  if (prefillRetryMatch) return { action: 'delivery_retry_prefill', deliveryId: prefillRetryMatch[1], methods: ['POST', 'OPTIONS'] };
  const deliveryMatch = /^\/v1\/integrations\/multipost\/deliveries\/([^/]+)$/u.exec(route);
  if (deliveryMatch) return { action: 'delivery', deliveryId: deliveryMatch[1], methods: ['GET', 'OPTIONS'] };
  const submitMatch = /^\/v1\/integrations\/multipost\/deliveries\/([^/]+)\/submit$/u.exec(route);
  if (submitMatch) return { action: 'delivery_submit', deliveryId: submitMatch[1], methods: ['POST', 'OPTIONS'] };
  const retryMatch = /^\/v1\/integrations\/multipost\/deliveries\/([^/]+)\/targets\/([^/]+)\/retry$/u.exec(route);
  if (retryMatch) return {
    action: 'delivery_retry',
    deliveryId: retryMatch[1],
    accountId: retryMatch[2],
    methods: ['POST', 'OPTIONS'],
  };
  return undefined;
}
