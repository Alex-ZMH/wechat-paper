import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { detectRestrictedPage, matchSourceExcerpt, publicSourceUrl, verifyResearchSources } from '../src/lib/source-verification.mjs';

const source = { sourceId: 's1', url: 'https://example.org/report', excerpt: '样本中该类别占10%。' };
const packet = { sources: [source] };
const options = { lookupImpl: async () => [{ address: '93.184.216.34' }], extractImpl: async buffer => buffer.toString() };

test('public-source verification rejects nonexistent/local/private URLs', async () => {
  for (const url of ['https://proof.invalid/x', 'http://localhost/x', 'http://127.0.0.1/x', 'http://10.0.0.1/x', 'file:///secret', 'https://name:secret@example.org/x']) {
    await assert.rejects(() => publicSourceUrl(url, options.lookupImpl), { code: 'research_source_invalid' });
  }
  await assert.rejects(() => publicSourceUrl('https://example.org', async () => [{ address: '192.168.1.4' }]), { code: 'research_source_invalid' });
});

test('source verification reads real response content and retains matched context/hash', async () => {
  const traces = [];
  const verified = await verifyResearchSources(packet, { ...options, fetchImpl: async () => new Response(`正文：${source.excerpt}仅代表当前样本。`, { headers: { 'content-type': 'text/plain' } }), onTrace: event => traces.push(event) });
  assert.equal(verified[0].status, 'excerpt_matched');
  assert.equal(verified[0].contentHash.length, 64);
  assert.match(verified[0].matchedContexts[0], /仅代表当前样本/u);
  assert.ok(traces.some(event => event.event === 'source_excerpt_verified'));
});

test('a reachable page with the wrong figure does not pass verification', async () => {
  const [result] = await verifyResearchSources(packet, { ...options, fetchImpl: async () => new Response('样本中该类别占90%。') });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'research_excerpt_mismatch');
});

test('HTTP errors and redirected private targets remain failures', async () => {
  const [httpError] = await verifyResearchSources(packet, { ...options, fetchImpl: async () => new Response('denied', { status: 403 }) });
  assert.equal(httpError.status, 'failed');
  assert.equal(httpError.code, 'research_source_unreachable');
  const [redirectError] = await verifyResearchSources(packet, { ...options, fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) });
  assert.equal(redirectError.status, 'failed');
  assert.equal(redirectError.code, 'research_source_invalid');
});

test('excerpt matching accepts layout whitespace and explicit omissions, never reordered or changed values', () => {
  assert.ok(matchSourceExcerpt('A study reports 10% among the sample. Limits apply.', 'A study reports 10%…Limits apply.'));
  assert.ok(matchSourceExcerpt('样本中\n该类别占10%。', source.excerpt));
  assert.equal(matchSourceExcerpt(source.excerpt, '样本中该类别占100%。'), null);
  assert.equal(matchSourceExcerpt('电导率为10 mS/cm。', '电导率为10 MS/cm。'), null);
  assert.equal(matchSourceExcerpt('后半段内容，前半段内容', '前半段内容…后半段内容'), null);
});

test('an already cancelled source task cannot publish verified evidence', async () => {
  await assert.rejects(() => verifyResearchSources(packet, { ...options, signal: AbortSignal.abort(), fetchImpl: async () => { throw Error('must not fetch'); } }), { code: 'research_cancelled' });
});

test('cancellation also interrupts a pending DNS lookup', async () => {
  const controller = new AbortController();
  const pending = publicSourceUrl(source.url, () => new Promise(() => {}), controller.signal);
  controller.abort(new Error('lookup cancelled'));
  await assert.rejects(pending, /lookup cancelled/u);
});

test('one transient transport retry still requires a matching original excerpt', async () => {
  let calls = 0;
  const traces = [];
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    return new Response(source.excerpt);
  };
  const result = await verifyResearchSources(packet, { ...options, fetchImpl, onTrace: event => traces.push(event) });
  assert.equal(result[0].status, 'excerpt_matched');
  assert.equal(calls, 2);
  assert.ok(traces.some(event => event.event === 'source_read_retry'));
});

test('list punctuation is only used to locate and restore the actual source quotation', async () => {
  const variant = { sources: [{ ...source, excerpt: '比例为10%、20%，仅限该样本。' }] };
  const result = await verifyResearchSources(variant, { ...options, fetchImpl: async () => new Response('原文：比例为10%，20%，仅限该样本。其他内容。') });
  assert.equal(result[0].excerpt, '比例为10%，20%，仅限该样本。');
  assert.equal(result[0].punctuationRestored, true);
  assert.match(result[0].contextualExcerpt, /原文：比例为10%，20%，仅限该样本。其他内容。/u);
  const [mismatch] = await verifyResearchSources(variant, { ...options, fetchImpl: async () => new Response('比例为10%，30%，仅限该样本。') });
  assert.equal(mismatch.status, 'failed');
  assert.equal(mismatch.code, 'research_excerpt_mismatch');
  const boundary = await verifyResearchSources(packet, { ...options, fetchImpl: async () => new Response('样本中该类别占10%；其他类别需要分别统计。') });
  assert.equal(boundary[0].excerpt, '样本中该类别占10%；');
  assert.match(boundary[0].contextualExcerpt, /其他类别需要分别统计/u);
});

