import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBrief } from '../src/contracts/brief.mjs';
import {
  buildCodexResearchPrompt,
  fetchCodexResearchEvidence,
  normalizeCodexResearchOutput,
  runCodexResearchJson,
} from '../src/adapters/codex-research.mjs';

const brief = createBrief({ topic: '新选题', purpose: '核验公开事实', audience: '读者' });
const output = { sources: [{ sourceId: 's-1', title: '官方资料', url: 'https://example.test/official', excerpt: '可定位的原文摘录。', locator: '第 1 节' }], claims: [{ claimId: 'c-1', text: '这条事实可由原文摘录支持。', evidenceIds: ['s-1'], confidence: 0.9 }] };
function child(expectedPrompt = /只保留你实际访问到的公开 URL/u) {
  const value = new EventEmitter();
  value.stdin = { end: (prompt) => { if (expectedPrompt) assert.match(prompt, expectedPrompt); } };
  value.stderr = new EventEmitter();
  value.kill = () => {};
  return value;
}

test('direct research uses live search and accepts only source-bound structured output', async () => {
  const value = child(); const calls = []; const trace = [];
  const result = await fetchCodexResearchEvidence(brief, { executable: 'codex.exe', spawnImpl: (_command, args) => { calls.push(args); queueMicrotask(() => value.emit('close', 0)); return value; }, mkdtempImpl: async () => 'C:\\temp\\codex-research', readFileImpl: async () => JSON.stringify(output), rmImpl: async () => {}, onTrace: (event) => trace.push(event) });
  assert.equal(calls[0].includes('--search'), true);
  assert.equal(result.packet.sources[0].sourceOrigin, 'realtime_research');
  assert.deepEqual(result.packet.claims[0].evidenceIds, ['s-1']);
  assert.ok(trace.some((event) => event.event === 'candidate_ready'));
  assert.equal(trace.some((event) => event.event === 'direct_research_complete'), false);
});

test('direct research rejects claims that are not bound to a returned source', async () => {
  const value = child(null);
  await assert.rejects(() => fetchCodexResearchEvidence(brief, { executable: 'codex.exe', spawnImpl: () => { queueMicrotask(() => value.emit('close', 0)); return value; }, mkdtempImpl: async () => 'C:\\temp\\codex-research', readFileImpl: async () => JSON.stringify({ ...output, claims: [{ ...output.claims[0], evidenceIds: ['unknown'] }] }), rmImpl: async () => {} }), (error) => error.code === 'research_insufficient_evidence');
});

test('direct research prompt distinguishes original excerpts from summaries', () => {
  const prompt = buildCodexResearchPrompt(brief);
  assert.match(prompt, /新选题/u);
  assert.match(prompt, /整理要点/u);
  assert.match(prompt, /不要用引号伪装原文/u);
});

test('JSONL runner records only real process, tool, and web-search activity', async () => {
  const value = child(null);
  value.stdout = new EventEmitter();
  const trace = [];
  const progress = [];
  const json = JSON.stringify(output);
  const resultPromise = runCodexResearchJson('研究提示', {
    executable: 'codex.exe',
    model: 'test-model',
    spawnImpl: (_command, args) => {
      assert.ok(args.includes('--json'));
      assert.ok(args.includes('--search'));
      queueMicrotask(() => {
        value.stdout.emit('data', [
          JSON.stringify({ type: 'item.started', item: { type: 'reasoning', text: '不要记录这段思维链' } }),
          JSON.stringify({ type: 'item.completed', item: { type: 'web_search_call', id: 'search-1', action: { type: 'search', query: '真实搜索词' } } }),
          JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', id: 'tool-1', command: 'echo hidden' } }),
          JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10 } }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: json } }),
        ].join('\n'));
        value.emit('close', 0);
      });
      return value;
    },
    mkdtempImpl: async () => 'C:\\temp\\codex-research',
    readFileImpl: async () => { throw Object.assign(new Error('missing output file'), { code: 'ENOENT' }); },
    rmImpl: async () => {},
    onTrace: (event) => trace.push(event),
    onProgress: (event) => progress.push(event),
  });
  assert.deepEqual(await resultPromise, output);
  assert.ok(trace.some((event) => event.event === 'direct_research_process_started' && event.stage === 'research'));
  assert.ok(trace.some((event) => event.event === 'direct_research_process_finished' && event.lifecycle === 'closed'));
  const search = trace.find((event) => event.event === 'direct_research_search_item');
  assert.equal(search.item.type, 'web_search_call');
  assert.equal(search.item.action.query, '真实搜索词');
  assert.ok(trace.some((event) => event.event === 'direct_research_tool_item'));
  assert.equal(trace.some((event) => JSON.stringify(event).includes('不要记录这段思维链')), false);
  assert.equal(trace.some((event) => event.event === 'turn.completed'), false);
  assert.equal(progress.at(-1).stage, 'research');
  assert.equal(progress.some((event) => event.stage === 'research_retrieval'), true);
});

