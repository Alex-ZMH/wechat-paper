import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DeliveryStoreError,
  createDeliveryStore,
} from './delivery-store.mjs';
import { MultiPostAdapterError } from './multipost-adapter.mjs';

export const ASSET_BUNDLE_SCHEMA_VERSION = 'content-desk.asset-bundle.v1';
export const DELIVERY_MANIFEST_SCHEMA_VERSION = 'content-desk.delivery-manifest.v1';
export const DELIVERY_REQUEST_SCHEMA_VERSION = 'content-desk.delivery-request.v1';
export const DELIVERY_RESPONSE_SCHEMA_VERSION = 'content-desk.delivery.v1';
export const DELIVERY_LIST_SCHEMA_VERSION = 'content-desk.delivery-list.v1';
export const DELIVERY_MANIFEST_STATE = 'ready_to_send';
export const DELIVERY_MAX_IMAGES = 100;
export const DELIVERY_MAX_ASSET_CHARS = 4096;
export const DELIVERY_MAX_NAME_CHARS = 256;
export const DELIVERY_MAX_ACCOUNTS = 50;
export const DELIVERY_MAX_ASSET_BYTES = 50 * 1024 * 1024;
export const DELIVERY_MAX_TOTAL_ASSET_BYTES = 200 * 1024 * 1024;

const TEXT_MANIFEST_SCHEMA_VERSION = 'content-desk.export-manifest.v1';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_:-]*$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const TERMINAL_TARGET_STATUSES = new Set(['success', 'failed', 'cancelled']);
const IMAGE_EXTENSIONS = new Set(['.avif', '.gif', '.jpeg', '.jpg', '.png', '.webp']);
const DELIVERY_PUBLIC_MESSAGES = Object.freeze({
  delivery_invalid: '发送请求无效',
  asset_schema_invalid: '素材包版本不受支持',
  asset_missing_cover: '发送前必须提供封面素材',
  asset_invalid: '素材地址无效，仅支持 Windows 盘符绝对文件路径',
  asset_file_not_found: '素材文件不存在或无法读取',
  asset_not_file: '素材必须是普通文件',
  asset_too_large: '素材文件超出大小限制',
  asset_extension_invalid: '素材扩展名不受支持',
  asset_snapshot_failed: '素材快照创建失败',
  asset_name_invalid: '素材名称无效',
  text_manifest_not_ready: '文字清单尚未定稿或仍缺少素材',
  text_manifest_corrupt: '文字清单校验失败',
  delivery_manifest_not_found: '发送清单不存在',
  delivery_manifest_corrupt: '发送清单校验失败',
  delivery_manifest_stale: '发送清单对应的文字版本已变化',
  delivery_not_found: '发送任务不存在',
  delivery_exists: '发送任务已存在',
  delivery_not_ready: '发送任务尚未满足提交条件',
  delivery_confirm_required: '提交发送必须明确 confirm=true',
  delivery_expected_mismatch: '发送任务版本已变化，请刷新后重试',
  delivery_account_not_found: '所选账号不存在',
  delivery_account_not_logged_in: '所选账号未登录',
  delivery_platform_not_found: '所选账号的平台信息不存在',
  delivery_unsupported_content_type: '所选平台不支持 ARTICLE',
  delivery_no_accounts: 'MultiPost 没有可用账号',
  delivery_no_platforms: 'MultiPost 没有可用平台',
  delivery_target_not_failed: '只有失败目标可以重试',
  delivery_store_failed: '发送状态存储失败',
  delivery_store_locked: '发送状态存储正被其他 Bridge 实例使用',
  delivery_event_cas_failed: '发送任务状态已变化，请刷新后重试',
  multipost_invalid_response: 'MultiPost 返回格式无效',
  multipost_publish_failed: 'MultiPost 发布任务创建失败',
  multipost_publish_not_found: 'MultiPost 发布任务不存在',
  multipost_account_not_found: 'MultiPost 账号不存在',
  delivery_prefill_unknown: '预填结果未知，请刷新 MultiPost 后人工核对，禁止重复预填',
  delivery_external_asset_blocked: '外部素材无法冻结，当前版本仅支持本地文件快照',
});

export class DeliveryError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'DeliveryError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(status, code, message = undefined, details = undefined) {
  throw new DeliveryError(status, code, message ?? DELIVERY_PUBLIC_MESSAGES[code] ?? '发送请求失败', details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function safeText(value, max = 512) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARACTERS, '').slice(0, max);
}

function validId(value, label) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id.length > 256 || !SAFE_ID.test(id)) fail(400, 'delivery_invalid', `${label} 格式无效`);
  return id;
}

function ensureKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail(400, 'delivery_invalid', `${label} 必须是对象`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(400, 'delivery_invalid', `${label} 包含不支持的字段`);
  }
}

function digest(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function hashJson(value) {
  return digest(JSON.stringify(canonical(value)));
}

function assetFingerprint(records) {
  return {
    cover: {
      kind: records?.cover?.kind,
      sha256: records?.cover?.sha256,
      bytes: records?.cover?.bytes,
    },
    images: Array.isArray(records?.images)
      ? records.images.map((record) => ({ kind: record?.kind, sha256: record?.sha256, bytes: record?.bytes }))
      : [],
  };
}

function isAbsoluteLocalPath(value) {
  // This helper is used after the Windows drive-prefix gate.  Keeping the
  // host/posix checks here also protects an existing manifest if it was
  // produced by a previous Bridge process.
  if (value.startsWith('\\\\') || value.startsWith('//')) return false;
  return path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function normalizeAsset(value, label) {
  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw || raw.length > DELIVERY_MAX_ASSET_CHARS || CONTROL_CHARACTERS.test(raw)) {
      fail(400, 'asset_invalid', `${label} 地址无效`);
    }
    // v26 freezes every asset into a local snapshot before creating the
    // delivery manifest.  Remote URLs are intentionally deferred to a later
    // version because downloading them here would make provenance mutable.
    if (/^https?:\/\//iu.test(raw)) fail(400, 'asset_invalid', `${label} 仅支持 Windows 盘符绝对文件路径`);
    // Explicitly reject every URI scheme, including file:, data: and blob:.
    // A Windows drive prefix (for example C:\\assets\\cover.jpg) is the
    // only accepted form; relative/POSIX/UNC paths are rejected so the
    // snapshot always has an unambiguous source on the Windows workbench.
    const windowsDrivePath = /^[A-Za-z]:[\\/]/u.test(raw);
    if ((!windowsDrivePath && /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(raw)) || !windowsDrivePath || !isAbsoluteLocalPath(raw)) {
      fail(400, 'asset_invalid', `${label} 仅支持 Windows 盘符绝对文件路径`);
    }
    return raw;
  }
  if (isPlainObject(value)) {
    ensureKeys(value, new Set(['url', 'name']), label);
    // The object form was designed for external references in v25.  Keeping
    // it out of v26 avoids an apparent “frozen” manifest whose bytes can
    // change behind a URL.  Callers must pass a local Windows path string.
    fail(400, 'asset_invalid', `${label} 仅支持 Windows 盘符绝对文件路径`);
  }
  fail(400, 'asset_invalid', `${label} 格式无效`);
}

function normalizeAssetBundle(input) {
  ensureKeys(input, new Set(['schemaVersion', 'cover', 'images']), '素材包');
  if (input.schemaVersion !== ASSET_BUNDLE_SCHEMA_VERSION) fail(400, 'asset_schema_invalid');
  if (input.cover === undefined || input.cover === null || input.cover === '') fail(400, 'asset_missing_cover');
  const cover = normalizeAsset(input.cover, 'cover');
  let images = [];
  if (input.images !== undefined) {
    if (!Array.isArray(input.images) || input.images.length > DELIVERY_MAX_IMAGES) fail(400, 'asset_invalid', 'images 数量超出限制');
    images = input.images.map((item, index) => normalizeAsset(item, `images[${index}]`));
  }
  return { cover, images };
}

function resolveLocalAppData(env = process.env) {
  const configured = typeof env.LOCALAPPDATA === 'string' ? env.LOCALAPPDATA.trim() : '';
  if (configured) return path.resolve(configured);
  if (process.platform === 'win32') return path.join(os.homedir(), 'AppData', 'Local');
  const xdg = typeof env.XDG_STATE_HOME === 'string' ? env.XDG_STATE_HOME.trim() : '';
  return xdg ? path.resolve(xdg) : path.join(os.homedir(), '.local', 'state');
}

function normalizeAssetExtension(value, label) {
  const extension = path.win32.extname(value).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) fail(400, 'asset_extension_invalid', `${label} 扩展名不受支持`);
  return extension;
}

