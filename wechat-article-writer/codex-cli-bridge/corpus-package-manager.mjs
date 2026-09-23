import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * v30 local, user-authorised corpus packages.
 *
 * This module intentionally has no document/PDF/OCR/network dependencies.  A
 * package is a short-lived staging manifest plus raw UTF-8 Markdown/text
 * files.  Confirmation creates a content-addressed, immutable snapshot that
 * DNA jobs can consume without exposing the storage path over HTTP.
 */

export const CORPUS_PACKAGE_SCHEMA_VERSION = 'content-desk.corpus-package.v1';
export const CORPUS_IMPORT_REQUEST_SCHEMA_VERSION = 'content-desk.corpus-import.v1';
export const CORPUS_CONFIRM_REQUEST_SCHEMA_VERSION = 'content-desk.corpus-confirm.v1';
// Responses for raw PUT/confirm are envelopes, not package/snapshot
// resources.  Keep their schema versions distinct from both the request
// contract and the canonical package/snapshot resources so clients can
// reject a response accidentally decoded as a resource.
export const CORPUS_UPLOAD_RESPONSE_SCHEMA_VERSION = 'content-desk.corpus-upload-response.v1';
export const CORPUS_CONFIRM_RESPONSE_SCHEMA_VERSION = 'content-desk.corpus-confirm-response.v1';
export const CORPUS_ERROR_RESPONSE_SCHEMA_VERSION = 'content-desk.corpus-error-response.v1';
export const CORPUS_SNAPSHOT_SCHEMA_VERSION = 'content-desk.corpus-snapshot.v1';
export const CORPUS_PACKAGE_STATES = Object.freeze(['staging', 'confirmed']);
export const CORPUS_FILE_STATES = Object.freeze(['awaiting_upload', 'parsed']);
export const CORPUS_RIGHTS_ATTESTATIONS = Object.freeze([
  'self_authored',
  'permission_granted',
  'licensed',
  'public_domain',
]);

const RIGHTS = new Set(CORPUS_RIGHTS_ATTESTATIONS);
const MODES = new Set(['writing', 'academic']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
export const MAX_CORPUS_FILES = 64;
export const MAX_CORPUS_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_CORPUS_PACKAGE_BYTES = 64 * 1024 * 1024;
export const MAX_CORPUS_PREVIEW_CHARS = 240;
export const MAX_CORPUS_NAME_CHARS = 180;
export const MAX_CORPUS_IDEMPOTENCY_CHARS = 128;
const ALLOWED_EXTENSIONS = new Set(['.md', '.txt']);
const ALLOWED_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'application/octet-stream',
]);
export const CORPUS_PARSER_VERSION = 'utf8-text.v1';

export class CorpusPackageError extends Error {
  constructor(status, code, message, stage = 'corpus', details = undefined) {
    super(message);
    this.name = 'CorpusPackageError';
    this.status = Number.isInteger(status) ? status : 500;
    this.code = code;
    this.stage = stage;
    this.details = details;
  }
}

function fail(status, code, message, stage = 'corpus', details = undefined) {
  throw new CorpusPackageError(status, code, message, stage, details);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function safeId(value, label = 'id') {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail(400, 'invalid_request', `${label} 格式无效`, 'validation');
  }
  return value;
}

function safeFileId(value) {
  if (typeof value !== 'string' || !FILE_ID_PATTERN.test(value)) {
    fail(400, 'invalid_request', 'fileId 格式无效', 'validation');
  }
  return value;
}

function safeMode(value) {
  if (!MODES.has(value)) fail(400, 'invalid_request', '语料包 mode 只能是 writing 或 academic', 'validation');
  return value;
}

function safeRights(value) {
  if (!RIGHTS.has(value)) {
    fail(400, 'rights_attestation_required', '必须明确选择受权语料权利声明', 'validation');
  }
  return value;
}

function safeText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    fail(400, 'invalid_request', `${label} 格式无效`, 'validation');
  }
  return value.trim();
}

