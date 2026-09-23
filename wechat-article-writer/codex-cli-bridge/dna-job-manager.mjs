import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Persistent execution records for the two original DNA distillation skills.
 *
 * The manager deliberately knows nothing about Codex prompts or the DNA
 * workspace layout.  The bridge supplies the runner and the artifact
 * collector.  Keeping this state machine outside server.mjs makes it useful
 * to future graph nodes without turning the HTTP adapter into a second
 * execution engine.
 */

export const DNA_JOB_SCHEMA_VERSION = 'content-desk.dna-job.v1';
export const DNA_JOB_RECEIPT_SCHEMA_VERSION = 'content-desk.dna-receipt.v1';
export const DNA_ARTIFACT_MANIFEST_SCHEMA_VERSION = 'content-desk.dna-artifact.v1';
export const DNA_JOB_STATES = Object.freeze([
  'queued',
  'running',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);
export const DNA_JOB_TERMINAL_STATES = Object.freeze([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);
const DNA_JOB_MODES = new Set(['writing', 'academic']);
const DNA_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const CORPUS_SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MAX_JOBS = 50;
const MAX_OUTPUT_FILES = 512;
const MAX_SUMMARY_CHARS = 1000;
const MAX_ERROR_CHARS = 240;
const DNA_JOB_STAGES = new Set([
  'validating_inputs',
  'staging',
  'executing',
  'validating_outputs',
  'committing',
]);
const DEFAULT_DIRECTORY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '.runtime',
  'dna-jobs',
);

const TRANSITIONS = Object.freeze({
  queued: new Set(['running', 'cancelling', 'failed', 'cancelled', 'interrupted']),
  running: new Set(['cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  cancelling: new Set(['cancelled', 'failed', 'interrupted']),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
});

export class DnaJobError extends Error {
  constructor(status, code, message, stage = 'dna_job', details = undefined) {
    super(message);
    this.name = 'DnaJobError';
    this.status = Number.isInteger(status) ? status : 500;
    this.code = code;
    this.stage = stage;
    this.details = details;
  }
}

function fail(status, code, message, stage = 'dna_job', details = undefined) {
  throw new DnaJobError(status, code, message, stage, details);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function safeMessage(value, max = MAX_ERROR_CHARS) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [已隐藏]')
    .replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, '$1=[已隐藏]')
    .replace(/[A-Za-z]:\\[^\s,;]+/gu, '[路径已隐藏]')
    .replace(/(?:^|\s)(?:\\\\|\/)(?:Users|home|tmp|var|private|workspace|app|mnt|opt|etc)\/[^\s,;]*/giu, ' [路径已隐藏]')
    .replace(/https?:\/\/[^\s,;]+/giu, '[链接已隐藏]')
    .replace(/[\u0000-\u001F\u007F]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max);
}

function validId(value, label = 'jobId') {
  if (typeof value !== 'string' || !DNA_JOB_ID_PATTERN.test(value)) {
    fail(400, 'invalid_request', `${label} 必须是 1-128 位字母、数字、下划线或连字符`, 'validation');
  }
  return value;
}

function validMode(value) {
  if (!DNA_JOB_MODES.has(value)) {
    fail(400, 'invalid_request', 'DNA job mode 只能是 writing 或 academic', 'validation');
  }
  return value;
}

function normalizeStage(value) {
  if (DNA_JOB_STAGES.has(value)) return value;
  // Keep injected/legacy runners observable without allowing arbitrary stage
  // labels into the persisted contract.
  if (value === 'dna_distill' || value === 'writing' || value === 'quality_review') return 'executing';
  if (value === 'quality_gate' || value === 'validation') return 'validating_outputs';
  return undefined;
}

function requestHash(mode, corpusSnapshotId = undefined) {
  return createHash('sha256')
    .update(JSON.stringify({ mode, ...(corpusSnapshotId ? { corpusSnapshotId } : {}) }), 'utf8')
    .digest('hex');
}

function fileName(id) {
  return `${id}.json`;
}

function safeOutputFile(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 240) return false;
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)) return false;
  return normalized.split('/').every((part) => part && part !== '..');
}