async function inspectAssetFile(filePath, label) {
  normalizeAssetExtension(filePath, label);
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    fail(400, 'asset_file_not_found', `${label} 文件不存在或无法读取`);
  }
  if (!stat.isFile()) fail(400, 'asset_not_file', `${label} 必须是普通文件`);
  if (!Number.isSafeInteger(stat.size) || stat.size > DELIVERY_MAX_ASSET_BYTES) {
    fail(413, 'asset_too_large', `${label} 文件超出大小限制`);
  }
  let hash;
  try {
    hash = createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
  } catch {
    fail(400, 'asset_file_not_found', `${label} 文件不存在或无法读取`);
  }
  return {
    sourcePath: filePath,
    sha256: hash,
    bytes: stat.size,
    mtimeMs: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0,
  };
}

async function freezeAssetFile(record, snapshotRoot, index, label) {
  const extension = path.win32.extname(record.sourcePath).toLowerCase();
  const destination = path.join(snapshotRoot, `${String(index).padStart(3, '0')}-${record.sha256}${extension}`);
  try {
    await fs.copyFile(record.sourcePath, destination);
    const copied = await fs.stat(destination);
    if (!copied.isFile() || copied.size !== record.bytes) throw new Error('snapshot size mismatch');
    const copiedHash = createHash('sha256').update(await fs.readFile(destination)).digest('hex');
    if (copiedHash !== record.sha256) throw new Error('snapshot hash mismatch');
  } catch {
    fail(500, 'asset_snapshot_failed', `${label} 快照创建失败`);
  }
  return destination;
}

async function verifyFrozenAsset(assetPath, record, label) {
  let stat;
  try {
    stat = await fs.stat(assetPath);
  } catch {
    fail(409, 'asset_snapshot_failed', `${label} 快照不存在`);
  }
  if (!stat.isFile() || stat.size !== record.bytes) fail(409, 'asset_snapshot_failed', `${label} 快照已变化`);
  let actual;
  try {
    actual = createHash('sha256').update(await fs.readFile(assetPath)).digest('hex');
  } catch {
    fail(409, 'asset_snapshot_failed', `${label} 快照无法读取`);
  }
  if (actual !== record.sha256) fail(409, 'asset_snapshot_failed', `${label} 快照校验失败`);
}

function normalizeTargetStatus(value) {
  if (typeof value !== 'string') return 'pending';
  const status = value.trim().toLowerCase();
  if (status === 'succeeded') return 'success';
  if (status === 'preparing' || status === 'publishing') return 'filling';
  if (status === 'ready' || status === 'pending' || status === 'filling'
    || status === 'success' || status === 'failed' || status === 'cancelled') return status;
  return 'pending';
}

function normalizeTargetRecord(value, fallbackAccountId) {
  if (!isPlainObject(value)) return { accountId: fallbackAccountId, status: 'pending' };
  const rawId = value.accountId ?? value.id ?? value.account?.id ?? fallbackAccountId;
  const accountId = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : fallbackAccountId;
  const target = {
    accountId,
    status: normalizeTargetStatus(value.status),
  };
  if (typeof value.platform === 'string' && value.platform.trim()) target.platform = safeText(value.platform, 128);
  if (typeof value.postUrl === 'string' && value.postUrl.trim()) target.postUrl = safeText(value.postUrl, DELIVERY_MAX_ASSET_CHARS);
  if (typeof value.error === 'string' && value.error.trim()) target.error = safeText(value.error, 1000);
  return target;
}

function mergeTargets(existing, incoming, accountIds) {
  const byId = new Map((Array.isArray(existing) ? existing : []).map((item) => [item.accountId, item]));
  for (const item of Array.isArray(incoming) ? incoming : []) {
    if (typeof item.accountId !== 'string') continue;
    byId.set(item.accountId, item);
  }
  return accountIds.map((accountId) => byId.get(accountId) ?? { accountId, status: 'pending' });
}

function deriveDeliveryState(targets, phase = 'awaiting_ready') {
  const list = Array.isArray(targets) ? targets : [];
  if (!list.length) return phase;
  const statuses = list.map((target) => target.status);
  if (statuses.every((status) => status === 'success')) return 'succeeded';
  if (statuses.every((status) => status === 'cancelled')) return 'cancelled';
  if (statuses.every((status) => status === 'failed')) return 'failed';
  if (statuses.some((status) => status === 'failed')
    && statuses.every((status) => TERMINAL_TARGET_STATUSES.has(status))) return 'partial_failed';
  if (statuses.some((status) => status === 'cancelled')
    && statuses.every((status) => TERMINAL_TARGET_STATUSES.has(status))) return 'partial_cancelled';
  // Once the human has confirmed submission, a target reported as `ready`
  // still represents an in-flight submit operation.  Do not regress the
  // workflow to ready_to_submit or a second click could call submit twice.
  if (phase === 'submitted_pending' || phase === 'submitting') return phase;
  if (statuses.every((status) => status === 'ready')) return 'ready_to_submit';
  return phase;
}

function extractOfficial(value) {
  if (!isPlainObject(value)) return undefined;
  if (isPlainObject(value.official)) return value.official;
  if (isPlainObject(value.data) && isPlainObject(value.data.official)) return value.data.official;
  return value;
}