function normalizeMime(value, extension) {
  const mime = typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : '';
  if (mime && !ALLOWED_MIME_TYPES.has(mime)) {
    fail(415, 'unsupported_corpus_format', '语料包只接受 Markdown 或纯文本文件', 'validation');
  }
  if (extension === '.md') return mime || 'text/markdown';
  return mime || 'text/plain';
}

/** Strip path separators, traversal markers, control characters and names
 * that are not useful on the local filesystem.  Never return the original
 * path-like string to the caller. */
export function sanitizeCorpusFileName(value) {
  const input = safeText(value, 'files[].name', MAX_CORPUS_NAME_CHARS)
    .replace(/[\u0000-\u001F\u007F]/gu, '')
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .at(-1) ?? '';
  const withoutTraversal = input.replace(/^(?:\.+)/u, '').replace(/\.\.+/gu, '.');
  const cleaned = withoutTraversal
    .replace(/[^\p{L}\p{N}._()\[\] -]/gu, '_')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    fail(400, 'invalid_filename', '文件名无效', 'validation');
  }
  const extension = path.extname(cleaned).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    fail(415, 'unsupported_corpus_format', '语料包只接受 .md 或 .txt 文件', 'validation');
  }
  return cleaned.slice(0, MAX_CORPUS_NAME_CHARS);
}

function normalizeDeclaredBytes(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_CORPUS_FILE_BYTES) {
    fail(413, 'corpus_file_too_large', `${label} 必须是 1-${MAX_CORPUS_FILE_BYTES} 字节`, 'validation');
  }
  return value;
}

function normalizeClientFileId(value) {
  return safeText(value, 'files[].clientFileId', MAX_CORPUS_IDEMPOTENCY_CHARS)
    .replace(/[^A-Za-z0-9_-]/gu, '_')
    .slice(0, 128) || fail(400, 'invalid_request', 'clientFileId 格式无效', 'validation');
}

function normalizeManifestFiles(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CORPUS_FILES) {
    fail(400, 'invalid_request', `files 必须是 1-${MAX_CORPUS_FILES} 个文件`, 'validation');
  }
  const ids = new Set();
  const names = new Set();
  let total = 0;
  const files = value.map((item, index) => {
    if (!object(item)) fail(400, 'invalid_request', `files[${index}] 格式无效`, 'validation');
    const clientFileId = normalizeClientFileId(item.clientFileId);
    if (ids.has(clientFileId)) fail(409, 'duplicate_file', 'clientFileId 不能重复', 'validation');
    ids.add(clientFileId);
    const name = sanitizeCorpusFileName(item.name);
    if (names.has(name.toLocaleLowerCase())) fail(409, 'duplicate_filename', '清洗后的文件名不能重复', 'validation');
    names.add(name.toLocaleLowerCase());
    const extension = path.extname(name).toLowerCase();
    const mimeType = normalizeMime(item.mimeType ?? item.mediaType, extension);
    const bytes = normalizeDeclaredBytes(item.bytes, `files[${index}].bytes`);
    total += bytes;
    if (total > MAX_CORPUS_PACKAGE_BYTES) fail(413, 'corpus_package_too_large', '语料包总大小超过限制', 'validation');
    return {
      fileId: randomUUID(),
      clientFileId,
      name,
      mimeType,
      bytes,
      state: 'awaiting_upload',
      uploadedBytes: 0,
      sha256: null,
      normalizedTextHash: null,
      parserVersion: CORPUS_PARSER_VERSION,
      issues: [],
      charCount: null,
      lineCount: null,
    };
  });
  return files;
}

function packageManifestHash(record) {
  return createHash('sha256').update(JSON.stringify({
    mode: record.mode,
    rightsAttestation: record.rightsAttestation,
    files: record.files.map(({ fileId, clientFileId, name, mimeType, bytes }) => ({
      fileId,
      clientFileId,
      name,
      mimeType,
      bytes,
    })),
  }), 'utf8').digest('hex');
}

function idempotencyHash(mode, rightsAttestation, files) {
  return createHash('sha256').update(JSON.stringify({
    mode,
    rightsAttestation,
    files: files.map(({ clientFileId, name, mimeType, bytes }) => ({ clientFileId, name, mimeType, bytes })),
  }), 'utf8').digest('hex');
}