function normalizeOutputFiles(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(safeOutputFile).map((item) => item.replaceAll('\\', '/').replace(/^\.\//u, '')))]
    .sort()
    .slice(0, MAX_OUTPUT_FILES);
}

function normalizeError(error, fallbackCode = 'dna_job_failed') {
  const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]{1,63}$/u.test(error.code)
    ? error.code
    : fallbackCode;
  const stage = normalizeStage(error?.stage) ?? 'executing';
  return {
    code,
    stage,
    message: safeMessage(error?.message) || 'DNA job 执行失败',
  };
}

function normalizeStoredRecord(value, id) {
  if (!isObject(value)
    || value.schemaVersion !== DNA_JOB_SCHEMA_VERSION
    || value.jobId !== id
    || !DNA_JOB_MODES.has(value.mode)
    || !DNA_JOB_STATES.includes(value.state)
    || typeof value.requestHash !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.requestHash)
    || (value.corpusSnapshotId !== undefined
      && value.corpusSnapshotId !== null
      && (typeof value.corpusSnapshotId !== 'string' || !CORPUS_SNAPSHOT_ID_PATTERN.test(value.corpusSnapshotId)))
    || value.requestHash !== requestHash(value.mode, value.corpusSnapshotId)
    || typeof value.stage !== 'string'
    || !DNA_JOB_STAGES.has(value.stage)
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string') {
    return undefined;
  }
  const record = {
    ...value,
    outputFiles: normalizeOutputFiles(value.outputFiles),
  };
  if (record.corpusSnapshotId !== undefined && record.corpusSnapshotId !== null) record.corpusSnapshotId = String(record.corpusSnapshotId);
  if (record.summary !== undefined) record.summary = safeMessage(record.summary, MAX_SUMMARY_CHARS);
  if (record.error !== undefined) record.error = normalizeError(record.error);
  if (record.artifactManifest !== undefined) {
    const artifactManifest = normalizeArtifactManifest(record.artifactManifest);
    if (!artifactManifest
      || artifactManifest.mode !== record.mode
      || (record.artifactHash !== undefined && record.artifactHash !== artifactManifest.sha256)) return undefined;
    record.artifactManifest = artifactManifest;
    record.artifactHash = artifactManifest.sha256;
  }
  if (record.receipt !== undefined) {
    const receipt = normalizeReceipt(record.receipt);
    if (!receipt) return undefined;
    record.receipt = receipt;
    if (record.artifactHash !== receipt.artifactHash
      || record.jobId !== receipt.jobId
      || record.mode !== receipt.mode) return undefined;
    // A receipt is the durable proof for this exact job.  Treat an omitted
    // snapshot id as the explicit "no snapshot" value and reject records
    // whose top-level job and nested receipt disagree; otherwise a manually
    // edited/stale JSON file could make a job appear bound to one corpus
    // while its receipt proves another.
    const jobSnapshotId = record.corpusSnapshotId ?? null;
    const receiptSnapshotId = receipt.corpusSnapshotId ?? null;
    if (jobSnapshotId !== receiptSnapshotId) return undefined;
  }
  // Succeeded is a durable claim that must carry its immutable receipt.  A
  // truncated/tampered JSON record must not be reloaded as a successful DNA
  // job merely because its state field survived the write.
  if (record.state === 'succeeded' && !record.receipt) return undefined;
  return record;
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  hash.update(await fs.readFile(filePath));
  return hash.digest('hex');
}

/**
 * Build a deterministic, path-safe manifest for the files returned by a DNA
 * runner.  Only declared files are read; raw corpus and skill inputs never
 * cross this receipt boundary.
 */