test('JSONL runner can disable search without changing the runner/provider', async () => {
  const value = child(null);
  value.stdout = new EventEmitter();
  const calls = [];
  const result = await runCodexResearchJson('审查提示', {
    executable: 'codex.exe',
    search: false,
    schemaPath: 'custom-schema.json',
    spawnImpl: (_command, args) => {
      calls.push(args);
      queueMicrotask(() => value.emit('close', 0));
      return value;
    },
    mkdtempImpl: async () => 'C:\\temp\\codex-research',
    readFileImpl: async () => JSON.stringify(output),
    rmImpl: async () => {},
  });
  assert.deepEqual(result, output);
  assert.equal(calls[0].includes('--json'), true);
  assert.equal(calls[0].includes('--search'), false);
  assert.equal(calls[0].includes('web_search="disabled"'), true);
  assert.equal(calls[0].includes('custom-schema.json'), true);
});

test('JSONL runner classifies a process start exception and captures safe failure evidence', async () => {
  const error = Object.assign(new Error('spawn failed with token=secret-value'), { code: 'ENOENT' });
  const trace = [];
  await assert.rejects(
    () => runCodexResearchJson('研究提示', {
      executable: 'codex.exe',
      spawnImpl: () => { throw error; },
      mkdtempImpl: async () => 'C:\\temp\\codex-research',
      rmImpl: async () => {},
      onTrace: (event) => trace.push(event),
    }),
    (received) => received.code === 'research_unavailable' && received.details.cause === 'ENOENT',
  );
  assert.equal(trace.some((event) => event.event === 'direct_research_process_failed'), true);
  assert.equal(trace.some((event) => JSON.stringify(event).includes('secret-value')), false);
});