function snapshotHash(mode, rightsAttestation, files) {
  return createHash('sha256').update(JSON.stringify({
    mode,
    rightsAttestation,
    files: files.map(({ name, bytes, sha256, normalizedTextHash, parserVersion }) => ({
      name, bytes, sha256, normalizedTextHash, parserVersion,
    })),
  }), 'utf8').digest('hex');
}

function publicFile(file) {
  return {
    fileId: file.fileId,
    clientFileId: file.clientFileId,
    name: file.name,
    mediaType: file.mimeType,
    mimeType: file.mimeType,
    bytes: file.bytes,
    state: file.state,
    uploadedBytes: file.uploadedBytes,
    sha256: file.sha256,
    normalizedTextHash: file.normalizedTextHash,
    parserVersion: file.parserVersion,
    issues: Array.isArray(file.issues) ? [...file.issues] : [],
    charCount: file.charCount,
    characterCount: file.charCount,
    lineCount: file.lineCount,
  };
}

function publicSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    schemaVersion: CORPUS_SNAPSHOT_SCHEMA_VERSION,
    corpusSnapshotId: snapshot.corpusSnapshotId,
    packageId: snapshot.packageId,
    mode: snapshot.mode,
    rightsAttestation: snapshot.rightsAttestation,
    createdAt: snapshot.createdAt,
    manifestHash: snapshot.manifestHash,
    totalBytes: snapshot.totalBytes,
    snapshotId: snapshot.corpusSnapshotId,
    fileCount: snapshot.files.length,
    files: snapshot.files.map(({ name, mimeType, mediaType, bytes, sha256, normalizedTextHash, parserVersion, issues, charCount, characterCount, lineCount }) => ({
      name,
      mediaType: mediaType ?? mimeType,
      mimeType: mimeType ?? mediaType,
      bytes,
      sha256,
      normalizedTextHash,
      parserVersion,
      issues: [...(issues ?? [])],
      charCount,
      characterCount: characterCount ?? charCount,
      lineCount,
    })),
  };
}

function publicPackage(record) {
  const readyToConfirm = record.state === 'staging' && record.files.every((file) => file.state === 'parsed');
  const snapshot = publicSnapshot(record.corpusSnapshot);
  return {
    schemaVersion: CORPUS_PACKAGE_SCHEMA_VERSION,
    packageId: record.packageId,
    mode: record.mode,
    rightsAttestation: record.rightsAttestation,
    state: record.state === 'staging' && readyToConfirm ? 'ready_to_confirm' : record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    manifestHash: record.manifestHash,
    canConfirm: readyToConfirm,
    files: record.files.map(publicFile),
    snapshot,
    corpusSnapshot: snapshot,
  };
}

function defaultRoot() {
  const configured = process.env.CODEX_BRIDGE_CORPUS_PATH?.trim();
  if (configured) return path.resolve(configured);
  const local = process.env.LOCALAPPDATA?.trim()
    || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Local')
      : process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), '.local', 'state'));
  return path.join(local, 'ContentDesk', 'corpus-packages');
}

async function atomicJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function readJson(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } catch { return undefined; }
}

async function hashAndReadText(filePath) {
  const encoded = await fs.readFile(filePath);
  const hash = createHash('sha256').update(encoded).digest('hex');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(encoded);
  } catch {
    fail(415, 'invalid_utf8', '文件必须是严格 UTF-8 编码', 'upload', { issues: ['invalid_utf8'] });
  }
  const cleanText = text.replace(/^\uFEFF/u, '');
  const normalizedText = cleanText.replace(/\r\n?/gu, '\n');
  if (!normalizedText.replace(/[\s]/gu, '')) {
    fail(422, 'empty_text', 'Markdown/纯文本不能只有 BOM 或空白', 'upload', { issues: ['empty_text'] });
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(normalizedText)) {
    fail(422, 'unsupported_control_characters', '文本包含不可见控制字符', 'upload', { issues: ['unsupported_control_characters'] });
  }
  return {
    sha256: hash,
    normalizedTextHash: createHash('sha256').update(Buffer.from(normalizedText, 'utf8')).digest('hex'),
    parserVersion: CORPUS_PARSER_VERSION,
    issues: [],
    charCount: [...normalizedText].length,
    lineCount: normalizedText.length ? normalizedText.split('\n').length : 0,
  };
}

