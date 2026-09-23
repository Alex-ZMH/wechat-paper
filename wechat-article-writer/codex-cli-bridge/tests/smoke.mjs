import { request } from 'node:http';

const host = '127.0.0.1';
const port = Number.parseInt(process.env.CODEX_BRIDGE_PORT ?? '43127', 10) || 43127;
const targetLength = Number(process.env.CODEX_SMOKE_TARGET_LENGTH ?? 900);
if (!Number.isInteger(targetLength) || targetLength < 300 || targetLength > 20000) {
  throw new Error('CODEX_SMOKE_TARGET_LENGTH must be an integer from 300 to 20000');
}
const audience = process.env.CODEX_SMOKE_AUDIENCE?.trim() || '希望把复杂问题想清楚的普通读者';
const materials = process.env.CODEX_SMOKE_MATERIALS ?? '';
const writerModel = process.env.CODEX_SMOKE_WRITER_MODEL?.trim() || 'codex-sol';
const reviewerModel = process.env.CODEX_SMOKE_REVIEWER_MODEL?.trim() || 'codex-sol';

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
      } : undefined,
      // Node 24 may inherit an Agent socket timeout when the option is left
      // undefined. Model requests intentionally wait until completion or an
      // explicit user cancellation; only the health probe is bounded.
      timeout: isHealthCheck ? 5_000 : 0,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = { error: 'invalid response' }; }
        resolve({ status: res.statusCode, body: parsed, requestId: res.headers['x-request-id'] });
      });
    });
    req.on('timeout', () => req.destroy(new Error(isHealthCheck ? 'health check timeout' : 'unexpected content socket timeout')));
    req.on('error', reject);
    if (encoded) req.end(encoded); else req.end();
  });
}

const health = await jsonRequest('/health');
if (health.status !== 200 || !health.body.ok || !health.body.cliAvailable || !health.body.authenticated) {
  throw new Error(`Codex bridge is not ready (status ${health.status ?? 'unknown'})`);
}

const topics = [
  '知识创作者怎样区分“素材很多”和“观点已经成立”？',
  '一个人长期做内容，为什么应该把事实资料、范文和旧稿分开管理？',
  '面对陌生主题，怎样先形成可验证的问题，而不是急着堆满答案？',
];
const topic = process.env.CODEX_SMOKE_TOPIC?.trim() || `${topics[Date.now() % topics.length]}（随机验收 ${new Date().toISOString()}）`;
const startedAt = Date.now();
process.stdout.write(`${JSON.stringify({ started: true, topic })}\n`);
const response = await jsonRequest('/v1/content', {
  schemaVersion: 'content-desk.request.v2',
  task: {
    kind: 'article',
    domain: '通用知识创作',
    genre: '分析文章',
    channel: '博客',
    purpose: '帮助读者建立可执行的判断方法',
  },
  mode: 'initial_generation',
  writerModel,
  reviewerModel,
  dualReview: true,
  brief: {
    topic,
    audience,
    format: '分析文章',
    tone: '克制真诚',
    targetLength: String(targetLength),
    materials,
  },
  previousGeneratedDraft: '',
  currentDraft: '',
  annotations: [],
  voiceProfile: { tone: '克制真诚', traits: ['具体', '自然', '不编造'] },
  skillChain: [],
  targetLength,
});

const reviewAudit = response.body?.reviewAudit;
const hasV31Receipt = response.body?.diagnostics?.passes === 3
  && response.body?.diagnostics?.reviewPasses === 2
  && Array.isArray(reviewAudit?.reviewers)
  && reviewAudit.reviewers.length === 2;

if (response.status !== 200
  || typeof response.body.draft !== 'string'
  || response.body.diagnostics?.engine !== 'codex-cli'
  || !hasV31Receipt) {
  throw new Error(`Codex smoke failed: ${JSON.stringify({
    status: response.status ?? 'unknown',
    requestId: response.requestId,
    elapsedMs: Date.now() - startedAt,
    code: response.body?.code,
    error: response.body?.error,
    diagnostics: response.body?.diagnostics,
  })}`);
}

process.stdout.write(JSON.stringify({
  ok: true,
  health: {
    cliVersion: health.body.cliVersion,
    authenticated: health.body.authenticated,
  },
  response: {
    requestId: response.requestId,
    elapsedMs: Date.now() - startedAt,
    topic,
    targetLength,
    writerModel,
    reviewerModel,
    status: response.body.status,
    recommendedTitle: response.body.recommendedTitle,
    visibleDraftLength: response.body.draft.replace(/\s/gu, '').length,
    editorialScore: response.body.qualityReview?.editorialScore?.total,
    passes: response.body.diagnostics?.passes ?? 0,
    reviewPasses: response.body.diagnostics?.reviewPasses ?? 0,
    reviewAudit: reviewAudit ? {
      frozenDraftHash: reviewAudit.frozenDraftHash,
      conservativeScore: reviewAudit.conservativeScore,
      reviewerScores: reviewAudit.reviewers.map((item) => item.score),
      reviewerModels: reviewAudit.reviewers.map((item) => item.model),
    } : null,
  },
}) + '\n');