function extractOfficialTargets(value, accountIds, { fallback = true } = {}) {
  const official = extractOfficial(value) ?? {};
  const status = isPlainObject(official.status) ? official.status : official;
  const raw = Array.isArray(status.targets)
    ? status.targets
    : Array.isArray(official.targets) ? official.targets : [];
  if (!raw.length && fallback === false) return [];
  const fallbackStatus = typeof status.status === 'string' ? status.status : 'pending';
  const normalized = raw.map((item, index) => normalizeTargetRecord(item, accountIds[index]));
  return accountIds.map((accountId) => {
    const matched = normalized.find((item) => item.accountId === accountId);
    return matched ?? { accountId, status: normalizeTargetStatus(fallbackStatus) };
  });
}

function extractGroupId(value) {
  const official = extractOfficial(value);
  const groupId = official?.groupId ?? official?.taskId ?? official?.status?.groupId;
  return typeof groupId === 'string' && SAFE_ID.test(groupId.trim()) ? groupId.trim() : undefined;
}

function normalizeAdapterError(error) {
  if (error instanceof DeliveryError) return error;
  if (error instanceof MultiPostAdapterError) {
    const code = typeof error.code === 'string' ? error.code : 'multipost_publish_failed';
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 502;
    const details = isPlainObject(error.details) && Number.isInteger(error.details.upstreamStatus)
      ? { upstreamStatus: error.details.upstreamStatus }
      : undefined;
    return new DeliveryError(status, code, DELIVERY_PUBLIC_MESSAGES[code] ?? 'MultiPost Desktop 请求失败', details);
  }
  if (error instanceof DeliveryStoreError) {
    return new DeliveryError(error.status ?? 500, error.code ?? 'delivery_store_failed', DELIVERY_PUBLIC_MESSAGES[error.code] ?? '发送状态存储失败');
  }
  if (error?.code && typeof error.code === 'string' && Number.isInteger(error.status)) {
    return new DeliveryError(error.status, error.code, DELIVERY_PUBLIC_MESSAGES[error.code] ?? '发送请求失败');
  }
  return new DeliveryError(502, 'multipost_publish_failed', 'MultiPost Desktop 请求失败');
}

function isDefinitePrefillFailure(error) {
  const status = Number(error?.status);
  // A concrete 4xx response means Desktop rejected the request before a group
  // could be created.  Timeouts, throttling and transport/5xx failures remain
  // uncertain because the request may have reached Desktop despite no reply.
  return Number.isInteger(status) && status >= 400 && status < 500
    && ![408, 425, 429].includes(status);
}

function prefillUnknownError() {
  return {
    code: 'delivery_prefill_unknown',
    message: DELIVERY_PUBLIC_MESSAGES.delivery_prefill_unknown,
  };
}