export function corpusPackageRouteInfo(route) {
  if (route === '/v1/corpus-packages') return { action: 'collection', methods: ['POST'] };
  const collection = /^\/v1\/corpus-packages\/([^/]+)$/u.exec(route);
  if (collection) {
    let packageId;
    try { packageId = decodeURIComponent(collection[1]); } catch { return null; }
    if (!ID_PATTERN.test(packageId)) return null;
    return { action: 'package', packageId, methods: ['GET'] };
  }
  const file = /^\/v1\/corpus-packages\/([^/]+)\/files\/([^/]+)$/u.exec(route);
  if (file) {
    let packageId;
    let fileId;
    try {
      packageId = decodeURIComponent(file[1]);
      fileId = decodeURIComponent(file[2]);
    } catch { return null; }
    if (!ID_PATTERN.test(packageId) || !FILE_ID_PATTERN.test(fileId)) return null;
    return { action: 'file', packageId, fileId, methods: ['PUT'] };
  }
  const confirm = /^\/v1\/corpus-packages\/([^/]+)\/confirm$/u.exec(route);
  if (confirm) {
    let packageId;
    try { packageId = decodeURIComponent(confirm[1]); } catch { return null; }
    if (!ID_PATTERN.test(packageId)) return null;
    return { action: 'confirm', packageId, methods: ['POST'] };
  }
  return undefined;
}

