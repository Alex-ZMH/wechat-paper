/*
 * Isolated HTTP acceptance for the workspace save/review/finalization gates.
 *
 * This script deliberately runs on 43211 with a copy of the checked-in
 * acceptance fixture. It never writes the user-facing data directory or the
 * 43210 service. The fixture copy is removed in finally; the concise evidence
 * JSON is kept under evaluation/ for audit.
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SOURCE_DATA_DIR = join(ROOT, 'data', 'acceptance-20260904-run1');
const ISOLATED_DATA_DIR = join(ROOT, 'data', '.acceptance-workspace-gates-20260904-run1');
const EVIDENCE_PATH = join(ROOT, 'evaluation', 'acceptance-workspace-gates-20260904.json');
const AUDIT_EVIDENCE_PATH = join(ROOT, 'evaluation', 'acceptance-workspace-gates-20260904.audit.jsonl');
const PORT = 43211;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOPIC = '凹凸棒石在新能源领域面临的挑战与实际应用';
const MISSING_CODEX = join(ISOLATED_DATA_DIR, 'missing-codex.exe');

const evidence = {
  schemaVersion: 'wechat-article-studio.acceptance-evidence.v1',
  startedAt: new Date().toISOString(),
  sourceData: relative(ROOT, SOURCE_DATA_DIR),
  isolatedData: relative(ROOT, ISOLATED_DATA_DIR),
  port: PORT,
  topic: TOPIC,
  // This script exercises the API contract only; it is not a substitute for
  // the user's browser/manual acceptance of the workbench.
  api_finalize_is_test_not_user_acceptance: true,
  steps: [],
  assertions: [],
  status: 'running',
};

function recordStep(name, details = {}) {
  evidence.steps.push({ name, ...details });
}

function recordAssertion(name, passed, details = {}) {
  evidence.assertions.push({ name, passed, ...details });
  if (!passed) throw new Error(`${name} failed`);
}

async function requestJson(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    // Binary responses are intentionally handled by requestRaw below.
  }
  return { status: response.status, headers: response.headers, body: parsed, raw };
}

async function requestRaw(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    headers: response.headers,
    bytes: Buffer.from(await response.arrayBuffer()),
  };
}

function firstParagraph(payload) {
  return payload?.draft?.sections?.flatMap((section) => section.paragraphs ?? [])[0] ?? null;
}

function saveBody(workspace, { baseVersion, payload, annotationHistory = [], resolvedAnnotationIds = [] }) {
  return {
    workspaceId: workspace.workspaceId,
    baseVersion,
    sessionId: workspace.sessionId,
    mode: workspace.mode,
    payload,
    annotationHistory,
    resolvedAnnotationIds,
  };
}

async function waitForHealth(child) {
  const deadline = Date.now() + 15000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`isolated server exited before health check (${child.exitCode})`);
    try {
      const result = await requestJson('/api/health');
      if (result.status === 200 && result.body?.ok === true) return result.body;
      lastError = new Error(`health returned ${result.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`isolated server health timeout: ${lastError?.message ?? 'unknown error'}`);
}

function startServer() {
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      WECHAT_STUDIO_PORT: String(PORT),
      WECHAT_STUDIO_DATA_DIR: ISOLATED_DATA_DIR,
      // Make the writer failure assertion deterministic. The resolver must
      // report this explicit path and must not use SINGLE_AGENT_TESTER... as a
      // silent fallback.
      CODEX_BIN: MISSING_CODEX,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const logs = { stdout: '', stderr: '' };
  child.stdout?.on('data', (chunk) => { logs.stdout += String(chunk); });
  child.stderr?.on('data', (chunk) => { logs.stderr += String(chunk); });
  child.acceptanceLogs = logs;
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolveStop) => {
    const timer = setTimeout(resolveStop, 4000);
    child.once('close', () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill();
  });
}

async function run() {
  rmSync(ISOLATED_DATA_DIR, { recursive: true, force: true });
  cpSync(SOURCE_DATA_DIR, ISOLATED_DATA_DIR, { recursive: true });
  let child = null;
  try {
    child = startServer();
    evidence.serverPid = child.pid;
    const health = await waitForHealth(child);
    recordStep('isolated_server_started', { health, pid: child.pid });

    const listed = await requestJson('/api/workspaces');
    assert.equal(listed.status, 200);
    const candidates = (listed.body?.workspaces ?? []).filter((item) => item.topic === TOPIC);
    recordAssertion('fixture_workspace_topic_is_exact', candidates.length === 1, {
      candidates: candidates.map((item) => ({ workspaceId: item.workspaceId, version: item.version })),
    });
    let workspace = (await requestJson(`/api/workspace/${encodeURIComponent(candidates[0].workspaceId)}`)).body.workspace;
    const initialVersion = workspace.version;
    const sessionId = workspace.sessionId;
    recordStep('fixture_loaded', {
      workspaceId: workspace.workspaceId,
      sessionId,
      version: initialVersion,
      mode: workspace.mode,
      provider: workspace.payload?.researchSession?.provider,
    });
    recordAssertion('fixture_is_human_verified_only', workspace.payload?.researchSession?.provider === 'human_curated', {
      provider: workspace.payload?.researchSession?.provider,
    });
    recordAssertion('fixture_has_confirmed_argument_map', workspace.payload?.argumentMap?.status === 'confirmed');

    const paragraph = firstParagraph(workspace.payload);
    assert.ok(paragraph?.paragraphId, 'fixture must contain a paragraph');
    const annotationId = 'acceptance-high-open-20260904';
    const highAnnotation = {
      annotationId,
      kind: 'replace_paragraph',
      targetParagraphId: paragraph.paragraphId,
      instruction: '验收：保留高优先级未解决批注以阻断正式定稿。',
      replacementText: paragraph.text,
      priority: 'high',
      status: 'open',
    };

    let response = await requestJson('/api/workspace', {
      method: 'POST',
      body: saveBody(workspace, {
        baseVersion: workspace.version,
        payload: workspace.payload,
        annotationHistory: [highAnnotation],
      }),
    });
    assert.equal(response.status, 200);
    workspace = response.body.workspace;
    recordStep('save_high_open_annotation', {
      version: workspace.version,
      reviewStatus: workspace.payload?.reviewReport?.status,
      annotationStatuses: workspace.annotationHistory?.map((item) => ({ annotationId: item.annotationId, status: item.status })),
    });
    recordAssertion('high_open_annotation_blocks_review', workspace.payload?.reviewReport?.status === 'review_required');
    recordAssertion('high_open_annotation_is_persisted', workspace.annotationHistory?.some((item) => item.annotationId === annotationId && item.status === 'open'));

    response = await requestJson('/api/workspace', {
      method: 'POST',
      body: saveBody(workspace, {
        baseVersion: workspace.version,
        payload: workspace.payload,
        annotationHistory: [],
      }),
    });
    assert.equal(response.status, 200);
    workspace = response.body.workspace;
    recordStep('empty_annotation_save', {
      version: workspace.version,
      reviewStatus: workspace.payload?.reviewReport?.status,
    });
    recordAssertion('empty_annotation_save_does_not_clear_gate', workspace.annotationHistory?.some((item) => item.annotationId === annotationId && item.status === 'open'));
    recordAssertion('empty_annotation_review_remains_blocked', workspace.payload?.reviewReport?.status === 'review_required');

    response = await requestJson('/api/workspace/review', {
      method: 'POST',
      body: saveBody(workspace, {
        baseVersion: workspace.version,
        payload: workspace.payload,
        annotationHistory: [],
      }),
    });
    assert.equal(response.status, 200);
    recordStep('side_effect_free_review', {
      version: response.body?.version,
      reviewStatus: response.body?.reviewReport?.status,
    });
    recordAssertion('review_route_preserves_high_gate', response.body?.reviewReport?.status === 'review_required');
    recordAssertion('review_route_preserves_full_annotation_history', response.body?.annotationHistory?.some((item) => item.annotationId === annotationId && item.status === 'open'));

    response = await requestJson(`/api/workspace/${encodeURIComponent(workspace.workspaceId)}/finalize`, {
      method: 'POST',
      body: { version: workspace.version },
    });
    recordStep('finalize_with_open_high_rejected', { status: response.status, error: response.body?.error });
    recordAssertion('finalize_rejects_open_high', response.status !== 200 && response.body?.error === 'review_required', {
      status: response.status,
      error: response.body?.error,
    });

    await stopServer(child);
    child = startServer();
    evidence.serverPidAfterRestart = child.pid;
    await waitForHealth(child);
    response = await requestJson(`/api/workspace/${encodeURIComponent(workspace.workspaceId)}`);
    assert.equal(response.status, 200);
    workspace = response.body.workspace;
    recordStep('restart_restore_check', {
      version: workspace.version,
      reviewStatus: workspace.payload?.reviewReport?.status,
      openHighCount: workspace.annotationHistory?.filter((item) => item.annotationId === annotationId && item.status === 'open').length,
    });
    recordAssertion('restart_restores_open_high_gate', workspace.annotationHistory?.some((item) => item.annotationId === annotationId && item.status === 'open'));
    recordAssertion('restart_restores_review_required', workspace.payload?.reviewReport?.status === 'review_required');

    response = await requestJson('/api/workspace', {
      method: 'POST',
      body: saveBody(workspace, {
        baseVersion: workspace.version,
        payload: workspace.payload,
        annotationHistory: [],
        resolvedAnnotationIds: [annotationId],
      }),
    });
    assert.equal(response.status, 200);
    workspace = response.body.workspace;
    recordStep('explicit_resolve', {
      version: workspace.version,
      reviewStatus: workspace.payload?.reviewReport?.status,
      humanApproval: workspace.humanApproval,
    });
    recordAssertion('explicit_resolve_recomputes_approved', workspace.payload?.reviewReport?.status === 'approved');
    recordAssertion('explicit_resolve_does_not_fake_human_approval', workspace.humanApproval == null);
    recordAssertion('resolved_annotation_is_persisted', workspace.annotationHistory?.some((item) => item.annotationId === annotationId && item.status === 'resolved'));

    const preFinalizeVersion = workspace.version;
    const unfinalizedExport = await requestRaw('/api/export/word', {
      method: 'POST',
      body: { workspaceId: workspace.workspaceId, version: preFinalizeVersion, approved: true },
    });
    const disposition = unfinalizedExport.headers.get('content-disposition') ?? '';
    const encodedFilename = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1] ?? '';
    const decodedFilename = encodedFilename ? decodeURIComponent(encodedFilename) : disposition;
    recordStep('export_with_forged_approved_flag', {
      status: unfinalizedExport.status,
      contentType: unfinalizedExport.headers.get('content-type'),
      disposition,
      decodedFilename,
      bytes: unfinalizedExport.bytes.byteLength,
    });
    recordAssertion('forged_approved_export_is_still_review_draft', unfinalizedExport.status === 200 && decodedFilename.includes('审阅稿'), {
      decodedFilename,
    });
    recordAssertion('export_is_docx', unfinalizedExport.bytes.slice(0, 2).toString() === 'PK');

    response = await requestJson(`/api/workspace/${encodeURIComponent(workspace.workspaceId)}/finalize`, {
      method: 'POST',
      body: { version: preFinalizeVersion },
    });
    assert.equal(response.status, 200);
    workspace = response.body.workspace;
    const finalizedVersion = workspace.version;
    recordStep('finalize_after_resolution', {
      version: finalizedVersion,
      humanApproval: workspace.humanApproval,
    });
    recordAssertion('server_records_human_approval_only_on_finalize', workspace.humanApproval?.version === finalizedVersion);

    const oldDraftHash = workspace.payload?.draft?.draftHash;
    const oldRevision = Number(workspace.payload?.draft?.revision ?? 0);
    const editedPayload = structuredClone(workspace.payload);
    const editedParagraph = firstParagraph(editedPayload);
    editedParagraph.text = `${editedParagraph.text} 编辑验证。`;
    response = await requestJson('/api/workspace', {
      method: 'POST',
      body: saveBody(workspace, {
        baseVersion: finalizedVersion,
        payload: editedPayload,
        annotationHistory: [],
      }),
    });
    assert.equal(response.status, 200);
    workspace = response.body.workspace;
    recordStep('edit_after_finalize', {
      previousVersion: finalizedVersion,
      version: workspace.version,
      previousDraftHash: oldDraftHash,
      draftHash: workspace.payload?.draft?.draftHash,
      revision: workspace.payload?.draft?.revision,
      revisionHistoryCount: workspace.revisionHistory?.length,
    });
    recordAssertion('content_edit_invalidates_human_approval', workspace.humanApproval == null);
    recordAssertion('content_edit_increments_revision', Number(workspace.payload?.draft?.revision) > oldRevision, {
      previousRevision: oldRevision,
      revision: workspace.payload?.draft?.revision,
    });
    recordAssertion('old_draft_is_retained_in_history', workspace.revisionHistory?.some((entry) => entry.draftHash === oldDraftHash));

    const staleSave = await requestJson('/api/workspace', {
      method: 'POST',
      body: saveBody(workspace, {
        baseVersion: finalizedVersion,
        payload: workspace.payload,
        annotationHistory: [],
      }),
    });
    recordStep('stale_version_rejected', { status: staleSave.status, error: staleSave.body?.error });
    recordAssertion('stale_version_cannot_overwrite_current_edit', staleSave.status === 409 && staleSave.body?.error === 'workspace_conflict', {
      status: staleSave.status,
      error: staleSave.body?.error,
    });

    const writerResponse = await requestJson(`/api/research/${encodeURIComponent(sessionId)}/draft`, {
      method: 'POST',
      body: { provider: 'codex-cli', model: 'gpt-5.6-sol' },
    });
    recordStep('writer_missing_executable', {
      status: writerResponse.status,
      error: writerResponse.body?.error,
      details: writerResponse.body?.details,
    });
    recordAssertion('writer_missing_executable_fails_closed', writerResponse.status === 503 && writerResponse.body?.error === 'writer_unavailable', {
      status: writerResponse.status,
      error: writerResponse.body?.error,
    });
    recordAssertion('writer_failure_returns_no_draft', writerResponse.body?.draft == null);

    const auditPath = join(ISOLATED_DATA_DIR, 'server-audit.jsonl');
    const auditEntries = existsSync(auditPath)
      ? readFileSync(auditPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
      : [];
    const writerAudit = [...auditEntries].reverse().find((entry) => entry.code === 'writer_unavailable');
    recordStep('writer_failure_audit', {
      path: relative(ROOT, auditPath),
      code: writerAudit?.code,
      executable: writerAudit?.details?.executable,
      source: writerAudit?.details?.source ?? writerAudit?.details?.executableSource,
    });
    recordAssertion('writer_failure_is_audited', writerAudit?.code === 'writer_unavailable');
    recordAssertion('writer_audit_keeps_explicit_path_source', writerAudit?.details?.source === 'env:CODEX_BIN' || writerAudit?.details?.executableSource === 'env:CODEX_BIN');

    evidence.status = 'passed';
    evidence.finishedAt = new Date().toISOString();
  } finally {
    await stopServer(child);
    evidence.serverLogs = child?.acceptanceLogs
      ? { stdoutTail: child.acceptanceLogs.stdout.slice(-1000), stderrTail: child.acceptanceLogs.stderr.slice(-1000) }
      : null;
    const auditPath = join(ISOLATED_DATA_DIR, 'server-audit.jsonl');
    if (existsSync(auditPath)) {
      cpSync(auditPath, AUDIT_EVIDENCE_PATH);
      evidence.auditEvidence = relative(ROOT, AUDIT_EVIDENCE_PATH);
    }
    rmSync(ISOLATED_DATA_DIR, { recursive: true, force: true });
    evidence.isolatedDataRemoved = true;
    if (evidence.status === 'running') {
      evidence.status = 'failed';
      evidence.finishedAt = new Date().toISOString();
    }
    writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  }
}

try {
  await run();
  console.log(JSON.stringify({ status: evidence.status, evidence: relative(ROOT, EVIDENCE_PATH), steps: evidence.steps.length }, null, 2));
} catch (error) {
  evidence.failure = { name: error?.name, message: error?.message, stack: error?.stack };
  evidence.status = 'failed';
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.error(error);
  process.exitCode = 1;
}
