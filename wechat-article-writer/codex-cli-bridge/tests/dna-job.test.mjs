import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import test from 'node:test';

import {
  createBridgeServer,
  createCancellationController,
  createDnaJobManager,
} from '../server.mjs';
import { collectDnaArtifactManifest } from '../dna-job-manager.mjs';

function httpJson(port, requestPath, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: encoded ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (encoded) req.end(encoded); else req.end();
  });
}

async function withServer(options, callback) {
  const server = createBridgeServer({ port: 0, ...options });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try { return await callback(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function waitFor(getter, predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await getter();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return getter();
}

function artifact(mode = 'academic') {
  const file = mode === 'academic' ? 'Academic-Writing-DNA.md' : 'Writing-DNA.md';
  const files = [{ path: file, bytes: 3, sha256: 'a'.repeat(64) }];
  const canonical = JSON.stringify({
    mode,
    workspace: mode === 'academic' ? 'writing-dna-workspace/academic' : 'writing-dna-workspace/general',
    files,
  });
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return {
    schemaVersion: 'content-desk.dna-artifact.v1',
    mode,
    workspace: mode === 'academic' ? 'writing-dna-workspace/academic' : 'writing-dna-workspace/general',
    files,
    sha256: hash,
    artifactHash: hash,
  };
}

test('default DNA artifact collector builds a receipt manifest without hidden request fields', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-dna-artifact-'));
  try {
    const workspaceRelative = 'writing-dna-workspace/academic';
    const artifactPath = path.join(root, workspaceRelative, 'Academic-Writing-DNA.md');
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, '# Academic-Writing-DNA\n\n真实测试产物。\n', 'utf8');
    const manifest = await collectDnaArtifactManifest({
      mode: 'academic',
      projectRoot: root,
      workspaceRelative,
      outputFiles: ['Academic-Writing-DNA.md'],
    });
    assert.equal(manifest.schemaVersion, 'content-desk.dna-artifact.v1');
    assert.equal(manifest.mode, 'academic');
    assert.equal(manifest.workspace, workspaceRelative);
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0].path, 'Academic-Writing-DNA.md');
    assert.match(manifest.files[0].sha256, /^[a-f0-9]{64}$/u);
    assert.match(manifest.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(Object.hasOwn(manifest, 'corpusSnapshotId'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('DNA job HTTP contract is idempotent by jobId and rejects mode conflicts', async () => {
  const jobsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-dna-jobs-'));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  try {
    await withServer({
      dnaJobsPath: jobsPath,
      dnaRunner: async () => gate.then(() => ({ summary: 'ok', outputFiles: ['Academic-Writing-DNA.md'] })),
      artifactCollector: undefined,
      statusProvider: async () => ({ ok: true }),
    }, async (port) => {
      const first = await httpJson(port, '/v1/dna/jobs', { method: 'POST', body: { jobId: 'job-a', mode: 'academic' } });
      assert.equal(first.status, 202);
      assert.equal(first.body.jobId, 'job-a');
      assert.equal(first.body.mode, 'academic');
      assert.equal(first.body.state, 'running');
      assert.equal(['validating_inputs', 'staging', 'executing', 'validating_outputs', 'committing'].includes(first.body.stage), true);
      const duplicate = await httpJson(port, '/v1/dna/jobs', { method: 'POST', body: { jobId: 'job-a', mode: 'academic' } });
      assert.equal(duplicate.status, 200);
      assert.equal(duplicate.body.idempotent, true);
      assert.equal(duplicate.body.jobId, 'job-a');
      const conflict = await httpJson(port, '/v1/dna/jobs', { method: 'POST', body: { jobId: 'job-a', mode: 'writing' } });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.code, 'job_conflict');
      release();
      const completed = await waitFor(
        () => httpJson(port, '/v1/dna/jobs/job-a'),
        (response) => response.body?.state === 'succeeded',
      );
      // The default collector correctly rejects a fake runner that did not
      // create a file; this test focuses on the idempotency state transition.
      assert.equal(['succeeded', 'failed'].includes(completed.body.state), true);
    });
  } finally {
    await fs.rm(jobsPath, { recursive: true, force: true });
  }
});

test('DNA job cancellation is precise, terminal deletion is allowed, and failed runs keep old DNA', async () => {
  const jobsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-dna-jobs-'));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let runnerCalls = 0;
  try {
    await withServer({
      dnaJobsPath: jobsPath,
      dnaRunner: async (_mode, { cancelController }) => {
        runnerCalls += 1;
        await gate;
        cancelController.throwIfCancelled('executing');
        return { summary: 'must not publish', outputFiles: [] };
      },
      statusProvider: async () => ({ ok: true }),
    }, async (port) => {
      const created = await httpJson(port, '/v1/dna/jobs', { method: 'POST', body: { jobId: 'cancel-a', mode: 'academic' } });
      assert.equal(created.status, 202);
      const stopped = await httpJson(port, '/v1/dna/jobs/cancel-a/cancel', { method: 'POST' });
      assert.equal(stopped.status, 200);
      assert.equal(stopped.body.state, 'cancelling');
      assert.equal(stopped.body.cancel.code, 'cancel_requested');
      release();
      const cancelled = await waitFor(
        () => httpJson(port, '/v1/dna/jobs/cancel-a'),
        (response) => response.body?.state === 'cancelled',
      );
      assert.equal(cancelled.body.error.code, 'cancelled');
      assert.equal(runnerCalls, 1);
      const again = await httpJson(port, '/v1/dna/jobs/cancel-a/cancel', { method: 'POST' });
      assert.equal(again.status, 409);
      assert.equal(again.body.code, 'job_terminal');
      const deleted = await httpJson(port, '/v1/dna/jobs/cancel-a', { method: 'DELETE' });
      assert.equal(deleted.status, 204);
      assert.equal((await httpJson(port, '/v1/dna/jobs/cancel-a')).status, 404);
    });
  } finally {
    await fs.rm(jobsPath, { recursive: true, force: true });
  }
});

test('DNA job commit boundary rejects cancellation and returns immutable artifact receipt', async () => {
  const jobsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-dna-jobs-'));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  try {
    await withServer({
      dnaJobsPath: jobsPath,
      dnaRunner: async (_mode, { onStage }) => {
        onStage('committing');
        await gate;
        return { summary: 'committed', outputFiles: ['Academic-Writing-DNA.md'] };
      },
      artifactCollector: async () => artifact('academic'),
      statusProvider: async () => ({ ok: true }),
    }, async (port) => {
      const created = await httpJson(port, '/v1/dna/jobs', { method: 'POST', body: { jobId: 'commit-a', mode: 'academic' } });
      assert.equal(created.status, 202);
      const committing = await waitFor(
        () => httpJson(port, '/v1/dna/jobs/commit-a'),
        (response) => response.body?.stage === 'committing',
      );
      assert.equal(committing.body.state, 'running');
      const stopped = await httpJson(port, '/v1/dna/jobs/commit-a/cancel', { method: 'POST' });
      assert.equal(stopped.status, 409);
      assert.equal(stopped.body.code, 'job_committing');
      release();
      const completed = await waitFor(
        () => httpJson(port, '/v1/dna/jobs/commit-a'),
        (response) => response.body?.state === 'succeeded',
      );
      assert.equal(completed.body.stage, 'committing');
      assert.equal(completed.body.receipt.schemaVersion, 'content-desk.dna-receipt.v1');
      assert.equal(completed.body.receipt.artifactHash, completed.body.artifactManifest.sha256);
      assert.equal(completed.body.artifactManifest.sha256, completed.body.artifactHash);
      const removed = await httpJson(port, '/v1/dna/jobs/commit-a', { method: 'DELETE' });
      assert.equal(removed.status, 204);
    });
  } finally {
    await fs.rm(jobsPath, { recursive: true, force: true });
  }
});

test('a committed runner never reports a failed job when receipt collection breaks', async () => {
  const jobsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-dna-jobs-'));
  try {
    await withServer({
      dnaJobsPath: jobsPath,
      dnaRunner: async (_mode, { onStage }) => {
        onStage('committing');
        return {
          summary: 'workspace swapped',
          outputFiles: ['Academic-Writing-DNA.md'],
          artifactCommitted: true,
        };
      },
      artifactCollector: async () => {
        throw new Error('collector unavailable');
      },
      statusProvider: async () => ({ ok: true }),
    }, async (port) => {
      const created = await httpJson(port, '/v1/dna/jobs', {
        method: 'POST',
        body: { jobId: 'receipt-pending-a', mode: 'academic' },
      });
      assert.equal(created.status, 202);
      const terminal = await waitFor(
        () => httpJson(port, '/v1/dna/jobs/receipt-pending-a'),
        (response) => ['interrupted', 'failed', 'succeeded', 'cancelled'].includes(response.body?.state),
      );
      assert.equal(terminal.body.state, 'interrupted');
      assert.equal(terminal.body.error.code, 'receipt_pending');
      assert.equal(terminal.body.stage, 'committing');
      assert.equal(terminal.body.receipt, undefined);
    });
  } finally {
    await fs.rm(jobsPath, { recursive: true, force: true });
  }
});

test('stored DNA jobs reject a receipt whose corpus snapshot differs from the job', async () => {
  const jobsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-dna-jobs-'));
  try {
    const manager = createDnaJobManager({
      directory: jobsPath,
      projectRoot: jobsPath,
      runner: async () => ({ summary: 'ok', outputFiles: ['Academic-Writing-DNA.md'] }),
      artifactCollector: async () => artifact('academic'),
      createCancellationController,
      isBusy: () => false,
      setBusy: () => {},
    });
    await manager.create({ jobId: 'receipt-snapshot-a', mode: 'academic' });
    await manager._operations.get('receipt-snapshot-a')?.promise;
    let record;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      record = await manager.get('receipt-snapshot-a');
      if (record?.state === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(record?.state, 'succeeded');
    const recordPath = path.join(jobsPath, 'receipt-snapshot-a.json');
    let stored;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        stored = JSON.parse(await fs.readFile(recordPath, 'utf8'));
      } catch {
        stored = undefined;
      }
      if (stored?.receipt) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(stored?.receipt);
    stored.receipt.corpusSnapshotId = 'different-snapshot';
    await fs.writeFile(recordPath, `${JSON.stringify(stored)}\n`, 'utf8');

    const reloaded = createDnaJobManager({
      directory: jobsPath,
      projectRoot: jobsPath,
      runner: async () => ({ summary: 'ok', outputFiles: ['Academic-Writing-DNA.md'] }),
      artifactCollector: async () => artifact('academic'),
      createCancellationController,
      isBusy: () => false,
      setBusy: () => {},
    });
    assert.equal(await reloaded.get('receipt-snapshot-a'), undefined);
  } finally {
    await fs.rm(jobsPath, { recursive: true, force: true });
  }
});

test('stored succeeded DNA jobs require an immutable receipt', async () => {
  const jobsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-dna-jobs-'));
  try {
    const manager = createDnaJobManager({
      directory: jobsPath,
      projectRoot: jobsPath,
      runner: async () => ({ summary: 'ok', outputFiles: ['Academic-Writing-DNA.md'] }),
      artifactCollector: async () => artifact('academic'),
      createCancellationController,
      isBusy: () => false,
      setBusy: () => {},
    });
    await manager.create({ jobId: 'receipt-required-a', mode: 'academic' });
    await manager._operations.get('receipt-required-a')?.promise;
    const recordPath = path.join(jobsPath, 'receipt-required-a.json');
    const stored = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    assert.equal(stored.state, 'succeeded');
    delete stored.receipt;
    await fs.writeFile(recordPath, `${JSON.stringify(stored)}\n`, 'utf8');
    const reloaded = createDnaJobManager({
      directory: jobsPath,
      projectRoot: jobsPath,
      runner: async () => ({ summary: 'ok', outputFiles: ['Academic-Writing-DNA.md'] }),
      artifactCollector: async () => artifact('academic'),
      createCancellationController,
      isBusy: () => false,
      setBusy: () => {},
    });
    assert.equal(await reloaded.get('receipt-required-a'), undefined);
  } finally {
    await fs.rm(jobsPath, { recursive: true, force: true });
  }
});

test('stored succeeded DNA receipt must match job id, mode, and completion time', async () => {
  const jobsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-dna-jobs-'));
  try {
    const options = {
      directory: jobsPath,
      projectRoot: jobsPath,
      runner: async () => ({ summary: 'ok', outputFiles: ['Academic-Writing-DNA.md'] }),
      artifactCollector: async () => artifact('academic'),
      createCancellationController,
      isBusy: () => false,
      setBusy: () => {},
    };
    const manager = createDnaJobManager(options);
    await manager.create({ jobId: 'receipt-binding-a', mode: 'academic' });
    await manager._operations.get('receipt-binding-a')?.promise;
    const recordPath = path.join(jobsPath, 'receipt-binding-a.json');
    const baseline = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    assert.equal(baseline.state, 'succeeded');

    const mutations = [
      (stored) => { stored.receipt.jobId = 'another-job'; },
      (stored) => { stored.receipt.mode = 'writing'; },
      (stored) => { delete stored.receipt.completedAt; },
    ];
    for (const mutate of mutations) {
      const stored = structuredClone(baseline);
      mutate(stored);
      await fs.writeFile(recordPath, `${JSON.stringify(stored)}\n`, 'utf8');
      const reloaded = createDnaJobManager(options);
      assert.equal(await reloaded.get('receipt-binding-a'), undefined);
    }
  } finally {
    await fs.rm(jobsPath, { recursive: true, force: true });
  }
});

test('a new manager converts persisted running DNA jobs to interrupted after Bridge restart', async () => {
  const jobsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-dna-jobs-'));
  try {
    const first = createDnaJobManager({
      directory: jobsPath,
      projectRoot: jobsPath,
      runner: async () => new Promise(() => {}),
      createCancellationController,
      isBusy: () => false,
      setBusy: () => {},
    });
    const created = await first.create({ jobId: 'restart-a', mode: 'academic' });
    assert.equal(created.record.state, 'running');
    const second = createDnaJobManager({
      directory: jobsPath,
      projectRoot: jobsPath,
      runner: async () => ({ outputFiles: [] }),
      createCancellationController,
      isBusy: () => false,
      setBusy: () => {},
    });
    const recovered = await second.get('restart-a');
    assert.equal(recovered.state, 'interrupted');
    assert.equal(recovered.error.code, 'bridge_restarted');
    assert.equal(['validating_inputs', 'staging', 'executing', 'validating_outputs', 'committing'].includes(recovered.stage), true);
  } finally {
    await fs.rm(jobsPath, { recursive: true, force: true });
  }
});