test('one bad source does not remove good source results', async () => {
  const sources = [
    { sourceId: 'good-1', url: 'https://example.org/good-1', title: '可用来源 1', excerpt: '第一条资料的原文摘录。' },
    { sourceId: 'bad', url: 'https://example.org/bad', title: '不可用来源', excerpt: '不存在的原文摘录。' },
    { sourceId: 'good-2', url: 'https://example.org/good-2', title: '可用来源 2', excerpt: '第二条资料的原文摘录。' },
  ];
  const responses = new Map([
    [sources[0].url, '第一条资料的原文摘录。'],
    [sources[1].url, '登录后查看全文'],
    [sources[2].url, '第二条资料的原文摘录。'],
  ]);
  const results = await verifyResearchSources({ sources }, {
    ...options,
    fetchImpl: async url => new Response(responses.get(url.href)),
  });
  assert.deepEqual(results.map(result => result.sourceId), ['good-1', 'bad', 'good-2']);
  assert.deepEqual(results.map(result => result.status), ['excerpt_matched', 'failed', 'excerpt_matched']);
  assert.equal(results[1].code, 'research_source_restricted');
  assert.equal(results[1].details.restriction, 'login');
});

test('a duplicate URL is fetched and extracted once, while each submitted excerpt gets its own result', async () => {
  const sharedUrl = 'https://example.org/shared#section-a';
  let fetchCalls = 0;
  let extractCalls = 0;
  const results = await verifyResearchSources({ sources: [
    { sourceId: 'same-1', url: sharedUrl, title: '同一页面', excerpt: '页面中的第一条事实。' },
    { sourceId: 'same-2', url: 'https://EXAMPLE.org/shared#section-b', title: '同一页面的另一条记录', excerpt: '页面中的第二条事实。' },
  ] }, {
    ...options,
    fetchImpl: async () => {
      fetchCalls++;
      return new Response('页面中的第一条事实。页面中的第二条事实。');
    },
    extractImpl: async buffer => {
      extractCalls++;
      return buffer.toString();
    },
  });
  assert.equal(fetchCalls, 1);
  assert.equal(extractCalls, 1);
  assert.deepEqual(results.map(result => result.status), ['excerpt_matched', 'excerpt_matched']);
});

test('HTTP 200 login, CAPTCHA, and paywall pages never pass as source excerpts', async () => {
  assert.equal(detectRestrictedPage('Please log in to continue reading', 'text/html')?.kind, 'login');
  assert.equal(detectRestrictedPage('Login')?.kind, 'login');
  const cases = [
    ['Please log in to continue reading', 'login'],
    ['验证码：请完成验证后继续访问', 'captcha'],
    ['Subscribe to read this article', 'paywall'],
  ];
  for (const [body, restriction] of cases) {
    const [result] = await verifyResearchSources({ sources: [{ ...source, url: `https://example.org/${restriction}`, excerpt: source.excerpt }] }, {
      ...options,
      fetchImpl: async () => new Response(`原文摘录：${source.excerpt}\n${body}`, { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'research_source_restricted');
    assert.equal(result.details.restriction, restriction);
  }
});

test('a labelled summary is not relabelled as a direct quote', async () => {
  const [result] = await verifyResearchSources({ sources: [{
    ...source,
    excerpt: '整理要点：该研究只在当前样本中观察到该比例。',
  }] }, {
    ...options,
    fetchImpl: async () => new Response('该研究只在当前样本中观察到该比例。'),
  });
  assert.equal(result.status, 'summary_not_verified');
  assert.equal(result.verificationStatus, 'not_a_direct_quote');
  assert.equal(result.excerptKind, 'synthesized_summary');
  assert.equal(result.code, 'research_excerpt_not_quote');
  assert.equal(result.excerpt, undefined);
  assert.equal(result.submittedExcerpt, '整理要点：该研究只在当前样本中观察到该比例。');
});

function extractSourceText(html) {
  return new Promise((resolve, reject) => {
    const python = process.platform === 'win32' ? 'py' : 'python3';
    const args = process.platform === 'win32' ? ['-3', 'src/lib/source-text.py'] : ['src/lib/source-text.py'];
    const child = spawn(python, args, { cwd: new URL('..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`source-text.py exited with ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout).text);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(Buffer.from(html, 'utf8'));
  });
}

test('source text includes explicit abstract metadata without leaking scripts, templates, or generic descriptions', async () => {
  const abstract = '模板未展开时仍可读取的摘要：研究 A & B，保留实体文本 &lt;。';
  const html = `<!doctype html>
    <html><head>
      <meta name="citation_abstract" xml:lang="zh" content="模板未展开时仍可读取的摘要：研究 A &amp; B，保留实体文本 &amp;lt;。">
      <meta name="citation_abstract" content="模板未展开时仍可读取的摘要：研究 A &amp; B，保留实体文本 &amp;lt;。">
      <meta name="dc.description" content="模板未展开时仍可读取的摘要：研究 A &amp; B，保留实体文本 &amp;lt;。">
      <meta name="description" content="任意 description 不应进入原文">
      <script>var data = { abstract: '脚本摘要不应进入原文' };</script>
      <template><meta name="citation_abstract" content="模板摘要不应进入原文"></template>
    </head><body><p>可见正文仍需保留。</p><div>{{article.zhaiyao_cn}}</div></body></html>`;

  const text = await extractSourceText(html);
  assert.match(text, /可见正文仍需保留/);
  assert.match(text, /模板未展开时仍可读取的摘要：研究 A & B，保留实体文本 &lt;。/);
  assert.doesNotMatch(text, /保留实体文本 <。/);
  assert.equal(text.split(abstract).length - 1, 1);
  assert.doesNotMatch(text, /任意 description 不应进入原文|脚本摘要不应进入原文|模板摘要不应进入原文/);
});
