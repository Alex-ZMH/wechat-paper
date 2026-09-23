import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Delivery persistence is deliberately independent from the content store.
 * The content store owns immutable text revisions; this store only appends
 * delivery-manifest and publish state events.  Events are never edited in
 * place, and each new snapshot is atomically replaced on disk so a crash
 * cannot leave a partially written JSON document.
 */
export const DELIVERY_STORE_SCHEMA_VERSION = 'content-desk.delivery-store.v1';
export const DELIVERY_STORE_FILE_NAME = 'multipost-deliveries.v1.json';
const SENSITIVE_KEY = /(?:token|authorization|cookie|password|secret|api[_-]?key|credential|private[_-]?key)/iu;
const LOCK_WAIT_MS = 5;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30_000;

export class DeliveryStoreError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'DeliveryStoreError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(status, code, message, details = undefined) {
  throw new DeliveryStoreError(status, code, message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function resolveLocalAppData(env = process.env) {
  const configured = typeof env.LOCALAPPDATA === 'string' ? env.LOCALAPPDATA.trim() : '';
  if (configured) return path.resolve(configured);
  if (process.platform === 'win32') return path.join(os.homedir(), 'AppData', 'Local');
  const xdg = typeof env.XDG_STATE_HOME === 'string' ? env.XDG_STATE_HOME.trim() : '';
  return xdg ? path.resolve(xdg) : path.join(os.homedir(), '.local', 'state');
}

export function defaultDeliveryStorePath(env = process.env) {
  return path.join(resolveLocalAppData(env), 'ContentDesk', DELIVERY_STORE_FILE_NAME);
}

function assertSafeEvent(value, depth = 0) {
  if (depth > 12) fail(500, 'delivery_store_event_invalid', '发送事件嵌套过深');
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') {
    if (value.length > 100_000) fail(500, 'delivery_store_event_invalid', '发送事件文本超出限制');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) fail(500, 'delivery_store_event_invalid', '发送事件数组超出限制');
    value.forEach((item) => assertSafeEvent(item, depth + 1));
    return;
  }
  if (!isPlainObject(value)) fail(500, 'delivery_store_event_invalid', '发送事件格式无效');
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) || key === '__proto__' || key === 'constructor' || key === 'prototype') {
      fail(500, 'delivery_store_sensitive_field', '发送事件不得包含凭据字段');
    }
    if (key.length > 128) fail(500, 'delivery_store_event_invalid', '发送事件字段名超出限制');
    assertSafeEvent(item, depth + 1);
  }
}

function normalizeEnvelope(value) {
  if (!isPlainObject(value) || value.schemaVersion !== DELIVERY_STORE_SCHEMA_VERSION || !Array.isArray(value.events)) {
    fail(500, 'delivery_store_corrupt', '发送状态存储格式无效');
  }
  if (value.events.length > 100_000) fail(500, 'delivery_store_corrupt', '发送状态事件过多');
  value.events.forEach((event) => {
    if (!isPlainObject(event) || typeof event.eventId !== 'string' || !event.eventId || typeof event.type !== 'string') {
      fail(500, 'delivery_store_corrupt', '发送状态事件格式无效');
    }
    assertSafeEvent(event);
  });
  return value;
}