function publicDelivery(value, eventCount = undefined) {
  const response = {
    schemaVersion: DELIVERY_RESPONSE_SCHEMA_VERSION,
    deliveryId: value.deliveryId,
    deliveryManifestId: value.deliveryManifestId,
    sourceManifestId: value.sourceManifestId,
    documentId: value.documentId,
    revisionId: value.revisionId,
    contentHash: value.contentHash,
    contentType: value.contentType,
    accountIds: [...value.accountIds],
    ...(typeof value.attemptOfDeliveryId === 'string' ? { attemptOfDeliveryId: value.attemptOfDeliveryId } : {}),
    groupId: value.groupId ?? null,
    state: value.state,
    targets: cloneJson(value.targets ?? []),
    upstreamStatus: value.upstreamStatus ?? null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (value.error) response.error = cloneJson(value.error);
  if (Number.isInteger(eventCount)) response.eventCount = eventCount;
  return response;
}

function reduceDelivery(events, deliveryId) {
  let value;
  let eventCount = 0;
  for (const event of events) {
    if (!isPlainObject(event) || event.deliveryId !== deliveryId) continue;
    eventCount += 1;
    if (event.type === 'delivery_created' && isPlainObject(event.delivery)) {
      value = {
        ...cloneJson(event.delivery),
        targets: cloneJson(event.delivery.targets ?? []),
      };
      continue;
    }
    if (!value) continue;
    // A status response can arrive after an operation intent was persisted
    // (for example, a poll started just before submit/retry acquired the
    // delivery lock).  It must not overwrite an in-flight or uncertain
    // operation state and create a second-call path after a restart.
    if (event.type === 'status_polled'
      && ['submitting', 'retrying', 'prefill_unknown', 'submit_unknown', 'target_retry_unknown'].includes(value.state)) {
      continue;
    }
    if (event.type === 'publish_accepted') {
      value.groupId = event.groupId;
      value.state = event.state ?? 'awaiting_ready';
      value.targets = mergeTargets(value.targets, event.targets, value.accountIds);
      value.upstreamStatus = Number.isInteger(event.upstreamStatus) ? event.upstreamStatus : value.upstreamStatus;
      value.updatedAt = event.createdAt;
    } else if (event.type === 'submit_requested') {
      value.state = 'submitting';
      value.operationKind = 'submit';
      value.updatedAt = event.createdAt;
      value.error = undefined;
    } else if (event.type === 'submit_unknown') {
      value.state = 'submit_unknown';
      value.operationKind = 'submit';
      value.error = cloneJson(event.error);
      value.updatedAt = event.createdAt;
    } else if (event.type === 'prefill_unknown') {
      value.state = 'prefill_unknown';
      value.operationKind = 'prefill';
      value.error = cloneJson(event.error);
      value.updatedAt = event.createdAt;
    } else if (event.type === 'target_retry_requested') {
      value.state = 'retrying';
      value.operationKind = 'target_retry';
      value.retryingAccountId = event.accountId;
      value.targets = mergeTargets(value.targets, [{ accountId: event.accountId, status: 'pending' }], value.accountIds);
      value.error = undefined;
      value.updatedAt = event.createdAt;
    } else if (event.type === 'target_retry_unknown') {
      value.state = 'target_retry_unknown';
      value.operationKind = 'target_retry';
      value.retryingAccountId = event.accountId;
      value.error = cloneJson(event.error);
      value.updatedAt = event.createdAt;
    } else if (event.type === 'status_polled' || event.type === 'submit_accepted' || event.type === 'retry_accepted') {
      value.state = event.state ?? value.state;
      value.targets = mergeTargets(value.targets, event.targets, value.accountIds);
      value.upstreamStatus = Number.isInteger(event.upstreamStatus) ? event.upstreamStatus : value.upstreamStatus;
      value.updatedAt = event.createdAt;
      if (event.type === 'submit_accepted') {
        value.operationKind = 'submit';
        value.error = undefined;
      } else if (event.type === 'retry_accepted') {
        value.operationKind = 'target_retry';
        value.retryingAccountId = event.accountId;
        value.error = undefined;
      }
      if (event.type === 'status_polled') {
        const trackedAccountId = value.retryingAccountId;
        const trackedTarget = trackedAccountId
          ? value.targets.find((target) => target.accountId === trackedAccountId)
          : undefined;
        if (value.operationKind === 'target_retry' && trackedTarget
          && TERMINAL_TARGET_STATUSES.has(trackedTarget.status)) {
          value.operationKind = undefined;
          value.retryingAccountId = undefined;
        }
        if (value.operationKind === 'submit' && value.state === 'succeeded') value.operationKind = undefined;
        if (!['prefill_unknown', 'submit_unknown', 'target_retry_unknown'].includes(value.state)) value.error = undefined;
      }
    } else if (event.type === 'delivery_failed') {
      value.state = 'failed';
      value.error = cloneJson(event.error);
      value.updatedAt = event.createdAt;
    }
  }
  return value ? { value, eventCount } : undefined;
}

function deliveryKey(value) {
  return `${value.deliveryManifestId}\u0000${value.contentType}\u0000${[...value.accountIds].sort().join(',')}`;
}

function decodeSegment(value, label) {
  try {
    return validId(decodeURIComponent(value), label);
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    fail(400, 'delivery_invalid', `${label} 格式无效`);
  }
}

function textManifestIdFromPackage(value) {
  return validId(value.sourceManifestId, 'sourceManifestId');
}

export function deliveryRouteInfo(route) {
  if (route === '/v1/exports') return undefined;
  const assets = /^\/v1\/exports\/([^/]+)\/assets$/u.exec(route);
  if (assets) return { action: 'assets', manifestId: assets[1], methods: ['POST', 'OPTIONS'] };
  const text = /^\/v1\/exports\/([^/]+)$/u.exec(route);
  if (text) return { action: 'export', manifestId: text[1], methods: ['GET', 'OPTIONS'] };
  const deliveryManifest = /^\/v1\/delivery-manifests\/([^/]+)$/u.exec(route);
  if (deliveryManifest) return { action: 'delivery_manifest', deliveryManifestId: deliveryManifest[1], methods: ['GET', 'OPTIONS'] };
  return undefined;
}

export function createMultiPostDeliveryManager({
  contentStore,
  adapter,
  deliveryStore = undefined,
  deliveryStorePath = undefined,
  deliveryStoreEnv = undefined,
  assetSnapshotRoot = undefined,
  assetEnv = process.env,
} = {}) {
  if (!contentStore || typeof contentStore.getExportManifestById !== 'function') {
    throw new TypeError('contentStore.getExportManifestById is required');
  }
  if (!adapter) throw new TypeError('MultiPost adapter is required');
  const store = deliveryStore ?? createDeliveryStore({ filePath: deliveryStorePath, env: deliveryStoreEnv });
  const snapshotRoot = path.resolve(assetSnapshotRoot ?? path.join(resolveLocalAppData(assetEnv), 'ContentDesk', 'delivery-assets'));

  const readEvents = () => store.readEvents();
  const append = async (event) => {
    try {
      return await store.append(event);
    } catch (error) {
      if (error instanceof DeliveryStoreError) throw normalizeAdapterError(error);
      throw new DeliveryError(500, 'delivery_store_failed', DELIVERY_PUBLIC_MESSAGES.delivery_store_failed);
    }
  };

  const getTextManifest = async (manifestId) => {
    const id = validId(manifestId, 'manifestId');
    let manifest;
    try {
      manifest = await contentStore.getExportManifestById(id);
    } catch (error) {
      if (error?.status === 404 || error?.code === 'manifest_not_found') fail(404, 'delivery_manifest_not_found');
      if (error?.status && error?.code) throw new DeliveryError(error.status, error.code, DELIVERY_PUBLIC_MESSAGES[error.code] ?? '文字清单读取失败');
      throw error;
    }
    if (!manifest) fail(404, 'delivery_manifest_not_found');
    if (manifest.schemaVersion !== TEXT_MANIFEST_SCHEMA_VERSION
      || typeof manifest.title !== 'string'
      || !manifest.title.trim()
      || typeof manifest.text !== 'string'
      || !manifest.text.trim()
      || typeof manifest.contentHash !== 'string'
      || digest(manifest.text) !== manifest.contentHash) {
      fail(500, 'text_manifest_corrupt');
    }
    if (manifest.contentStatus !== 'assets_pending') fail(409, 'text_manifest_not_ready');
    return cloneJson(manifest);
  };

  const getDeliveryManifest = async (deliveryManifestId) => {
    const id = validId(deliveryManifestId, 'deliveryManifestId');
    const events = await readEvents();
    const event = events.find((item) => item.type === 'delivery_manifest_created'
      && item.deliveryManifest?.deliveryManifestId === id);
    if (!event) fail(404, 'delivery_manifest_not_found');
    const value = cloneJson(event.deliveryManifest);
    if (value.schemaVersion !== DELIVERY_MANIFEST_SCHEMA_VERSION
      || value.state !== DELIVERY_MANIFEST_STATE
      || typeof value.content?.title !== 'string'
      || !value.content.title.trim()
      || typeof value.content?.markdownContent !== 'string'
      || !value.content.markdownContent.trim()
      || digest(value.content.markdownContent) !== value.contentHash
      || !isPlainObject(value.assetRecords)
      || hashJson(assetFingerprint(value.assetRecords)) !== value.assetsHash) fail(500, 'delivery_manifest_corrupt');
    return value;
  };

  let assetsMutation = Promise.resolve();
  const createAssets = (sourceManifestId, input) => {
    const task = assetsMutation.then(async () => {
      const source = await getTextManifest(sourceManifestId);
      const normalized = normalizeAssetBundle(input);
      const coverRecord = await inspectAssetFile(normalized.cover, 'cover');
      const imageRecords = await Promise.all(normalized.images.map((item, index) => inspectAssetFile(item, `images[${index}]`)));
      const totalBytes = coverRecord.bytes + imageRecords.reduce((sum, item) => sum + item.bytes, 0);
      if (!Number.isSafeInteger(totalBytes) || totalBytes > DELIVERY_MAX_TOTAL_ASSET_BYTES) {
        fail(413, 'asset_too_large', '素材总大小超出限制');
      }
      // The idempotency hash describes the bytes, not the eventual snapshot
      // paths.  Re-registering the same source snapshot therefore resolves to
      // the same immutable delivery manifest even when the destination folder
      // is named by a random manifest id.
      const assetRecords = {
        cover: { kind: 'local_file', sha256: coverRecord.sha256, bytes: coverRecord.bytes, mtimeMs: coverRecord.mtimeMs },
        images: imageRecords.map((record) => ({ kind: 'local_file', sha256: record.sha256, bytes: record.bytes, mtimeMs: record.mtimeMs })),
      };
      const assetsHash = hashJson(assetFingerprint(assetRecords));
      // A double click should not create two immutable delivery manifests for
      // the same text snapshot and asset bundle.  The event log remains the
      // source of truth; this check is intentionally before the append so the
      // previously created id is returned unchanged.  The serialized queue
      // also closes the race between two clicks in the same Bridge process.
      const prior = (await readEvents()).find((event) => event.type === 'delivery_manifest_created'
        && event.deliveryManifest?.sourceManifestId === source.manifestId
        && event.deliveryManifest?.assetsHash === assetsHash);
      if (prior?.deliveryManifest) return cloneJson(prior.deliveryManifest);
      const now = new Date().toISOString();
      const deliveryManifestId = randomUUID();
      const targetDirectory = path.join(snapshotRoot, deliveryManifestId);
      try {
        await fs.mkdir(targetDirectory, { recursive: true });
      } catch {
        fail(500, 'asset_snapshot_failed', '素材快照目录创建失败');
      }
      let frozenAssets;
      try {
        frozenAssets = {
          cover: await freezeAssetFile(coverRecord, targetDirectory, 0, 'cover'),
          images: await Promise.all(imageRecords.map((record, index) => freezeAssetFile(record, targetDirectory, index + 1, `images[${index}]`))),
        };
      } catch (error) {
        await fs.rm(targetDirectory, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      const value = {
        schemaVersion: DELIVERY_MANIFEST_SCHEMA_VERSION,
        deliveryManifestId,
        sourceManifestId: source.manifestId,
        documentId: source.documentId,
        revisionId: source.revisionId,
        contentHash: source.contentHash,
        assetsHash,
        content: {
          title: typeof source.title === 'string' ? source.title : '',
          markdownContent: source.text,
        },
        assets: frozenAssets,
        assetRecords,
        state: DELIVERY_MANIFEST_STATE,
        createdAt: now,
      };
      try {
        await append({ type: 'delivery_manifest_created', deliveryManifest: value });
      } catch (error) {
        await fs.rm(targetDirectory, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return cloneJson(value);
    });
    assetsMutation = task.catch(() => {});
    return task;
  };

  const listCurrentDeliveries = async () => {
    const events = await readEvents();
    const ids = [...new Set(events.filter((event) => event.type === 'delivery_created' && typeof event.deliveryId === 'string')
      .map((event) => event.deliveryId))];
    return ids.map((id) => {
      const reduced = reduceDelivery(events, id);
      return reduced ? publicDelivery(reduced.value, reduced.eventCount) : undefined;
    }).filter(Boolean).sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
  };

  const findByKey = async (key) => {
    const deliveries = await listCurrentDeliveries();
    return deliveries.find((item) => deliveryKey(item) === key);
  };

  const validateDeliveryManifestFreshness = async (value) => {
    if (value.schemaVersion !== DELIVERY_MANIFEST_SCHEMA_VERSION || value.state !== DELIVERY_MANIFEST_STATE) fail(409, 'delivery_manifest_corrupt');
    if (typeof value.content?.title !== 'string' || !value.content.title.trim()
      || typeof value.content?.markdownContent !== 'string' || !value.content.markdownContent.trim()
      || digest(value.content.markdownContent) !== value.contentHash
      || !isPlainObject(value.assetRecords)
      || hashJson(assetFingerprint(value.assetRecords)) !== value.assetsHash) fail(500, 'delivery_manifest_corrupt');
    const verifyPath = (assetPath, label) => {
      if (typeof assetPath !== 'string' || !isAbsoluteLocalPath(assetPath)) fail(500, 'delivery_manifest_corrupt');
      const root = path.resolve(snapshotRoot);
      const resolved = path.resolve(assetPath);
      const relative = path.relative(root, resolved);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail(500, 'delivery_manifest_corrupt');
      return resolved;
    };
    const coverRecord = value.assetRecords.cover;
    if (!isPlainObject(coverRecord) || coverRecord.kind !== 'local_file') fail(500, 'delivery_manifest_corrupt');
    await verifyFrozenAsset(verifyPath(value.assets?.cover, 'cover'), coverRecord, 'cover');
    const imageRecords = Array.isArray(value.assetRecords.images) ? value.assetRecords.images : [];
    const imageAssets = Array.isArray(value.assets?.images) ? value.assets.images : undefined;
    if (!imageAssets || imageAssets.length !== imageRecords.length) fail(500, 'delivery_manifest_corrupt');
    for (let index = 0; index < imageRecords.length; index += 1) {
      const record = imageRecords[index];
      if (!isPlainObject(record) || record.kind !== 'local_file') fail(500, 'delivery_manifest_corrupt');
      await verifyFrozenAsset(verifyPath(imageAssets[index], `images[${index}]`), record, `images[${index}]`);
    }
    const source = await getTextManifest(textManifestIdFromPackage(value));
    const sourceTitle = typeof source.title === 'string' ? source.title : '';
    if (source.contentHash !== value.contentHash || source.text !== value.content.markdownContent || sourceTitle !== value.content.title) fail(409, 'delivery_manifest_stale');
    return source;
  };

  const accountList = (value, key) => {
    if (Array.isArray(value?.[key])) return value[key];
    if (Array.isArray(value?.official?.[key])) return value.official[key];
    return [];
  };

  const validateTargets = async (accountIds) => {
    let accountsResponse;
    let platformsResponse;
    try {
      accountsResponse = await adapter.accounts();
      platformsResponse = await adapter.platforms();
    } catch (error) {
      throw normalizeAdapterError(error);
    }
    const accounts = accountList(accountsResponse, 'accounts');
    const platforms = accountList(platformsResponse, 'platforms');
    if (!accounts.length) fail(409, 'delivery_no_accounts');
    if (!platforms.length) fail(409, 'delivery_no_platforms');
    return accountIds.map((accountId) => {
      const account = accounts.find((item) => String(item?.id ?? '') === accountId);
      if (!account) fail(422, 'delivery_account_not_found');
      if (account.isLoggedIn !== true) fail(409, 'delivery_account_not_logged_in');
      const platformId = account.platform ?? account.platformId ?? account.platformName;
      const platform = platforms.find((item) => String(item?.id ?? '') === String(platformId ?? '')
        || String(item?.name ?? '') === String(platformId ?? '')
        || String(item?.platform ?? '') === String(platformId ?? ''));
      if (!platform) fail(422, 'delivery_platform_not_found');
      if (!Array.isArray(platform.supportedContentTypes) || !platform.supportedContentTypes.includes('ARTICLE')) {
        fail(422, 'delivery_unsupported_content_type');
      }
      return { accountId, platform: typeof platform.id === 'string' ? platform.id : platformId };
    });
  };

  const normalizeRequest = (input) => {
    ensureKeys(input, new Set(['schemaVersion', 'deliveryManifestId', 'accountIds', 'contentType']), '发送请求');
    if (input.schemaVersion !== DELIVERY_REQUEST_SCHEMA_VERSION) fail(400, 'delivery_invalid', '发送请求 schemaVersion 无效');
    const deliveryManifestId = validId(input.deliveryManifestId, 'deliveryManifestId');
    if (!Array.isArray(input.accountIds) || input.accountIds.length < 1 || input.accountIds.length > DELIVERY_MAX_ACCOUNTS) fail(400, 'delivery_invalid', 'accountIds 数量无效');
    const accountIds = input.accountIds.map((value, index) => validId(value, `accountIds[${index}]`));
    if (new Set(accountIds).size !== accountIds.length) fail(400, 'delivery_invalid', 'accountIds 不得重复');
    if (input.contentType !== 'ARTICLE') fail(400, 'delivery_invalid', '当前只支持 ARTICLE');
    return { deliveryManifestId, accountIds, contentType: 'ARTICLE' };
  };

  let deliveryMutation = Promise.resolve();
  const deliveryLocks = new Map();
  // In-process fast path for a second request arriving while the first
  // upstream call is still open.  The persisted intent remains authoritative
  // across restarts; this map only avoids making the second caller wait for a
  // network timeout in the common same-process case.
  const deliveryInflight = new Map();
  const withDeliveryLock = (deliveryId, operation) => {
    const previous = deliveryLocks.get(deliveryId) ?? Promise.resolve();
    const task = previous.then(operation, operation);
    let slot;
    slot = task.finally(() => {
      if (deliveryLocks.get(deliveryId) === slot) deliveryLocks.delete(deliveryId);
    });
    // Store the same promise that the cleanup compares.  Attach a detached
    // rejection handler so a failed operation does not become an unhandled
    // rejection merely because the lock map retains it briefly.
    slot.catch(() => {});
    deliveryLocks.set(deliveryId, slot);
    return task;
  };

  const commitOperationIntent = async (deliveryId, expectedEventCount, event, expectedState) => {
    let appended;
    try {
      appended = await append({ ...event, expectedEventCount });
    } catch (error) {
      if (error instanceof DeliveryError && error.code === 'delivery_event_cas_failed') return undefined;
      throw error;
    }
    const events = await readEvents();
    const reduced = reduceDelivery(events, deliveryId);
    // Do not compare the global event-list length here: another delivery may
    // legitimately append a poll event between our CAS write and this read.
    // The store's eventId and this delivery's reduced state are the only
    // confirmation needed for this operation intent.
    const persistedIntent = appended?.eventId
      ? events.find((item) => item.eventId === appended.eventId
        && item.deliveryId === deliveryId
        && item.type === event.type)
      : undefined;
    // Verify ownership against the event log prefix ending at our own intent,
    // not against the latest same-delivery state.  A concurrent poll may have
    // appended an unrelated status event after our CAS append; that later
    // event must not make this caller believe another process won the intent.
    const intentIndex = persistedIntent ? events.findIndex((item) => item.eventId === persistedIntent.eventId) : -1;
    const reducedAtIntent = intentIndex >= 0
      ? reduceDelivery(events.slice(0, intentIndex + 1), deliveryId)
      : undefined;
    if (!reducedAtIntent || reducedAtIntent.value.state !== expectedState) {
      // Another Bridge process may have won the operation race.  Returning
      // false tells the caller to expose the persisted state and never make a
      // second upstream call.
      return undefined;
    }
    return reduced;
  };

  const createDelivery = (input, { retryFromDeliveryId = undefined } = {}) => {
    const task = deliveryMutation.then(async () => {
      const request = normalizeRequest(input);
    const manifest = await getDeliveryManifest(request.deliveryManifestId);
    await validateDeliveryManifestFreshness(manifest);
    const key = deliveryKey(request);
    const existing = await findByKey(key);
    if (existing && !(retryFromDeliveryId
      && existing.deliveryId === retryFromDeliveryId
      && existing.state === 'failed'
      && !existing.groupId)) return existing;
    const targetMetadata = await validateTargets(request.accountIds);
    const deliveryId = randomUUID();
    const createdAt = new Date().toISOString();
    if (retryFromDeliveryId) {
      await append({
        type: 'prefill_retry_requested',
        deliveryId: retryFromDeliveryId,
        newDeliveryId: deliveryId,
      });
    }
    const initialTargets = targetMetadata.map(({ accountId, platform }) => ({ accountId, platform, status: 'pending' }));
    await append({
      type: 'delivery_created',
      deliveryId,
      delivery: {
        deliveryId,
        deliveryManifestId: manifest.deliveryManifestId,
        sourceManifestId: manifest.sourceManifestId,
        documentId: manifest.documentId,
        revisionId: manifest.revisionId,
        contentHash: manifest.contentHash,
        contentType: request.contentType,
        accountIds: request.accountIds,
        ...(retryFromDeliveryId ? { attemptOfDeliveryId: retryFromDeliveryId } : {}),
        groupId: null,
        state: 'publishing',
        targets: initialTargets,
        upstreamStatus: null,
        createdAt,
        updatedAt: createdAt,
      },
    });
    // Account/platform preflight can take time.  Re-check the frozen file
    // hashes immediately before constructing the upstream payload so a local
    // snapshot tamper between registration and this call is blocked at the
    // last safe point; the text/source freshness guard is repeated as well.
    try {
      await validateDeliveryManifestFreshness(manifest);
    } catch (error) {
      const normalized = error instanceof DeliveryError ? error : new DeliveryError(409, 'asset_snapshot_failed', '素材快照校验失败');
      await append({
        type: 'delivery_failed',
        deliveryId,
        error: { code: normalized.code, message: DELIVERY_PUBLIC_MESSAGES[normalized.code] ?? '素材快照校验失败' },
      }).catch(() => {});
      throw normalized;
    }
    const publishPayload = {
      contentType: 'ARTICLE',
      accountIds: [...request.accountIds],
      autoSubmit: false,
      data: {
        title: manifest.content.title,
        markdownContent: manifest.content.markdownContent,
        cover: manifest.assets.cover,
        images: manifest.assets.images,
      },
    };
    let response;
    try {
      response = await adapter.publish(publishPayload);
    } catch (error) {
      const normalized = normalizeAdapterError(error);
      if (isDefinitePrefillFailure(normalized)) {
        await append({
          type: 'delivery_failed',
          deliveryId,
          error: { code: normalized.code, message: DELIVERY_PUBLIC_MESSAGES[normalized.code] ?? 'MultiPost Desktop 请求失败' },
        }).catch(() => {});
      } else {
        await append({
          type: 'prefill_unknown',
          deliveryId,
          error: prefillUnknownError(),
          upstreamStatus: normalized.details?.upstreamStatus,
        }).catch(() => {});
      }
      throw normalized;
    }
    const groupId = extractGroupId(response);
    if (!groupId) {
      const normalized = new DeliveryError(502, 'multipost_invalid_response', 'MultiPost 返回格式无效');
      await append({
        type: 'prefill_unknown',
        deliveryId,
        error: prefillUnknownError(),
      }).catch(() => {});
      throw normalized;
    }
    const targets = mergeTargets(initialTargets, extractOfficialTargets(response, request.accountIds), request.accountIds);
    await append({
      type: 'publish_accepted',
      deliveryId,
      groupId,
      state: deriveDeliveryState(targets, 'awaiting_ready'),
      targets,
      upstreamStatus: Number.isInteger(response?.upstreamStatus) ? response.upstreamStatus : undefined,
    });
    const events = await readEvents();
    const reduced = reduceDelivery(events, deliveryId);
      return publicDelivery(reduced.value, reduced.eventCount);
    });
    deliveryMutation = task.catch(() => {});
    return task;
  };

  const getDelivery = async (deliveryId, { poll = true } = {}) => {
    const id = validId(deliveryId, 'deliveryId');
    let events = await readEvents();
    let reduced = reduceDelivery(events, id);
    if (!reduced) fail(404, 'delivery_not_found');
    let current = publicDelivery(reduced.value, reduced.eventCount);
    const shouldPoll = poll && current.groupId
      && ['awaiting_ready', 'submitted_pending', 'partial_failed', 'partial_cancelled'].includes(current.state);
    if (!shouldPoll) return current;
    let response;
    try {
      response = await adapter.publishStatus(current.groupId);
    } catch (error) {
      const normalized = normalizeAdapterError(error);
      await append({ type: 'poll_error', deliveryId: id, code: normalized.code, upstreamStatus: normalized.details?.upstreamStatus }).catch(() => {});
      throw normalized;
    }
    const targets = mergeTargets(current.targets, extractOfficialTargets(response, current.accountIds), current.accountIds);
    const submittedOperation = reduced.value.operationKind === 'submit'
      || current.state === 'submitted_pending'
      || current.state === 'submitting';
    const state = deriveDeliveryState(targets, submittedOperation ? 'submitted_pending' : 'awaiting_ready');
    await append({
      type: 'status_polled',
      deliveryId: id,
      groupId: current.groupId,
      state,
      targets,
      upstreamStatus: Number.isInteger(response?.upstreamStatus) ? response.upstreamStatus : undefined,
    });
    events = await readEvents();
    reduced = reduceDelivery(events, id);
    return publicDelivery(reduced.value, reduced.eventCount);
  };

  const normalizeExpected = (input, label = '操作') => {
    ensureKeys(input, new Set(['confirm', 'expectedGroupId', 'expectedDeliveryManifestId']), label);
    const expectedGroupId = validId(input.expectedGroupId, 'expectedGroupId');
    const expectedDeliveryManifestId = validId(input.expectedDeliveryManifestId, 'expectedDeliveryManifestId');
    return {
      confirm: input.confirm,
      expectedGroupId,
      expectedDeliveryManifestId,
    };
  };

  const normalizeRetryPrefillExpected = (input) => {
    ensureKeys(input, new Set(['confirm', 'expectedDeliveryManifestId']), '预填重试请求');
    if (input.confirm !== true) fail(400, 'delivery_confirm_required');
    return { expectedDeliveryManifestId: validId(input.expectedDeliveryManifestId, 'expectedDeliveryManifestId') };
  };

  const findPrefillRetryAttempt = (events, deliveryId) => {
    const retries = events.filter((event) => event.type === 'prefill_retry_requested'
      && event.deliveryId === deliveryId && typeof event.newDeliveryId === 'string');
    for (let index = retries.length - 1; index >= 0; index -= 1) {
      const candidate = reduceDelivery(events, retries[index].newDeliveryId);
      if (candidate) return candidate;
    }
    return undefined;
  };

  const retryPrefillDelivery = async (deliveryId, input) => {
    const expected = normalizeRetryPrefillExpected(input);
    const id = validId(deliveryId, 'deliveryId');
    return withDeliveryLock(id, async () => {
      const events = await readEvents();
      const reduced = reduceDelivery(events, id);
      if (!reduced) fail(404, 'delivery_not_found');
      const current = publicDelivery(reduced.value, reduced.eventCount);
      if (current.deliveryManifestId !== expected.expectedDeliveryManifestId) fail(409, 'delivery_expected_mismatch');
      const priorAttempt = findPrefillRetryAttempt(events, id);
      if (priorAttempt) return publicDelivery(priorAttempt.value, priorAttempt.eventCount);
      // This endpoint is deliberately explicit: it only creates a new attempt
      // for a prefill failure that never obtained an upstream group id.  A
      // failed publish with a group id must be inspected/retried through the
      // target-specific flow instead of being silently duplicated.
      if (current.state !== 'failed' || current.groupId) fail(409, 'delivery_not_ready');
      return createDelivery({
        schemaVersion: DELIVERY_REQUEST_SCHEMA_VERSION,
        deliveryManifestId: current.deliveryManifestId,
        accountIds: [...current.accountIds],
        contentType: current.contentType,
      }, { retryFromDeliveryId: id });
    });
  };

  const submitDelivery = async (deliveryId, input) => {
    const expected = normalizeExpected(input, '提交请求');
    if (expected.confirm !== true) fail(400, 'delivery_confirm_required');
    const id = validId(deliveryId, 'deliveryId');
    const active = deliveryInflight.get(id);
    if (active?.kind === 'submit') return cloneJson(active.receipt);
    // A caller may observe the persisted intent in the tiny window before the
    // first request stores its in-memory fast-path receipt.  Read the event
    // log before waiting on the per-delivery queue so that request returns the
    // durable in-flight/uncertain state instead of blocking behind a network
    // call that is already in flight.
    const persistedBeforeLock = reduceDelivery(await readEvents(), id);
    if (persistedBeforeLock) {
      const persisted = publicDelivery(persistedBeforeLock.value, persistedBeforeLock.eventCount);
      if (persisted.deliveryManifestId !== expected.expectedDeliveryManifestId || persisted.groupId !== expected.expectedGroupId) {
        fail(409, 'delivery_expected_mismatch');
      }
      if (['succeeded', 'submitted_pending', 'submitting', 'submit_unknown', 'target_retry_unknown', 'prefill_unknown'].includes(persisted.state)) return persisted;
    }
    return withDeliveryLock(id, async () => {
      const events = await readEvents();
      const reduced = reduceDelivery(events, id);
      if (!reduced) fail(404, 'delivery_not_found');
      const current = publicDelivery(reduced.value, reduced.eventCount);
      if (current.deliveryManifestId !== expected.expectedDeliveryManifestId || current.groupId !== expected.expectedGroupId) fail(409, 'delivery_expected_mismatch');
      // A persisted intent means another request (or a prior Bridge process)
      // may already have sent the submit call.  Never issue it again while the
      // outcome is pending/uncertain.
      if (current.state === 'succeeded' || current.state === 'submitted_pending' || current.state === 'submitting'
        || current.state === 'submit_unknown' || current.state === 'target_retry_unknown' || current.state === 'prefill_unknown') return current;
      if (current.state !== 'ready_to_submit' || current.targets.some((target) => target.status !== 'ready')) fail(409, 'delivery_not_ready');
      const intent = await commitOperationIntent(id, (await readEvents()).length, {
        type: 'submit_requested',
        deliveryId: id,
        groupId: current.groupId,
      }, 'submitting');
      if (!intent) {
        const latest = await readEvents();
        const next = reduceDelivery(latest, id);
        return publicDelivery(next.value, next.eventCount);
      }
      const intentReceipt = publicDelivery(intent.value, intent.eventCount);
      deliveryInflight.set(id, { kind: 'submit', receipt: intentReceipt });
      let response;
      try {
        response = await adapter.submit(current.groupId);
      } catch (error) {
        const normalized = normalizeAdapterError(error);
        // The request may have reached Desktop even when the HTTP response
        // was lost.  Persist submit_unknown and force the user to reconcile
        // it in MultiPost; this Bridge intentionally does not poll or submit
        // again from the uncertain state.
        await append({
          type: 'submit_unknown',
          deliveryId: id,
          groupId: current.groupId,
          error: { code: normalized.code, message: DELIVERY_PUBLIC_MESSAGES[normalized.code] ?? 'MultiPost Desktop 请求失败' },
          upstreamStatus: normalized.details?.upstreamStatus,
        }).catch(() => {});
        throw normalized;
      } finally {
        if (deliveryInflight.get(id)?.kind === 'submit') deliveryInflight.delete(id);
      }
      const targets = mergeTargets(current.targets, extractOfficialTargets(response, current.accountIds), current.accountIds);
      const state = deriveDeliveryState(targets, 'submitted_pending');
      await append({
        type: 'submit_accepted',
        deliveryId: id,
        groupId: current.groupId,
        state,
        targets,
        upstreamStatus: Number.isInteger(response?.upstreamStatus) ? response.upstreamStatus : undefined,
      });
      const latest = await readEvents();
      const next = reduceDelivery(latest, id);
      return publicDelivery(next.value, next.eventCount);
    });
  };

  const retryDeliveryTarget = async (deliveryId, accountId, input) => {
    ensureKeys(input, new Set(['expectedGroupId', 'expectedDeliveryManifestId']), '重试请求');
    const expected = {
      expectedGroupId: validId(input.expectedGroupId, 'expectedGroupId'),
      expectedDeliveryManifestId: validId(input.expectedDeliveryManifestId, 'expectedDeliveryManifestId'),
    };
    const id = validId(deliveryId, 'deliveryId');
    const targetId = validId(accountId, 'accountId');
    const active = deliveryInflight.get(id);
    if (active?.kind === 'target_retry' && active.accountId === targetId) return cloneJson(active.receipt);
    const persistedBeforeLock = reduceDelivery(await readEvents(), id);
    if (persistedBeforeLock) {
      const persisted = publicDelivery(persistedBeforeLock.value, persistedBeforeLock.eventCount);
      if (persisted.deliveryManifestId !== expected.expectedDeliveryManifestId || persisted.groupId !== expected.expectedGroupId) {
        fail(409, 'delivery_expected_mismatch');
      }
      // Any uncertain target retry blocks every account on this delivery.
      // The operation kind is delivery-scoped, so allowing another account
      // through here could overwrite it and issue a duplicate upstream call.
      if (persisted.state === 'target_retry_unknown') return persisted;
      // A durable retry intent also blocks every account until the owning
      // request records an accepted result.  This protects a second Bridge
      // process from issuing another upstream retry while the first call is
      // still in flight (or after a restart that observed only the intent).
      if (persisted.state === 'retrying') return persisted;
    }
    return withDeliveryLock(id, async () => {
      const events = await readEvents();
      const reduced = reduceDelivery(events, id);
      if (!reduced) fail(404, 'delivery_not_found');
      const current = publicDelivery(reduced.value, reduced.eventCount);
      if (current.deliveryManifestId !== expected.expectedDeliveryManifestId || current.groupId !== expected.expectedGroupId) fail(409, 'delivery_expected_mismatch');
      // Keep target_retry_unknown terminal for human reconciliation.  This
      // applies to the requested account and to every other account.
      if (current.state === 'target_retry_unknown') return current;
      // The retry intent is delivery-scoped.  Until its owner records an
      // accepted response, do not let another account create a second retry.
      if (current.state === 'retrying') return current;
      const target = current.targets.find((item) => item.accountId === targetId);
      if (!target) fail(404, 'delivery_account_not_found');
      if (target.status !== 'failed') fail(409, 'delivery_target_not_failed');
      const intent = await commitOperationIntent(id, (await readEvents()).length, {
        type: 'target_retry_requested',
        deliveryId: id,
        groupId: current.groupId,
        accountId: targetId,
      }, 'retrying');
      if (!intent) {
        const latest = await readEvents();
        const next = reduceDelivery(latest, id);
        return publicDelivery(next.value, next.eventCount);
      }
      const intentReceipt = publicDelivery(intent.value, intent.eventCount);
      deliveryInflight.set(id, { kind: 'target_retry', accountId: targetId, receipt: intentReceipt });
      let response;
      try {
        response = await adapter.retryTarget(current.groupId, targetId);
      } catch (error) {
        const normalized = normalizeAdapterError(error);
        await append({
          type: 'target_retry_unknown',
          deliveryId: id,
          groupId: current.groupId,
          accountId: targetId,
          error: { code: normalized.code, message: DELIVERY_PUBLIC_MESSAGES[normalized.code] ?? 'MultiPost Desktop 请求失败' },
          upstreamStatus: normalized.details?.upstreamStatus,
        }).catch(() => {});
        throw normalized;
      } finally {
        if (deliveryInflight.get(id)?.kind === 'target_retry' && deliveryInflight.get(id)?.accountId === targetId) {
          deliveryInflight.delete(id);
        }
      }
      const incoming = extractOfficialTargets(response, current.accountIds, { fallback: false });
      const targets = mergeTargets(
        current.targets,
        incoming.length ? incoming : [{ accountId: targetId, status: 'pending' }],
        current.accountIds,
      );
      const state = deriveDeliveryState(targets, 'awaiting_ready');
      await append({
        type: 'retry_accepted',
        deliveryId: id,
        groupId: current.groupId,
        accountId: targetId,
        state,
        targets,
        upstreamStatus: Number.isInteger(response?.upstreamStatus) ? response.upstreamStatus : undefined,
      });
      const latest = await readEvents();
      const next = reduceDelivery(latest, id);
      return publicDelivery(next.value, next.eventCount);
    });
  };

  return Object.freeze({
    deliveryStore: store,
    getTextManifest,
    createAssets,
    getDeliveryManifest,
    listDeliveries: listCurrentDeliveries,
    getDelivery,
    createDelivery,
    submitDelivery,
    retryDeliveryTarget,
    retryPrefillDelivery,
    deliveryRouteInfo,
  });
}
