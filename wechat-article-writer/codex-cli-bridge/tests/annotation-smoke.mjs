import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const host = '127.0.0.1';
const port = Number.parseInt(process.env.CODEX_BRIDGE_PORT ?? '43127', 10) || 43127;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qaDirectory = path.join(projectRoot, 'outputs', 'qa');

function fingerprint(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `d${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function jsonRequest(path, body) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const isHealthCheck = path === '/health';
    const req = request({
      host,
      port,
      path,
      method: body === undefined ? 'GET' : 'POST',
      headers: encoded ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(encoded),
        // Exercise the same-origin local browser route/CORS contract used by the workbench.
        Origin: 'http://127.0.0.1:43127',
      } : undefined,
      timeout: isHealthCheck ? 5_000 : 0,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = { error: 'invalid response' }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error(isHealthCheck ? 'health check timeout' : 'unexpected content socket timeout')));
    req.on('error', reject);
    if (encoded) req.end(encoded); else req.end();
  });
}

function safeFailureDiagnostics(body) {
  const value = body?.diagnostics;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return {
    stage: typeof value.stage === 'string' ? value.stage : undefined,
    modelPassed: typeof value.modelPassed === 'boolean' ? value.modelPassed : undefined,
    modelIssueCount: Number.isInteger(value.modelIssueCount) ? value.modelIssueCount : undefined,
    failedChecks: Array.isArray(value.failedChecks) ? value.failedChecks.filter((item) => typeof item === 'string').slice(0, 20) : [],
    unresolvedHighRisk: value.unresolvedHighRisk === true,
    serverFlagCategories: Array.isArray(value.serverFlagCategories)
      ? value.serverFlagCategories.filter((item) => typeof item === 'string').slice(0, 20)
      : [],
  };
}

const previous = [
  '多站点过程异常需要先统一测量口径，再判断是否存在共因。',
  '先核对事件主键、批次、版本和时间窗口，再安排人工复核。',
].join('\n');
const edited = [
  '我希望先把“测量口径”说清楚：不同站点的分母和采集方式要能对齐。',
  '先核对事件主键、批次、版本和时间窗口，再安排人工复核。',
].join('\n');
const brief = {
  topic: '多站点过程异常如何判断共因并组织处置',
  audience: '制造业过程与质量负责人',
  format: '专业方案',
  tone: '专业解释',
  targetLength: '900',
  materials: '只讨论数据对象、分析边界和人工动作，不提供效果数字或客户案例。',
};

const genericPrevious = [
  '面对陌生主题，先写满答案往往会把假设和事实混在一起。',
  '更稳妥的做法是先列出可以验证的问题，再决定需要补什么材料。',
].join('\n');
const genericEdited = [
  '我的做法是先写出三个可以被证伪的问题，并给每个问题标明需要的材料。',
  '材料不够时保留空白，不拿顺口的判断替代证据。',
].join('\n');
const genericBrief = {
  topic: `陌生主题写作如何先形成可验证的问题（随机验收 ${new Date().toISOString()}）`,
  audience: '需要持续写专业文章的个人知识创作者',
  format: '非虚构方法文章',
  tone: '克制真诚',
  targetLength: '700',
  materials: '只使用作者提供的方法和边界，不虚构经历、数字、来源或效果。',
};

const cases = [
  {
    name: 'manual-only',
    annotations: [],
  },
  {
    name: 'manual-plus-annotation',
    annotations: [{ id: 'annotation-1', kind: '表达调整', note: '把这句改得更具体，但不要新增事实或数字。', quote: '测量口径' }],
  },
  {
    name: 'conflicting-fact-annotation',
    annotations: [{ id: 'annotation-2', kind: '事实冲突', note: '有人要求把这句改成40%，但没有新证据，请阻止改写并说明待核对。', quote: '测量口径' }],
  },
  {
    name: 'generic-manual-plus-annotation',
    annotations: [{ id: 'annotation-generic-1', kind: '结构建议', note: '保留我手改的三个问题和材料边界，再补一个简短例子说明怎样执行。', quote: '三个可以被证伪的问题' }],
    task: {
      kind: 'rewrite',
      domain: '通用非虚构',
      genre: '方法文章',
      channel: '微信公众号',
      purpose: '按作者手改和批注形成可审阅的新版本',
    },
    brief: genericBrief,
    previous: genericPrevious,
    edited: genericEdited,
    protectedFacts: ['三个可以被证伪的问题', '材料不够时保留空白'],
    preserveToken: '三个可以被证伪的问题',
    skillChain: [],
  },
];

const selectedCase = process.env.CODEX_ANNOTATION_SMOKE_CASE;
const casesToRun = selectedCase ? cases.filter((item) => item.name === selectedCase) : cases;
if (selectedCase && casesToRun.length === 0) throw new Error(`unknown annotation smoke case: ${selectedCase}`);

const results = [];
for (const item of casesToRun) {
  const started = Date.now();
  const caseBrief = item.brief ?? brief;
  const casePrevious = item.previous ?? previous;
  const caseEdited = item.edited ?? edited;
  const body = {
    schemaVersion: 'content-desk.request.v2',
    task: item.task ?? {
      kind: 'rewrite',
      domain: '工业研发',
      genre: '专业方案',
      channel: '微信公众号',
      purpose: '按作者手改和批注形成可审阅的新版本',
    },
    mode: 'annotation_regeneration',
    brief: caseBrief,
    previousGeneratedDraft: casePrevious,
    currentDraft: caseEdited,
    annotations: item.annotations,
    protectedFacts: item.protectedFacts ?? ['测量口径'],
    versionId: `v1:${fingerprint(caseEdited)}`,
    voiceProfile: { tone: '专业解释', traits: ['具体', '克制', '不编造'] },
    skillChain: item.skillChain ?? ['industrial-ai-wechat-research-writing'],
    clientRunId: randomUUID(),
    targetLength: Number(caseBrief.targetLength),
  };
  let response;
  try {
    response = await jsonRequest('/v1/content', body);
  } catch (error) {
    response = { status: 0, body: { error: error instanceof Error ? error.name : 'request_failed' } };
  }
  const elapsedMs = Date.now() - started;
  const health = await jsonRequest('/health');
  const result = {
    name: item.name,
    elapsedMs,
    httpStatus: response.status,
    code: response.body.code ?? null,
    receipts: Array.isArray(response.body.receipts)
      ? response.body.receipts.map((receipt) => ({ id: receipt.id, status: receipt.status }))
      : [],
    preservedUserEdit: typeof response.body.draft === 'string' && response.body.draft.includes(item.preserveToken ?? '测量口径'),
    draftLength: typeof response.body.draft === 'string' ? response.body.draft.length : 0,
    failureDiagnostics: safeFailureDiagnostics(response.body) ?? null,
    health: {
      ok: health.body.ok === true,
      bridgeVersion: health.body.bridgeVersion ?? null,
      execReady: health.body.execReady === true,
      busy: health.body.busy === true,
    },
  };
  const persisted = response.status === 200
    ? {
      schemaVersion: 'codex.annotation-e2e.v1',
      case: item.name,
      elapsedMs,
      httpStatus: response.status,
      requestSummary: {
        mode: 'annotation_regeneration',
        hasManualEdit: true,
        annotationCount: item.annotations.length,
        conflictAnnotation: item.name === 'conflicting-fact-annotation',
      },
      draft: response.body.draft,
      receipts: response.body.receipts,
      editorialMemo: response.body.editorialMemo,
      qualityReview: response.body.qualityReview,
      diagnostics: {
        engine: response.body.diagnostics?.engine,
        passes: response.body.diagnostics?.passes,
        preservedUserEdits: response.body.diagnostics?.preservedUserEdits,
        remainingFlags: response.body.diagnostics?.remainingFlags,
      },
      health: result.health,
    }
    : {
      schemaVersion: 'codex.annotation-e2e.v1',
      case: item.name,
      elapsedMs,
      httpStatus: response.status,
      stage: response.body.code === 'review_failed' ? 'quality_review' : 'request',
      errorCode: response.body.code ?? 'request_failed',
      diagnostics: safeFailureDiagnostics(response.body) ?? null,
      health: result.health,
    };
  await fs.mkdir(qaDirectory, { recursive: true });
  await fs.writeFile(path.join(qaDirectory, `codex-annotation-e2e-${item.name}.json`), `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
  results.push(result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const finalHealth = await jsonRequest('/health');
if (finalHealth.body.busy === true) throw new Error('bridge remained busy after annotation smoke');
process.stdout.write(JSON.stringify({ ok: true, cases: results.length, busyReleased: finalHealth.body.busy === false }) + '\n');