export function createDeliveryStore({ filePath = undefined, env = process.env } = {}) {
  const target = path.resolve(filePath ?? defaultDeliveryStorePath(env));
  const root = path.dirname(target);
  const lockPath = `${target}.lock`;
  let mutation = Promise.resolve();

  const readEnvelope = async () => {
    try {
      const value = JSON.parse(await fs.readFile(target, 'utf8'));
      return normalizeEnvelope(value);
    } catch (error) {
      if (error?.code === 'ENOENT') return { schemaVersion: DELIVERY_STORE_SCHEMA_VERSION, events: [] };
      if (error instanceof DeliveryStoreError) throw error;
      fail(500, 'delivery_store_read_failed', '发送状态读取失败');
    }
  };

  const writeEnvelope = async (value) => {
    await fs.mkdir(root, { recursive: true });
    const temporary = path.join(root, `.${path.basename(target)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      // Windows can briefly hold the destination while a reader (or an
      // antivirus/indexer) closes its handle.  Keep the replacement atomic,
      // but retry the rename for a short bounded window instead of surfacing
      // a transient EPERM as a false delivery-store failure.
      let lastError;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          await fs.rename(temporary, target);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt === 99) throw error;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      if (lastError) throw lastError;
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  };

  const acquireFileLock = async () => {
    const started = Date.now();
    while (Date.now() - started < LOCK_TIMEOUT_MS) {
      let handle;
      let lockId;
      try {
        await fs.mkdir(root, { recursive: true });
        lockId = randomUUID();
        handle = await fs.open(lockPath, 'wx');
        await handle.writeFile(JSON.stringify({
          pid: process.pid,
          lockId,
          createdAt: new Date().toISOString(),
        }), 'utf8');
        return async () => {
          await handle.close().catch(() => {});
          // A stale owner may finish after its lock was reclaimed.  Verify
          // the marker still belongs to this acquisition before removing it;
          // otherwise an old release could delete a newer owner's lock.
          try {
            const marker = JSON.parse(await fs.readFile(lockPath, 'utf8'));
            if (marker?.lockId === lockId) await fs.rm(lockPath, { force: true });
          } catch (error) {
            // ENOENT means another owner already released it.  Malformed or
            // replaced markers are left untouched so a live owner is safe.
            if (error?.code !== 'ENOENT') return;
          }
        };
      } catch (error) {
        if (handle) {
          await handle.close().catch(() => {});
          // We only own the marker if this acquisition created it.  If a
          // write failed after another process replaced the path, do not
          // remove that process's lock.
          try {
            const marker = JSON.parse(await fs.readFile(lockPath, 'utf8'));
            if (marker?.lockId === lockId) await fs.rm(lockPath, { force: true });
          } catch (cleanupError) {
            // Leave an unreadable/replaced marker in place; the normal stale
            // marker path below will decide whether it is safe to reclaim.
          }
        }
        if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
        // A crashed Bridge can leave the marker behind.  Only reclaim a lock
        // that is well beyond the bounded write window; never delete a live
        // peer's marker while it may still be replacing the JSON atomically.
        try {
          const stat = await fs.stat(lockPath);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) await fs.rm(lockPath, { force: true });
        } catch (statError) {
          if (statError?.code !== 'ENOENT') throw statError;
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
      }
    }
    fail(503, 'delivery_store_locked', '发送状态存储正被其他 Bridge 实例使用');
  };

  const mutate = (fn) => {
    const task = mutation.then(async () => {
      const release = await acquireFileLock();
      try {
        return await fn(await readEnvelope());
      } finally {
        await release();
      }
    });
    mutation = task.catch(() => {});
    return task;
  };

  return Object.freeze({
    filePath: target,
    async readEvents() {
      const task = mutation.then(async () => {
        const envelope = await readEnvelope();
        return cloneJson(envelope.events);
      });
      mutation = task.catch(() => {});
      return task;
    },
    async append(event) {
      if (!isPlainObject(event)) fail(400, 'delivery_event_invalid', '发送事件必须是对象');
      const expectedEventCount = event.expectedEventCount;
      if (expectedEventCount !== undefined
        && (!Number.isSafeInteger(expectedEventCount) || expectedEventCount < 0)) {
        fail(400, 'delivery_event_cas_invalid', '发送事件版本无效');
      }
      const entry = {
        eventId: randomUUID(),
        createdAt: new Date().toISOString(),
        ...cloneJson(event),
      };
      assertSafeEvent(entry);
      return mutate(async (envelope) => {
        // Intent events use an event-count compare-and-swap.  The check lives
        // inside the store's serialized read/modify/write queue so a stale
        // caller cannot append an operation after another writer has won.
        if (expectedEventCount !== undefined && envelope.events.length !== expectedEventCount) {
          fail(409, 'delivery_event_cas_failed', '发送任务状态已变化');
        }
        envelope.events = [...envelope.events, entry];
        await writeEnvelope(envelope);
        return cloneJson(entry);
      });
    },
  });
}