export async function collectDnaArtifactManifest({
  mode,
  projectRoot,
  workspaceRelative,
  outputFiles,
} = {}) {
  validMode(mode);
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) {
    fail(500, 'dna_artifact_failed', 'DNA artifact 工作区无效', 'artifact');
  }
  if (typeof workspaceRelative !== 'string' || !workspaceRelative.trim()) {
    fail(500, 'dna_artifact_failed', 'DNA artifact 相对路径无效', 'artifact');
  }
  const workspace = path.resolve(projectRoot, workspaceRelative);
  const root = path.resolve(projectRoot);
  if (workspace !== root && !workspace.startsWith(`${root}${path.sep}`)) {
    fail(500, 'dna_artifact_failed', 'DNA artifact 路径越界', 'artifact');
  }
  const names = normalizeOutputFiles(outputFiles);
  if (names.length === 0) fail(502, 'dna_artifact_failed', 'DNA 蒸馏没有可登记的产物', 'artifact');
  const files = [];
  for (const relative of names) {
    const target = path.resolve(workspace, relative);
    if (target !== workspace && !target.startsWith(`${workspace}${path.sep}`)) {
      fail(502, 'dna_artifact_failed', 'DNA artifact 输出路径越界', 'artifact');
    }
    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      fail(502, 'dna_artifact_failed', 'DNA 蒸馏产物缺失，未生成回执', 'artifact');
    }
    if (!stat.isFile()) fail(502, 'dna_artifact_failed', 'DNA 蒸馏产物不是文件', 'artifact');
    files.push({ path: relative, bytes: stat.size, sha256: await hashFile(target) });
  }
  const canonical = JSON.stringify({ mode, workspace: workspaceRelative.replaceAll(path.sep, '/'), files });
  const artifactHash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return {
    schemaVersion: DNA_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    mode,
    workspace: workspaceRelative.replaceAll(path.sep, '/'),
    files,
    sha256: artifactHash,
    artifactHash,
  };
}

function normalizeArtifactManifest(value) {
  if (!isObject(value)
    || value.schemaVersion !== DNA_ARTIFACT_MANIFEST_SCHEMA_VERSION
    || !DNA_JOB_MODES.has(value.mode)
    || typeof value.workspace !== 'string'
    || !value.workspace.trim()
    || !Array.isArray(value.files)
    || !/^[a-f0-9]{64}$/u.test(value.sha256 ?? value.artifactHash ?? '')) return undefined;
  const files = value.files.flatMap((item) => {
    if (!isObject(item) || !safeOutputFile(item.path)
      || !Number.isInteger(item.bytes) || item.bytes < 0
      || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)) return [];
    return [{ path: item.path.replaceAll('\\', '/').replace(/^\.\//u, ''), bytes: item.bytes, sha256: item.sha256 }];
  });
  if (files.length !== value.files.length || files.length > MAX_OUTPUT_FILES) return undefined;
  const digest = value.sha256 ?? value.artifactHash;
  const canonical = JSON.stringify({ mode: value.mode, workspace: value.workspace.replaceAll('\\', '/'), files });
  const calculated = createHash('sha256').update(canonical, 'utf8').digest('hex');
  if (calculated !== digest) return undefined;
  return {
    schemaVersion: DNA_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    mode: value.mode,
    workspace: value.workspace.replaceAll('\\', '/'),
    files,
    sha256: digest,
    artifactHash: digest,
  };
}

function normalizeReceipt(value) {
  if (!isObject(value)
    || value.schemaVersion !== DNA_JOB_RECEIPT_SCHEMA_VERSION
    || typeof value.jobId !== 'string'
    || !DNA_JOB_ID_PATTERN.test(value.jobId)
    || !DNA_JOB_MODES.has(value.mode)
    || value.state !== 'succeeded'
    || (value.corpusSnapshotId !== undefined && value.corpusSnapshotId !== null
      && (typeof value.corpusSnapshotId !== 'string' || !CORPUS_SNAPSHOT_ID_PATTERN.test(value.corpusSnapshotId)))
    || typeof value.artifactHash !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.artifactHash)
    || !isObject(value.artifactManifest)
    || typeof value.completedAt !== 'string'
    || !Number.isFinite(Date.parse(value.completedAt))) return undefined;
  const artifactManifest = normalizeArtifactManifest(value.artifactManifest);
  if (!artifactManifest
    || artifactManifest.mode !== value.mode
    || artifactManifest.sha256 !== value.artifactHash) return undefined;
  return {
    schemaVersion: DNA_JOB_RECEIPT_SCHEMA_VERSION,
    jobId: value.jobId,
    mode: value.mode,
    ...(value.corpusSnapshotId !== undefined ? { corpusSnapshotId: value.corpusSnapshotId } : {}),
    state: 'succeeded',
    artifactHash: value.artifactHash,
    artifactManifest,
    completedAt: value.completedAt,
  };
}

function makeRecord(jobId, mode, fields = {}) {
  const timestamp = now();
  return {
    schemaVersion: DNA_JOB_SCHEMA_VERSION,
    jobId,
    mode,
    requestHash: requestHash(mode, fields.corpusSnapshotId),
    state: 'queued',
    stage: 'validating_inputs',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...fields,
  };
}

function defaultDirectory() {
  const configured = process.env.CODEX_BRIDGE_DNA_JOBS_PATH?.trim();
  if (configured) return path.resolve(configured);
  const localRoot = process.env.LOCALAPPDATA?.trim()
    || (process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local')
      : process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), '.local', 'state'));
  return path.join(localRoot, 'ContentDesk', 'dna-jobs');
}

