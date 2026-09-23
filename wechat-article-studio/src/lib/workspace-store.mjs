import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { ContractError, freezeContract, requiredText } from './primitives.mjs';

export const WORKSPACE_SCHEMA_VERSION = 'wechat-article-studio.workspace.v2';
export const LEGACY_WORKSPACE_SCHEMA_VERSION = 'wechat-article-studio.workspace.v1';

const QA_MARKERS = ['qa-annotation', '（浏览器人工编辑验收）', '（人工编辑验收）', '（浏览器批注修订）'];

function containsLegacyMarker(value) {
  try {
    const serialized = JSON.stringify(value);
    return QA_MARKERS.some((marker) => serialized.includes(marker));
  } catch {
    return false;
  }
}

function asWorkspaceId(value) {
  const id = String(value ?? '').trim();
  return id || `workspace_${randomUUID()}`;
}

/**
 * Local, file-backed workspace storage. A workspace is an editor snapshot,
 * not a replacement for any of the evidence or draft contracts.
 */
export class LocalWorkspaceStore {
  #filePath;
  #workspaces = new Map();
  #loadError = null;

  constructor({ filePath } = {}) {
    this.#filePath = filePath;
    this.#load();
  }

  #load() {
    if (!this.#filePath) return;
    try {
      const parsed = JSON.parse(readFileSync(this.#filePath, 'utf8'));
      const candidates = Array.isArray(parsed?.workspaces) ? parsed.workspaces : parsed?.workspace ? [parsed.workspace] : [];
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object' || !candidate.payload) continue;
        const isV1 = candidate.schemaVersion === LEGACY_WORKSPACE_SCHEMA_VERSION;
        if (!isV1 && candidate.schemaVersion !== WORKSPACE_SCHEMA_VERSION) continue;
        const contaminated = containsLegacyMarker(candidate);
        const workspaceId = asWorkspaceId(candidate.workspaceId ?? candidate.id ?? candidate.sessionId);
        const migrated = {
          schemaVersion: WORKSPACE_SCHEMA_VERSION,
          workspaceId,
          sessionId: candidate.sessionId ?? null,
          mode: candidate.mode ?? 'unknown',
          version: Number.isInteger(candidate.version) && candidate.version > 0 ? candidate.version : 1,
          createdAt: candidate.createdAt ?? candidate.savedAt ?? new Date(0).toISOString(),
          savedAt: candidate.savedAt ?? new Date(0).toISOString(),
          payload: candidate.payload,
          annotationHistory: Array.isArray(candidate.annotationHistory) ? candidate.annotationHistory : [],
          revisionHistory: Array.isArray(candidate.revisionHistory) ? candidate.revisionHistory : [],
          humanApproval: candidate.humanApproval ?? null,
          legacy: Boolean(candidate.legacy || contaminated),
          needsExplicitRestore: Boolean(candidate.needsExplicitRestore || contaminated),
        };
        this.#workspaces.set(workspaceId, freezeContract(migrated));
        if (migrated.legacy && isV1) this.#backupLegacy();
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // Preserve the only on-disk copy before allowing recovery saves.
        // If the backup fails, refuse writes rather than overwrite it.
        try { copyFileSync(this.#filePath, `${this.#filePath}.corrupt-${Date.now()}-${randomUUID()}.bak`); }
        catch (backupError) { this.#loadError = backupError; }
        console.error(`Workspace cache could not be loaded; original preserved: ${error.message}`);
      }
    }
  }

  #backupLegacy() {
    if (!this.#filePath) return;
    const backup = `${this.#filePath}.legacy-backup.json`;
    try {
      if (!existsSync(backup)) copyFileSync(this.#filePath, backup);
    } catch (error) {
      console.error(`Legacy workspace backup could not be created: ${error.message}`);
    }
  }

  #persist() {
    if (!this.#filePath) throw new ContractError('persistence_failed', 'Workspace persistence path is not configured');
    if (this.#loadError) throw new ContractError('persistence_failed', 'The original workspace could not be backed up; recovery save was refused');
    try {
      mkdirSync(dirname(this.#filePath), { recursive: true });
      const temporary = join(dirname(this.#filePath), `.${Date.now()}-${randomUUID()}.tmp`);
      writeFileSync(temporary, JSON.stringify({ version: 2, workspaces: [...this.#workspaces.values()] }, null, 2), 'utf8');
      renameSync(temporary, this.#filePath);
    } catch (error) {
      throw new ContractError('persistence_failed', `Workspace could not be saved locally: ${error.message}`);
    }
  }

  save({
    workspaceId,
    baseVersion = 0,
    sessionId = null,
    mode = 'unknown',
    payload,
    annotationHistory = [],
    revisionHistory = [],
    humanApproval = null,
    legacy = false,
    needsExplicitRestore = false,
  } = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ContractError('workspace_invalid', 'Workspace payload must be an object');
    }
    const id = asWorkspaceId(workspaceId);
    const existing = this.#workspaces.get(id) ?? null;
    const expectedBase = Number.isInteger(baseVersion) ? baseVersion : Number(baseVersion || 0);
    if (!Number.isInteger(expectedBase) || expectedBase < 0) {
      throw new ContractError('workspace_version_invalid', 'workspace.baseVersion must be a non-negative integer', { baseVersion });
    }
    if (existing && expectedBase !== existing.version) {
      throw new ContractError('workspace_conflict', 'Workspace changed since it was loaded. Refresh before saving again.', {
        workspaceId: id,
        expectedVersion: existing.version,
        receivedBaseVersion: expectedBase,
      });
    }
    if (!existing && expectedBase !== 0) {
      throw new ContractError('workspace_conflict', 'The requested workspace does not exist at that version.', {
        workspaceId: id,
        expectedVersion: 0,
        receivedBaseVersion: expectedBase,
      });
    }
    const now = new Date().toISOString();
    const workspace = freezeContract({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      workspaceId: id,
      sessionId: sessionId == null ? (existing?.sessionId ?? null) : String(sessionId),
      mode: requiredText(mode || existing?.mode || 'unknown', 'workspace.mode'),
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      savedAt: now,
      payload,
      annotationHistory: Array.isArray(annotationHistory) ? annotationHistory : [],
      revisionHistory: Array.isArray(revisionHistory) ? revisionHistory : [],
      humanApproval: humanApproval ?? null,
      legacy: Boolean(legacy),
      needsExplicitRestore: Boolean(needsExplicitRestore),
    });
    this.#workspaces.set(id, workspace);
    try {
      this.#persist();
    } catch (error) {
      if (existing) this.#workspaces.set(id, existing);
      else this.#workspaces.delete(id);
      throw error;
    }
    return workspace;
  }

  get(workspaceId) {
    return this.#workspaces.get(String(workspaceId ?? '')) ?? null;
  }

  list({ includeLegacy = true } = {}) {
    return [...this.#workspaces.values()]
      .filter((workspace) => includeLegacy || !workspace.needsExplicitRestore)
      .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
      .map((workspace) => ({
        workspaceId: workspace.workspaceId,
        sessionId: workspace.sessionId,
        // Do not surface known QA/test text in the reader-facing picker. The
        // complete snapshot remains available through the explicit restore
        // endpoint and the internal audit backup.
        topic: workspace.needsExplicitRestore ? '' : (workspace.payload?.brief?.topic ?? ''),
        title: workspace.needsExplicitRestore
          ? '早期保存文章（需检查）'
          : (workspace.payload?.draft?.title ?? workspace.payload?.brief?.topic ?? '未命名文章'),
        version: workspace.version,
        savedAt: workspace.savedAt,
        mode: workspace.mode,
        legacy: workspace.legacy,
        needsExplicitRestore: workspace.needsExplicitRestore,
      }));
  }

  latest({ includeLegacy = false } = {}) {
    return [...this.#workspaces.values()]
      .filter((workspace) => includeLegacy || !workspace.needsExplicitRestore)
      .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))[0] ?? null;
  }

  restoreLegacy(workspaceId) {
    const workspace = this.get(workspaceId);
    if (!workspace) throw new ContractError('workspace_not_found', 'Workspace was not found', { workspaceId });
    if (!workspace.needsExplicitRestore) return workspace;
    const restored = freezeContract({
      ...workspace,
      legacy: false,
      needsExplicitRestore: false,
      restoredFromLegacy: workspace.workspaceId,
    });
    this.#workspaces.set(restored.workspaceId, restored);
    this.#persist();
    return restored;
  }
}
