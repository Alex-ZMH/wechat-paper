import fs from 'node:fs/promises';
import path from 'node:path';

import { createBrief } from '../src/contracts/brief.mjs';
import { fetchBridgeEvidenceEnvelope } from '../src/adapters/bridge-research.mjs';

const topic = process.env.RESEARCH_TOPIC || '凹凸棒石在新能源领域面临的挑战与实际应用';
const clientRunId = process.env.RESEARCH_CLIENT_RUN_ID || `studio-atp-${new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14)}`;
// No implicit wall-clock deadline: the Bridge owns completion/failure and the
// caller can cancel explicitly. Set RESEARCH_TRACE_TIMEOUT_MS only when a
// diagnostic run intentionally needs a bounded local timeout.
const timeoutMs = process.env.RESEARCH_TRACE_TIMEOUT_MS
  ? Number(process.env.RESEARCH_TRACE_TIMEOUT_MS)
  : undefined;
const baseUrl = process.env.CONTENT_DESK_BRIDGE_URL || 'http://127.0.0.1:43127';
const tracePrefix = path.join('evaluation', `research-trace-atp-${clientRunId.replace(/[^a-z0-9_-]/giu, '_')}`);
const jsonlPath = `${tracePrefix}.jsonl`;
const markdownPath = `${tracePrefix}.md`;
const packetPath = `${tracePrefix}.packet.json`;
const startedAt = Date.now();

await fs.writeFile(jsonlPath, '');
const append = async (event, details = {}) => {
  const entry = {
    timestamp: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    recordType: event,
    ...details,
  };
  if (!entry.event) entry.event = event;
  await fs.appendFile(jsonlPath, `${JSON.stringify(entry)}\n`);
  return entry;
};

// Do not duplicate a complete packet into every response-parsed trace line;
// retain shape/count metadata in the timeline and save the audited packet as
// a separate internal artifact on success.
function traceForAudit(event) {
  const copy = { ...event };
  if (copy.raw && typeof copy.raw === 'object') {
    copy.rawSummary = {
      schemaVersion: copy.raw.schemaVersion,
      code: copy.raw.code,
      stage: copy.raw.stage,
      status: copy.raw.status,
      packetId: copy.raw.packetId ?? copy.raw.packet?.packetId,
      sourceCount: Array.isArray(copy.raw.sources)
        ? copy.raw.sources.length
        : Array.isArray(copy.raw.packet?.sources) ? copy.raw.packet.sources.length : undefined,
      claimCount: Array.isArray(copy.raw.claims)
        ? copy.raw.claims.length
        : Array.isArray(copy.raw.packet?.claims) ? copy.raw.packet.claims.length : undefined,
    };
    delete copy.raw;
  }
  return copy;
}

const brief = createBrief({
  topic,
  purpose: '面向投资人评估凹凸棒石在新能源材料领域的技术成立性、制造成本、供应链、客户验证和未来3—8年商业化机会。',
  audience: '新能源材料投资人',
  channel: '微信公众号',
  tone: '清晰、克制、可信',
  targetLength: 3500,
  materials: [],
});

await append('request_received', {
  clientRunId,
  topic,
  baseUrl,
  timeoutMs,
  writerModel: 'codex-sol',
  reviewerModel: 'codex-sol',
});

let poll = true;
let lastHealth;
const poller = (async () => {
  while (poll) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      const body = await response.json();
      lastHealth = body;
      await append('bridge_health', {
        status: response.status,
        busy: body.busy,
        stage: body.stage,
        clientRunId: body.clientRunId,
        bridgeVersion: body.bridgeVersion,
        authenticated: body.authenticated,
      });
    } catch (error) {
      await append('bridge_health_error', { name: error?.name, message: error?.message });
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
})();

let outcome;
try {
  const result = await fetchBridgeEvidenceEnvelope(brief, {
    baseUrl,
    timeoutMs,
    clientRunId,
    writerModel: 'codex-sol',
    reviewerModel: 'codex-sol',
    healthFetchImpl: fetch,
    onTrace: async (event) => append('adapter_trace', traceForAudit(event)),
    onProgress: async (event) => append('adapter_progress', traceForAudit(event)),
  });
  outcome = {
    status: 'complete',
    clientRunId: result.clientRunId,
    packetId: result.packet.packetId,
    packetHash: result.packet.packetHash,
    sourceCount: result.packet.sources.length,
    claimCount: result.packet.claims.length,
    auditStatus: result.packet.audit?.status,
    researchStatus: result.packet.researchStatus,
    retrievalStatus: result.packet.retrievalStatus,
  };
  await fs.writeFile(packetPath, `${JSON.stringify(result.packet, null, 2)}\n`);
  await append('research_complete', outcome);
  console.log(JSON.stringify({ ok: true, ...outcome, jsonlPath, markdownPath, packetPath }));
} catch (error) {
  outcome = {
    status: 'failed',
    clientRunId,
    error: {
      name: error?.name,
      code: error?.code,
      message: error?.message,
      details: error?.details,
    },
    lastHealth: lastHealth
      ? { busy: lastHealth.busy, stage: lastHealth.stage, clientRunId: lastHealth.clientRunId }
      : undefined,
  };
  await append('research_error', outcome);
  console.error(JSON.stringify({ ok: false, ...outcome, jsonlPath, markdownPath }));
} finally {
  poll = false;
  await poller;
  await append('trace_end', {
    outcome: outcome?.status,
    totalElapsedMs: Date.now() - startedAt,
  });
}

const lines = (await fs.readFile(jsonlPath, 'utf8'))
  .trim()
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const first = lines[0];
const last = lines.at(-1);
const stageChanges = [];
for (const item of lines) {
  if (item.stage && stageChanges.at(-1)?.stage !== item.stage) {
    stageChanges.push({ stage: item.stage, timestamp: item.timestamp, elapsedMs: item.elapsedMs });
  }
}
const markdown = [
  `# 凹凸棒石研究运行内部追踪（${clientRunId}）`,
  '',
  `- 主题：${topic}`,
  `- 开始：${first?.timestamp ?? ''}`,
  `- 结束：${last?.timestamp ?? ''}`,
  `- 总耗时：${last?.totalElapsedMs ?? last?.elapsedMs ?? ''} ms`,
  `- 结果：${outcome?.status ?? ''}`,
  '',
  '## 阶段时间线',
  '',
  ...(stageChanges.length ? stageChanges.map((item) => `- ${item.stage}（${item.elapsedMs} ms，${item.timestamp}）`) : ['- 未收到阶段回报']),
  '',
  '## 错误/取消记录',
  '',
  ...lines.filter((item) => ['research_error', 'cancel_response', 'cancel_error', 'cancel_release_health', 'error'].includes(item.event))
    .map((item) => `- ${item.timestamp} ${item.event}: ${JSON.stringify(item.error ?? item.cancel ?? item)}`),
  '',
  '该文件为开发端审计记录；不得作为读者文章内容。',
  '',
].join('\n');
await fs.writeFile(markdownPath, markdown);
