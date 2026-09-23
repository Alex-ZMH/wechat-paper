import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ResearchJobStore } from '../src/lib/research-jobs.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function temporaryStore(run) {
  const dataDir = await mkdtemp(join(tmpdir(), 'wechat-studio-research-jobs-'));
  try { return await run(dataDir); } finally { await rm(dataDir, { recursive: true, force: true }); }
}

async function waitForStatus(store, jobId, expected, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = store.get(jobId);
    if (view.status === expected) return view;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return store.get(jobId);
}

test('same workspace and brief deduplicate while a research job is active', async () => {
  await temporaryStore(async (dataDir) => {
    const hold = deferred();
    const store = new ResearchJobStore({ dataDir, run: () => hold.promise });
    const input = { workspaceId: 'workspace-a', brief: { topic: '同一选题', audience: '投资人' } };
    const first = store.start(input);
    const second = store.start({ ...input, brief: { ...input.brief } });
    assert.equal(second.jobId, first.jobId);
    assert.ok(['queued', 'running'].includes(second.status));
    await store.cancel(first.jobId);
    hold.resolve({ ignored: true });
    await store.jobs.get(first.jobId).promise;
  });
});

test('a different brief is rejected while another workspace job is active', async () => {
  await temporaryStore(async (dataDir) => {
    const hold = deferred();
    const store = new ResearchJobStore({ dataDir, run: () => hold.promise });
    const first = store.start({ workspaceId: 'workspace-a', brief: { topic: '选题A' } });
    assert.throws(
      () => store.start({ workspaceId: 'workspace-b', brief: { topic: '选题B' } }),
      (error) => error.code === 'busy',
    );
    await store.cancel(first.jobId);
    hold.resolve({ ignored: true });
    await store.jobs.get(first.jobId).promise;
  });
});

test('a late result after cancellation is ignored and cannot become a completed job', async () => {
  await temporaryStore(async (dataDir) => {
    const hold = deferred();
    const store = new ResearchJobStore({ dataDir, run: () => hold.promise });
    const started = store.start({ workspaceId: 'workspace-a', brief: { topic: '迟到结果' } });
    await store.cancel(started.jobId);
    hold.resolve({ researchSession: { sessionId: 'should-not-save' } });
    await store.jobs.get(started.jobId).promise;
    const view = store.get(started.jobId);
    assert.equal(view.status, 'cancelled');
    assert.equal(view.record, null);
    const trace = await import('node:fs/promises').then(({ readFile }) => readFile(join(dataDir, 'research-jobs', `${started.jobId}.jsonl`), 'utf8'));
    assert.match(trace, /late_result_ignored/u);
  });
});

test('re-instantiating the store marks unfinished jobs as interrupted', async () => {
  await temporaryStore(async (dataDir) => {
    const hold = deferred();
    const first = new ResearchJobStore({ dataDir, run: () => hold.promise });
    const started = first.start({ workspaceId: 'workspace-a', brief: { topic: '重启恢复' } });
    // The second instance reads the durable jobs.json while the first run is
    // still active, so it must fail closed instead of claiming completion.
    const restarted = new ResearchJobStore({ dataDir, run: async () => ({}) });
    const view = restarted.get(started.jobId);
    assert.equal(view.status, 'failed');
    assert.equal(view.stage, 'failed');
    assert.equal(view.error.code, 'research_interrupted');
    await first.cancel(started.jobId);
    hold.resolve({ ignored: true });
    await first.jobs.get(started.jobId).promise;
  });
});

test('failed retries and completed reruns always create a fresh research job', async () => {
  await temporaryStore(async (dataDir) => {
    const calls = [];
    const store = new ResearchJobStore({
      dataDir,
      run: async (input) => {
        calls.push(input);
        if (calls.length === 1) {
          const error = new Error('audit did not freeze');
          error.code = 'research_audit_failed';
          throw error;
        }
        return { attempt: calls.length };
      },
    });
    const input = { workspaceId: 'workspace-a', brief: { topic: '博士工作去向调查', audience: '博士毕业人员' } };
    const first = store.start(input);
    await waitForStatus(store, first.jobId, 'failed');
    const retry = store.start({ ...input, brief: { ...input.brief } });
    const result = await waitForStatus(store, retry.jobId, 'completed');
    assert.notEqual(retry.jobId, first.jobId);
    assert.equal(result.record.attempt, 2);
    assert.equal(calls[1].recoveryFromJobId, undefined);
    assert.equal(calls[1].recoveryCandidate, undefined);

    const rerun = store.start({ ...input, brief: { ...input.brief } });
    const rerunResult = await waitForStatus(store, rerun.jobId, 'completed');
    assert.notEqual(rerun.jobId, retry.jobId);
    assert.equal(rerunResult.record.attempt, 3);
    assert.equal(calls.length, 3);
  });
});