test('stdin I/O failure terminates the child and rejects only after close', async () => {
  const value = child(null);
  value.stdout = new EventEmitter();
  value.stdin = new EventEmitter();
  const signals = [];
  value.kill = (signal) => { signals.push(signal); };
  let settled = false;
  const promise = runCodexResearchJson('研究提示', {
    executable: 'codex.exe',
    killGraceMs: 100,
    spawnImpl: () => {
      queueMicrotask(() => value.stdin.emit('error', Object.assign(new Error('pipe broken'), { code: 'EPIPE' })));
      return value;
    },
    mkdtempImpl: async () => 'C:\\temp\\codex-research',
    rmImpl: async () => {},
  }).catch((error) => { settled = true; throw error; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(settled, false);
  value.emit('close', 0);
  await assert.rejects(promise, (error) => error.code === 'research_unavailable' && error.details.cause === 'EPIPE');
});

test('stdout I/O failure terminates the child and rejects only after close', async () => {
  const value = child(null);
  value.stdout = new EventEmitter();
  value.stdin = new EventEmitter();
  value.stdin.end = () => {};
  const signals = [];
  value.kill = (signal) => { signals.push(signal); };
  let settled = false;
  const promise = runCodexResearchJson('研究提示', {
    executable: 'codex.exe',
    killGraceMs: 100,
    spawnImpl: () => {
      queueMicrotask(() => value.stdout.emit('error', Object.assign(new Error('output broken'), { code: 'EIO' })));
      return value;
    },
    mkdtempImpl: async () => 'C:\\temp\\codex-research',
    rmImpl: async () => {},
  }).catch((error) => { settled = true; throw error; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(settled, false);
  value.emit('close', 0);
  await assert.rejects(promise, (error) => error.code === 'research_unavailable' && error.details.cause === 'EIO');
});

test('JSONL runner reports malformed final output without exposing agent text', async () => {
  const value = child(null);
  value.stdout = new EventEmitter();
  const trace = [];
  await assert.rejects(
    () => runCodexResearchJson('研究提示', {
      executable: 'codex.exe',
      spawnImpl: () => {
        queueMicrotask(() => {
          value.stdout.emit('data', `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '普通说明，不是 JSON' } })}\n`);
          value.emit('close', 0);
        });
        return value;
      },
      mkdtempImpl: async () => 'C:\\temp\\codex-research',
      readFileImpl: async () => { throw Object.assign(new Error('Unexpected token <'), { code: 'EBADJSON' }); },
      rmImpl: async () => {},
      onTrace: (event) => trace.push(event),
    }),
    (error) => error.code === 'research_invalid_json',
  );
  assert.ok(trace.some((event) => event.event === 'direct_research_json_parse_failed'));
  assert.equal(trace.some((event) => JSON.stringify(event).includes('普通说明')), false);
});

test('cancellation waits for child close and escalates from SIGTERM only after a short grace period', async () => {
  const controller = new AbortController();
  const value = child(null);
  value.stdout = new EventEmitter();
  const signals = [];
  value.kill = (signal) => { signals.push(signal); };
  let settled = false;
  const promise = runCodexResearchJson('研究提示', {
    executable: 'codex.exe',
    signal: controller.signal,
    killGraceMs: 5,
    spawnImpl: () => value,
    mkdtempImpl: async () => 'C:\\temp\\codex-research',
    readFileImpl: async () => JSON.stringify(output),
    rmImpl: async () => {},
  }).catch((error) => { settled = true; throw error; });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(settled, false);
  value.emit('close', null, 'SIGKILL');
  await assert.rejects(promise, (error) => error.code === 'research_cancelled');
});

test('empty structured research result is reported as insufficient evidence', async () => {
  await assert.rejects(
    () => fetchCodexResearchEvidence(brief, {
      executable: 'codex.exe',
      spawnImpl: () => {
        const value = child();
        queueMicrotask(() => value.emit('close', 0));
        return value;
      },
      mkdtempImpl: async () => 'C:\\temp\\codex-research',
      readFileImpl: async () => JSON.stringify({ sources: [], claims: [] }),
      rmImpl: async () => {},
    }),
    (error) => error.code === 'research_insufficient_evidence',
  );
});

test('normalization preserves punctuation-bearing IDs and restricts claim kind', () => {
  const normalized = normalizeCodexResearchOutput(brief, {
    sources: [
      { sourceId: 'source/a', title: 'A', url: 'https://example.test/a', excerpt: '摘录 A', locator: '第 1 节' },
      { sourceId: 'source-a', title: 'B', url: 'https://example.test/b', excerpt: '摘录 B', locator: '第 2 节' },
    ],
    claims: [
      { claimId: 'claim/a', text: '事实 A', evidenceIds: ['source/a'], kind: 'fact' },
      { claimId: 'claim-a', text: '推断 B', evidenceIds: ['source-a'], kind: 'inference' },
    ],
  });
  assert.deepEqual(normalized.sources.map((source) => source.sourceId), ['source/a', 'source-a']);
  assert.deepEqual(normalized.claims.map((claim) => claim.kind), ['fact', 'inference']);
  assert.throws(() => normalizeCodexResearchOutput(brief, {
    sources: [{ sourceId: 's-1', title: 'A', url: 'https://example.test/a', excerpt: '摘录', locator: '第 1 节' }],
    claims: [{ claimId: 'c-1', text: '判断', evidenceIds: ['s-1'], kind: 'opinion' }],
  }), (error) => error.code === 'research_invalid_json');
});