export function createCorpusPackageManager({ directory = defaultRoot(), maxFiles = MAX_CORPUS_FILES } = {}) {
  const root = path.resolve(directory);
  const packagesRoot = path.join(root, 'packages');
  const snapshotsRoot = path.join(root, 'snapshots');
  const records = new Map();
  const idempotency = new Map();
  let persistence = Promise.resolve();

  const packagePath = (id) => path.join(packagesRoot, `${id}.json`);
  const packageFilesPath = (id) => path.join(packagesRoot, id, 'files');
  const snapshotPath = (id) => path.join(snapshotsRoot, `${id}.json`);
  const snapshotFilesPath = (id) => path.join(snapshotsRoot, id, 'files');

  const persist = async (record) => {
    records.set(record.packageId, record);
    persistence = persistence.then(() => atomicJson(packagePath(record.packageId), record));
    await persistence;
    return clone(record);
  };

  const load = async (packageId) => {
    const id = safeId(packageId, 'packageId');
    if (records.has(id)) return records.get(id);
    const value = await readJson(packagePath(id));
    if (!object(value) || value.schemaVersion !== CORPUS_PACKAGE_SCHEMA_VERSION || value.packageId !== id
      || !MODES.has(value.mode) || !RIGHTS.has(value.rightsAttestation) || !CORPUS_PACKAGE_STATES.includes(value.state)
      || !Array.isArray(value.files)) return undefined;
    records.set(id, value);
    if (value.idempotencyKey) idempotency.set(value.idempotencyKey, id);
    return value;
  };

  const findByIdempotencyKey = async (key) => {
    const cached = idempotency.get(key);
    if (cached) {
      const record = await load(cached);
      if (record) return record;
    }
    let entries;
    try { entries = await fs.readdir(packagesRoot, { withFileTypes: true }); } catch { return undefined; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5);
      if (!ID_PATTERN.test(id)) continue;
      const record = await load(id);
      if (record?.idempotencyKey === key) {
        idempotency.set(key, id);
        return record;
      }
    }
    return undefined;
  };

  const create = async ({ mode, rightsAttestation, files, idempotencyKey } = {}) => {
    safeMode(mode);
    safeRights(rightsAttestation);
    const normalizedKey = idempotencyKey === undefined ? undefined
      : safeText(idempotencyKey, 'idempotencyKey', MAX_CORPUS_IDEMPOTENCY_CHARS);
    const normalizedFiles = normalizeManifestFiles(files);
    const requestFingerprint = idempotencyHash(mode, rightsAttestation, normalizedFiles);
    if (normalizedKey) {
      const previous = await findByIdempotencyKey(normalizedKey);
      if (previous) {
        if (previous.idempotencyHash !== requestFingerprint) {
          fail(409, 'idempotency_conflict', 'idempotencyKey 已对应不同的语料包清单', 'validation');
        }
        return { package: publicPackage(previous), created: false, idempotent: true };
      }
    }
    if (normalizedFiles.length > maxFiles) fail(400, 'invalid_request', `files 不能超过 ${maxFiles} 个`, 'validation');
    const timestamp = now();
    const record = {
      schemaVersion: CORPUS_PACKAGE_SCHEMA_VERSION,
      packageId: randomUUID(),
      mode,
      rightsAttestation,
      state: 'staging',
      createdAt: timestamp,
      updatedAt: timestamp,
      manifestHash: '',
      idempotencyKey: normalizedKey,
      idempotencyHash: requestFingerprint,
      files: normalizedFiles,
      corpusSnapshot: null,
    };
    record.manifestHash = packageManifestHash(record);
    await persist(record);
    if (normalizedKey) idempotency.set(normalizedKey, record.packageId);
    return { package: publicPackage(record), created: true, idempotent: false };
  };

  const upload = async (packageId, fileId, bodyStream, { contentLength } = {}) => {
    const record = await load(packageId);
    if (!record) fail(404, 'corpus_package_not_found', '语料包不存在', 'validation');
    if (record.state !== 'staging') fail(409, 'corpus_package_immutable', '语料包已确认，不能修改', 'validation');
    const file = record.files.find((entry) => entry.fileId === safeFileId(fileId));
    if (!file) fail(404, 'corpus_file_not_found', '语料文件不存在', 'validation');
    if (contentLength !== undefined && (!Number.isInteger(contentLength) || contentLength < 1 || contentLength > MAX_CORPUS_FILE_BYTES)) {
      fail(413, 'corpus_file_too_large', '文件大小超过限制', 'validation');
    }
    if (contentLength !== undefined && contentLength !== file.bytes) {
      fail(409, 'corpus_size_mismatch', '上传字节数与清单不一致', 'upload');
    }
    const directory = packageFilesPath(record.packageId);
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.${file.fileId}.${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'w');
    const hash = createHash('sha256');
    let total = 0;
    try {
      for await (const chunk of bodyStream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.length;
        if (total > file.bytes || total > MAX_CORPUS_FILE_BYTES) {
          fail(409, 'corpus_size_mismatch', '上传字节数与清单不一致', 'upload');
        }
        hash.update(bytes);
        await handle.write(bytes);
      }
      if (total !== file.bytes) fail(409, 'corpus_size_mismatch', '上传字节数与清单不一致', 'upload');
      await handle.close();
      const parsed = await hashAndReadText(temporary);
      const sha256 = hash.digest('hex');
      if (parsed.sha256 !== sha256) fail(500, 'corpus_hash_failed', '文件哈希校验失败', 'upload');
      if (file.state === 'parsed') {
        if (file.sha256 !== sha256 || file.uploadedBytes !== total) {
          fail(409, 'corpus_file_conflict', '文件已上传且内容不同', 'upload');
        }
        await fs.rm(temporary, { force: true });
        return { package: publicPackage(record), file: publicFile(file), idempotent: true };
      }
      const target = path.join(directory, `${file.fileId}.raw`);
      await fs.rename(temporary, target);
      file.state = 'parsed';
      file.uploadedBytes = total;
      file.sha256 = sha256;
      file.normalizedTextHash = parsed.normalizedTextHash;
      file.parserVersion = parsed.parserVersion;
      file.issues = parsed.issues;
      file.charCount = parsed.charCount;
      file.lineCount = parsed.lineCount;
      record.updatedAt = now();
      await persist(record);
      return { package: publicPackage(record), file: publicFile(file), idempotent: false };
    } finally {
      await handle.close().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  };

  const confirm = async (packageId) => {
    const record = await load(packageId);
    if (!record) fail(404, 'corpus_package_not_found', '语料包不存在', 'validation');
    if (record.state === 'confirmed' && record.corpusSnapshot) {
      return { package: publicPackage(record), snapshot: publicSnapshot(record.corpusSnapshot), idempotent: true };
    }
    if (record.state !== 'staging') fail(409, 'corpus_package_invalid_state', '语料包当前不能确认', 'validation');
    if (!RIGHTS.has(record.rightsAttestation)) fail(400, 'rights_attestation_required', '权利声明无效', 'validation');
    if (record.files.some((file) => file.state !== 'parsed')) {
      fail(409, 'corpus_upload_incomplete', '全部语料文件上传完成后才能确认', 'validation');
    }
    const snapshotId = randomUUID();
    const temporary = path.join(snapshotsRoot, `.${snapshotId}.${randomUUID()}.tmp`);
    const destination = path.join(temporary, 'files');
    await fs.mkdir(destination, { recursive: true });
    const snapshotFiles = [];
    try {
      for (const file of record.files) {
        const source = path.join(packageFilesPath(record.packageId), `${file.fileId}.raw`);
        const target = path.join(destination, file.name);
        const parsed = await hashAndReadText(source);
        if (parsed.sha256 !== file.sha256
          || parsed.normalizedTextHash !== file.normalizedTextHash
          || parsed.charCount !== file.charCount) {
          fail(409, 'corpus_snapshot_failed', '语料文件在确认前发生变化', 'confirm');
        }
        await fs.copyFile(source, target);
        snapshotFiles.push({
          name: file.name,
          mimeType: file.mimeType,
          mediaType: file.mimeType,
          bytes: file.bytes,
          sha256: file.sha256,
          normalizedTextHash: file.normalizedTextHash,
          parserVersion: file.parserVersion,
          issues: [...(file.issues ?? [])],
          charCount: file.charCount,
          characterCount: file.charCount,
          lineCount: file.lineCount,
        });
      }
      const manifestHash = snapshotHash(record.mode, record.rightsAttestation, snapshotFiles);
      const snapshot = {
        schemaVersion: CORPUS_SNAPSHOT_SCHEMA_VERSION,
        corpusSnapshotId: snapshotId,
        packageId: record.packageId,
        mode: record.mode,
        rightsAttestation: record.rightsAttestation,
        createdAt: now(),
        manifestHash,
        totalBytes: snapshotFiles.reduce((sum, file) => sum + file.bytes, 0),
        files: snapshotFiles,
      };
      await fs.rename(temporary, path.join(snapshotsRoot, snapshotId));
      await atomicJson(snapshotPath(snapshotId), snapshot);
      record.state = 'confirmed';
      record.updatedAt = now();
      record.corpusSnapshot = snapshot;
      await persist(record);
      return { package: publicPackage(record), snapshot: publicSnapshot(snapshot), idempotent: false };
    } finally {
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
  };

  const get = async (packageId) => {
    const record = await load(packageId);
    return record ? publicPackage(record) : undefined;
  };

  const resolveSnapshot = async (snapshotId, { mode = undefined } = {}) => {
    const id = safeId(snapshotId, 'corpusSnapshotId');
    const snapshot = await readJson(snapshotPath(id));
    if (!object(snapshot) || snapshot.schemaVersion !== CORPUS_SNAPSHOT_SCHEMA_VERSION || snapshot.corpusSnapshotId !== id) return undefined;
    if (mode !== undefined && snapshot.mode !== mode) fail(409, 'corpus_snapshot_mode_mismatch', '语料快照 mode 与 DNA job 不一致', 'validation');
    const rootPath = path.join(snapshotsRoot, id, 'files');
    return { ...clone(snapshot), rootPath };
  };

  return {
    directory: root,
    create,
    upload,
    confirm,
    get,
    resolveSnapshot,
    publicSnapshot,
  };
}