export function dnaJobRouteInfo(route) {
  if (route === '/v1/dna/jobs') return { action: 'collection', methods: ['POST'] };
  const match = /^\/v1\/dna\/jobs\/([^/]+)(?:\/(cancel))?$/u.exec(route);
  if (!match) return undefined;
  let jobId;
  try { jobId = decodeURIComponent(match[1]); } catch { return null; }
  if (!jobId || jobId.includes('/')) return null;
  return match[2]
    ? { action: 'cancel', jobId, methods: ['POST'] }
    : { action: 'item', jobId, methods: ['GET', 'DELETE'] };
}

/**
 * Create one persistent DNA job executor.  The manager owns one active job
 * because the Bridge's Codex CLI slot is intentionally serialized.  A second
 * job with a different id receives a deterministic busy response; repeating
 * the same id/mode is idempotent.
 */
export function createDnaJobManager({
  directory = defaultDirectory(),
  maxJobs = MAX_JOBS,
  runner,
  projectRoot,
  workspaceForMode = (mode) => mode === 'academic'
    ? 'writing-dna-workspace/academic'
    : 'writing-dna-workspace/general',
  artifactCollector = collectDnaArtifactManifest,
  createCancellationController,
  isBusy = () => false,
  setBusy = () => {},
  resolveCorpusSnapshot = undefined,
} = {}) {
  if (typeof runner !== 'function') throw new TypeError('createDnaJobManager requires runner');
  if (typeof createCancellationController !== 'function') throw new TypeError('createDnaJobManager requires cancellation factory');
  const root = path.resolve(directory);
  const records = new Map();
  const operations = new Map();
  let activeJobId;
  let persistence = Promise.resolve();

  const pathFor = (id) => path.join(root, fileName(id));

  const persist = (record) => {
    records.set(record.jobId, record);
    const task = persistence.then(async () => {
      await fs.mkdir(root, { recursive: true });
      const temporary = path.join(root, `.${record.jobId}.${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
        let renamed = false;
        for (let attempt = 0; attempt < 3 && !renamed; attempt += 1) {
          try {
            await fs.rename(temporary, pathFor(record.jobId));
            renamed = true;
          } catch (error) {
            if (!['EPERM', 'EBUSY'].includes(error?.code) || attempt === 2) throw error;
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
      await prune();
      return clone(record);
    });
    persistence = task.catch(() => {});
    return task;
  };

  const prune = async () => {
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return; }
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5);
      if (!DNA_JOB_ID_PATTERN.test(id)) continue;
      try {
        const value = normalizeStoredRecord(JSON.parse(await fs.readFile(pathFor(id), 'utf8')), id);
        if (value) candidates.push({ id, updatedAt: value.updatedAt });
      } catch {
        // Leave an unreadable record in place; it is safer to expose a
        // not-found/repair path than to delete user history implicitly.
      }
    }
    candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    for (const candidate of candidates.slice(Math.max(0, maxJobs))) {
      if (operations.has(candidate.id)) continue;
      await fs.rm(pathFor(candidate.id), { force: true }).catch(() => {});
      records.delete(candidate.id);
    }
  };

  const markRestarted = async (record) => {
    if (!record || DNA_JOB_TERMINAL_STATES.includes(record.state) || operations.has(record.jobId)) return record;
    const interruptedStage = normalizeStage(record.stage) ?? 'executing';
    const interrupted = {
      ...record,
      state: 'interrupted',
      // Preserve the last known execution stage; a crash must not invent a
      // sixth stage that Studio cannot render. Corrupt/legacy values fall
      // back to the neutral executing stage.
      stage: interruptedStage,
      updatedAt: now(),
      interruptedAt: now(),
      error: {
        code: 'bridge_restarted',
        stage: interruptedStage,
        message: 'Bridge 重启时 DNA job 未完成，已标记为中断',
      },
    };
    return persist(interrupted);
  };

  const load = async (jobId) => {
    const id = validId(jobId);
    if (records.has(id)) return records.get(id);
    try {
      const value = normalizeStoredRecord(JSON.parse(await fs.readFile(pathFor(id), 'utf8')), id);
      if (!value) return undefined;
      records.set(id, value);
      return markRestarted(value);
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined;
      return undefined;
    }
  };

  const transition = async (record, state, fields = {}) => {
    if (!DNA_JOB_STATES.includes(state)) fail(500, 'dna_job_state_invalid', 'DNA job 状态无效');
    if (record.state !== state && !TRANSITIONS[record.state]?.has(state)) {
      fail(409, 'dna_job_state_conflict', 'DNA job 状态不允许此操作', 'dna_job', { state: record.state });
    }
    const updated = {
      ...record,
      ...fields,
      state,
      updatedAt: now(),
    };
    return persist(updated);
  };

  const start = async (record, operation) => {
    let ready = false;
    try {
      await transition(record, 'running', { stage: 'validating_inputs', startedAt: now() });
      ready = true;
      operation.readyResolve?.();
      const current = records.get(record.jobId) ?? record;
      if (operation.controller.isCancelled()) {
        await transition(current, 'cancelled', {
          stage: 'executing',
          finishedAt: now(),
          error: { code: 'cancelled', stage: 'executing', message: 'DNA job 已停止，既有 DNA 未被覆盖' },
        });
        return;
      }
      const result = await runner(current.mode, {
        projectRoot,
        corpusSnapshotId: current.corpusSnapshotId,
        corpusSnapshot: operation.corpusSnapshot,
        cancelController: operation.controller,
        clientRunId: current.jobId,
        // Trusted DNA runners may collect their manifest in the staged
        // workspace before the atomic swap.  This closes the otherwise
        // observable gap where a runner has replaced the live workspace but
        // a post-run collector fails, leaving a failed job beside new DNA.
        artifactCollector,
        onStage: (nextStage) => {
          const stageName = normalizeStage(nextStage);
          if (!stageName) return;
          const existing = records.get(current.jobId);
          if (!existing || DNA_JOB_TERMINAL_STATES.includes(existing.state)) return;
          if (stageName === 'committing' && existing.state === 'running') {
            // This synchronous in-memory transition makes a concurrent
            // cancel request observe the non-cancellable commit boundary.
            const next = { ...existing, state: 'running', stage: stageName, updatedAt: now() };
            records.set(current.jobId, next);
            void persist(next).catch(() => {});
            operation.controller.beginCommit?.(stageName);
            setBusy(true, stageName);
          } else if (existing.state !== 'cancelling' && existing.state === 'running') {
            const next = { ...existing, stage: stageName, updatedAt: now() };
            records.set(current.jobId, next);
            void persist(next).catch(() => {});
            setBusy(true, stageName);
          }
        },
      });
      operation.committed = result?.artifactCommitted === true;
      operation.controller.throwIfCancelled('dna_distill');
      const afterRun = records.get(current.jobId) ?? current;
      // A runner that supports onStage must announce commit before it swaps
      // the workspace. Injected test runners may not; they remain cancellable
      // until this point and are still protected by throwIfCancelled above.
      if (afterRun.state === 'running' && afterRun.stage !== 'committing') {
        await transition(afterRun, 'running', { stage: 'committing' });
      }
      const manifest = result?.artifactManifest
        ?? await artifactCollector({
          mode: current.mode,
          projectRoot,
          workspaceRelative: workspaceForMode(current.mode),
          outputFiles: result?.outputFiles,
        });
      const immutableManifest = normalizeArtifactManifest(manifest);
      if (!immutableManifest) {
        fail(502, 'dna_artifact_failed', 'DNA artifact manifest 校验失败，未生成回执', 'artifact');
      }
      const completed = now();
      const receipt = {
        schemaVersion: DNA_JOB_RECEIPT_SCHEMA_VERSION,
        jobId: current.jobId,
        mode: current.mode,
        corpusSnapshotId: current.corpusSnapshotId ?? null,
        state: 'succeeded',
        artifactHash: immutableManifest.sha256,
        artifactManifest: immutableManifest,
        completedAt: completed,
      };
      await transition(records.get(current.jobId) ?? current, 'succeeded', {
        // The approved execution contract has exactly five stages.  A
        // terminal success record remains at the commit boundary so clients
        // can render the last real stage without inventing a sixth
        // "completed" value that Studio cannot consume.
        stage: 'committing',
        finishedAt: completed,
        summary: typeof result?.summary === 'string' ? safeMessage(result.summary, MAX_SUMMARY_CHARS) : '',
        outputFiles: normalizeOutputFiles(result?.outputFiles),
        artifactManifest: immutableManifest,
        artifactHash: immutableManifest.sha256,
        receipt,
        result: undefined,
      });
    } catch (error) {
      if (!ready) operation.readyResolve?.();
      const current = records.get(record.jobId) ?? record;
      const cancelled = operation.controller.isCancelled()
        || error?.code === 'cancelled'
        || current.state === 'cancelling';
      const terminalState = cancelled ? 'cancelled' : 'failed';
      const normalized = cancelled
        ? { code: 'cancelled', stage: typeof error?.stage === 'string' && DNA_JOB_STAGES.has(error.stage) ? error.stage : 'executing', message: 'DNA job 已停止，既有 DNA 未被覆盖' }
        : normalizeError(error);
      if (operation.committed && !cancelled) {
        // A trusted runner sets artifactCommitted only after its atomic
        // workspace swap.  If receipt construction still fails, keep the
        // record interrupted (receipt pending) instead of claiming that the
        // run failed while the new DNA is already live.  The interrupted
        // record is resumable and carries no fabricated success receipt.
        if (!DNA_JOB_TERMINAL_STATES.includes(current.state)) {
          await transition(current, 'interrupted', {
            stage: 'committing',
            finishedAt: now(),
            error: {
              code: 'receipt_pending',
              stage: 'committing',
              message: 'DNA 已提交但回执尚未生成，请恢复任务以重试回执',
            },
          }).catch(() => {});
        }
        return;
      }
      if (!DNA_JOB_TERMINAL_STATES.includes(current.state)) {
        await transition(current, terminalState, {
          stage: normalized.stage,
          finishedAt: now(),
          error: normalized,
        }).catch(() => {});
      }
    } finally {
      operations.delete(record.jobId);
      if (activeJobId === record.jobId) activeJobId = undefined;
      setBusy(false, 'idle');
    }
  };

  const create = async ({ jobId: requestedId = undefined, idempotencyKey = undefined, mode, resume = false, corpusSnapshotId = undefined } = {}) => {
    validMode(mode);
    if (requestedId !== undefined && idempotencyKey !== undefined && requestedId !== idempotencyKey) {
      fail(409, 'job_conflict', 'jobId 与 idempotencyKey 不一致', 'validation');
    }
    if (corpusSnapshotId !== undefined) {
      if (typeof corpusSnapshotId !== 'string' || !CORPUS_SNAPSHOT_ID_PATTERN.test(corpusSnapshotId)) {
        fail(400, 'invalid_request', 'corpusSnapshotId 格式无效', 'validation');
      }
      if (typeof resolveCorpusSnapshot !== 'function') {
        fail(503, 'corpus_unavailable', '语料快照解析器当前不可用', 'validation');
      }
    }
    const jobId = validId(requestedId ?? idempotencyKey ?? randomUUID());
    let corpusSnapshot;
    if (corpusSnapshotId !== undefined) {
      corpusSnapshot = await resolveCorpusSnapshot(corpusSnapshotId, { mode });
      if (!corpusSnapshot) fail(404, 'corpus_snapshot_not_found', '语料快照不存在', 'validation');
    }
    const existing = await load(jobId);
    if (existing) {
      if (existing.requestHash !== requestHash(mode, corpusSnapshotId) || existing.mode !== mode) {
        fail(409, 'job_conflict', 'jobId 已被其他 DNA 模式占用', 'dna_job');
      }
      if (resume && existing.state === 'interrupted') {
        // Explicit resume is opt-in; ordinary duplicate POST remains safely
        // idempotent and never starts a second process.
        records.delete(jobId);
        await fs.rm(pathFor(jobId), { force: true }).catch(() => {});
      } else {
        return { record: clone(existing), created: false };
      }
    }
    if (activeJobId || isBusy()) fail(409, 'busy', '本机 Codex 正在处理其他 DNA job，请稍后重试', 'dna_job');
    const record = makeRecord(jobId, mode, {
      ...(corpusSnapshotId ? { corpusSnapshotId } : {}),
      ...(resume ? { resumedAt: now() } : {}),
    });
    const controller = createCancellationController();
    const operation = {
      controller,
      started: false,
      committed: false,
      ready: undefined,
      readyResolve: undefined,
    };
    operation.ready = new Promise((resolve) => { operation.readyResolve = resolve; });
    controller.begin({ clientRunId: jobId, stage: 'validating_inputs', kind: 'dna_job' });
    activeJobId = jobId;
    operations.set(jobId, operation);
    // Reserve the single Bridge slot before the first await, closing the
    // race with /v1/content and legacy /v1/dna/distill.
    setBusy(true, 'dna_job');
    try {
      await persist(record);
      // Start in the next microtask after the queued record is durable. The
      // caller receives a stable job id while GET can immediately observe a
      // running/stopping state.
      operation.started = true;
      operation.corpusSnapshot = corpusSnapshot;
      const running = start(record, operation);
      operation.promise = running;
      await operation.ready;
      void running;
      return { record: clone(records.get(jobId) ?? record), created: true };
    } catch (error) {
      operations.delete(jobId);
      activeJobId = undefined;
      setBusy(false, 'idle');
      throw error;
    }
  };

  const get = async (jobId) => {
    const record = await load(jobId);
    return record ? clone(record) : undefined;
  };

  const cancel = async (jobId) => {
    const record = await load(jobId);
    if (!record) fail(404, 'job_not_found', 'DNA job 不存在', 'dna_job');
    if (DNA_JOB_TERMINAL_STATES.includes(record.state)) {
      fail(409, 'job_terminal', '终态 DNA job 不可取消', 'dna_job', { state: record.state });
    }
    if (record.state === 'running' && record.stage === 'committing') {
      fail(409, 'job_committing', 'DNA job 正在提交产物，当前不可取消', 'committing');
    }
    const operation = operations.get(record.jobId);
    if (!operation) {
      const interrupted = await markRestarted(record);
      fail(409, 'job_interrupted', 'DNA job 已因 Bridge 重启中断，请显式恢复', 'bridge', { state: interrupted?.state });
    }
    const stopping = await transition(record, 'cancelling', {
          stage: record.stage || 'executing',
      cancelRequestedAt: now(),
    });
    const cancelResult = operation.controller.cancel(record.jobId);
    return {
      ...stopping,
      cancel: {
        code: cancelResult?.code ?? 'cancel_requested',
        status: cancelResult?.status ?? 'cancelling',
      },
    };
  };

  const remove = async (jobId) => {
    const record = await load(jobId);
    if (!record) return false;
    if (!DNA_JOB_TERMINAL_STATES.includes(record.state)) {
      fail(409, 'job_not_terminal', '仅终态 DNA job 可以删除', 'dna_job', { state: record.state });
    }
    records.delete(record.jobId);
    // Drain all prior atomic writes before unlinking; otherwise a queued
    // stage update can recreate a job immediately after DELETE succeeds.
    await persistence.catch(() => {});
    await fs.rm(pathFor(record.jobId), { force: true });
    return true;
  };

  const usages = async (skillChain = []) => {
    if (!Array.isArray(skillChain)) return [];
    const output = [];
    for (const id of skillChain) {
      const mode = id === 'writing-dna' ? 'writing' : id === 'academic-writing-dna' ? 'academic' : undefined;
      if (!mode) continue;
      // Prefer the most recent successful job for this mode.  If no job exists
      // (legacy artifacts created before v29), the bridge caller may add a
      // deterministic fallback entry with the current artifact path.
      let latest;
      for (const record of records.values()) {
        if (record.mode !== mode || record.state !== 'succeeded' || !record.receipt) continue;
        if (!latest || String(record.finishedAt ?? '').localeCompare(String(latest.finishedAt ?? '')) > 0) latest = record;
      }
      if (!latest) {
        let entries;
        try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { entries = []; }
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
          const idValue = entry.name.slice(0, -5);
          if (!DNA_JOB_ID_PATTERN.test(idValue)) continue;
          const record = await load(idValue);
          if (record?.mode !== mode || record.state !== 'succeeded' || !record.receipt) continue;
          if (!latest || String(record.finishedAt ?? '').localeCompare(String(latest.finishedAt ?? '')) > 0) latest = record;
        }
      }
      if (latest) {
        output.push({
          id,
          mode,
          ready: true,
          artifact: latest.artifactManifest?.workspace
            ? `${latest.artifactManifest.workspace}/${latest.artifactManifest.files?.find((file) => file.path === (mode === 'academic' ? 'Academic-Writing-DNA.md' : 'Writing-DNA.md'))?.path
              ?? latest.artifactManifest.files?.[0]?.path
              ?? ''}`.replace(/\/$/u, '')
            : null,
          artifactHash: latest.artifactHash ?? latest.receipt?.artifactHash ?? null,
          jobId: latest.jobId,
          receipt: clone(latest.receipt),
        });
      } else {
        output.push({ id, mode, ready: false, artifact: null, artifactHash: null, jobId: null, receipt: null });
      }
    }
    return output;
  };

  return {
    directory: root,
    create,
    get,
    cancel,
    remove,
    usages,
    isBusy: () => Boolean(activeJobId),
    activeJobId: () => activeJobId,
    // Exposed for deterministic unit tests and graceful host shutdowns; the
    // HTTP surface intentionally has no blanket cancel endpoint for jobs.
    _operations: operations,
  };
}
