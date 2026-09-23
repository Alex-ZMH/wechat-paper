import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractError, sha256 } from './primitives.mjs';

const EXTRACTOR = fileURLToPath(new URL('./source-text.py', import.meta.url));
const MAX_BYTES = 12 * 1024 * 1024;
const compact = value => String(value).normalize('NFKC').replace(/\s+/gu, '');
const failure = (code, details) => new ContractError(code, '公开资料未能通过原文核对。', details);

// These are deliberately limited to access-gate language.  A page mentioning
// an ordinary account, subscription, or login as part of the article should
// not be rejected merely because it contains the word "login".  Stronger
// combinations below still catch the small HTML pages commonly returned by
// sign-in, CAPTCHA, bot-check, and paywall endpoints.
const RESTRICTION_PATTERNS = [
  {
    kind: 'captcha',
    patterns: [
      /(?:captcha|hcaptcha|recaptcha)/iu,
      /(?:验证码|图形验证|人机验证|安全验证|滑动验证|访问验证|请完成验证|验证您是人类)/u,
      /(?:enable|turn on)\s+(?:javascript|cookies).{0,80}(?:continue|access|view)/iu,
      /(?:verify|checking)\s+(?:you(?:'re| are)?\s+)?human/iu,
      /(?:security|browser)\s+check/iu,
      /(?:checking|verifying)\s+(?:your\s+)?browser/iu,
    ],
  },
  {
    kind: 'paywall',
    patterns: [
      /(?:paywall|premium\s+content|subscription\s+required)/iu,
      /(?:subscribe|subscription).{0,80}(?:read|access|continue|article)/iu,
      /(?:subscriber?s?|member(?:ship)?s?)\s+only/iu,
      /(?:subscribe|subscription|member(?:ship)?).{0,80}(?:only|premium|locked|requires?)/iu,
      /(?:unlock|upgrade).{0,50}(?:read|access|article|full)/iu,
      /(?:仅限会员|会员专享|订阅后阅读|订阅后查看|付费阅读|购买后阅读|付费内容)/u,
      /(?:阅读全文|查看全文).{0,30}(?:订阅|付费|会员|购买)/u,
    ],
  },
  {
    kind: 'login',
    patterns: [
      /(?:please\s+)?(?:log|sign)\s+in\s+(?:to\s+)?(?:continue|access|read|view)/iu,
      /(?:login|log\s+in)\s+(?:required|to\s+continue|to\s+read)/iu,
      /(?:registered|logged[- ]in)\s+users?\s+only/iu,
      /(?:请先|请)登录(?:后|以|才能|查看|阅读|继续)/u,
      /(?:登陆后|登录后)(?:查看|阅读|继续|访问|获取|阅读全文)/u,
      /(?:扫码登录|用户登录|登录查看全文)/u,
    ],
  },
];

function canonicalSourceUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    // Fragments are never sent in an HTTP request.  Treating them as part of
    // the cache key would read the same document twice in one check.
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function sourceMetadata(source) {
  const { excerpt, ...metadata } = source ?? {};
  return {
    ...metadata,
    sourceId: source?.sourceId,
    url: source?.url,
    submittedExcerpt: excerpt ?? '',
  };
}

function excerptKind(source) {
  const explicit = source?.excerptType ?? source?.excerptKind ?? source?.evidenceType ?? source?.quoteType;
  if (explicit === false || source?.isDirectQuote === false || source?.directQuote === false) return 'synthesized_summary';
  if (typeof explicit === 'string' && /(?:summary|整理|要点|摘要|synth|paraphrase|point)/iu.test(explicit)) return 'synthesized_summary';
  // The model prompt permits an explicit natural-language label.  Respect it
  // even when a page happens to repeat the same words: the label itself says
  // that the submitted text is a summary, not a direct quotation.
  if (/^\s*(?:整理要点|资料要点|模型整理|内容概要|summary|key\s+points?)\s*[:：]/iu.test(String(source?.excerpt ?? ''))) {
    return 'synthesized_summary';
  }
  return 'direct_quote';
}

/** Identify access gates without attempting to bypass them. */
export function detectRestrictedPage(text, contentType = '') {
  const value = String(text ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!value) return null;
  for (const { kind, patterns } of RESTRICTION_PATTERNS) {
    const matched = patterns.find(pattern => pattern.test(value));
    if (matched) return { kind, signal: matched.source };
  }
  // Tiny pages whose entire visible content is a sign-in/challenge heading
  // are often returned as HTTP 200 with no useful article body.  Keep this
  // fallback narrow so a normal article's login navigation is not rejected.
  if (value.length <= 400 && /^(?:please\s+)?(?:sign\s+in|log\s*in|login|登录|登陆|请登录|验证码|captcha)(?:[\s:：|/\\-].*)?$/iu.test(value)) {
    return { kind: /(?:captcha|验证码)/iu.test(value) ? 'captcha' : 'login', signal: 'short_access_gate_page' };
  }
  return null;
}

function outcomeFailure(source, error, fallbackCode = 'research_source_unreachable') {
  const code = error instanceof ContractError ? error.code : fallbackCode;
  const details = {
    ...(error instanceof ContractError ? error.details : {}),
    sourceId: source?.sourceId,
    url: source?.url,
  };
  return {
    ...sourceMetadata(source),
    status: 'failed',
    verificationStatus: 'failed',
    checked: false,
    excerptKind: excerptKind(source),
    code,
    details,
    error: error instanceof Error ? error.message : String(error ?? code),
  };
}

function privateAddress(address) {
  const value = address.toLowerCase().replace(/^\[|\]$/gu, '');
  if (value.includes(':')) return value === '::' || value === '::1' || /^(?:fc|fd|fe8|fe9|fea|feb|ff)/u.test(value) || value.startsWith('::ffff:');
  const [a, b] = value.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export async function publicSourceUrl(value, lookupImpl = lookup, signal) {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { throw failure('research_source_invalid', { url: value }); }
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !host.includes('.') && !isIP(host) || /(?:^|\.)(?:localhost|local|invalid|test)$/iu.test(host)) {
    throw failure('research_source_invalid', { url: value });
  }
  const addresses = isIP(host) ? [{ address: host }] : await new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => lookupImpl(host, { all: true }))
      .then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
  });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) throw failure('research_source_invalid', { url: value });
  return url;
}

export function matchSourceExcerpt(text, excerpt, { listPunctuation = false } = {}) {
  // Position mapping lets us retain the actual source quotation, not the
  // model's retyped punctuation. No word, number, sign or unit is discarded.
  const normalize = value => listPunctuation ? compact(value).replaceAll('、', ',').replace(/[;。]/gu, '\uE000') : compact(value);
  const starts = []; const ends = []; let haystack = ''; let offset = 0;
  for (const character of String(text)) {
    const normalized = normalize(character);
    haystack += normalized;
    for (let i = 0; i < normalized.length; i++) { starts.push(offset); ends.push(offset + character.length); }
    offset += character.length;
  }
  const parts = String(excerpt).split(/…+|\.{3,}/u).map(normalize).filter(Boolean);
  if (!parts.length || parts.some(part => part.length < 4)) return null;
  let end = 0;
  const matches = [];
  for (const part of parts) {
    const start = haystack.indexOf(part, end);
    if (start < 0) return null;
    end = start + part.length;
    matches.push({ start, end, original: String(text).slice(starts[start], ends[end - 1]), text: String(text).slice(Math.max(0, starts[start] - 1000), Math.min(String(text).length, ends[end - 1] + 400)) });
  }
  return matches;
}

async function extractText(buffer, charset, signal) {
  const bundled = join(process.env.USERPROFILE ?? '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python');
  const command = process.env.SOURCE_TEXT_PYTHON || process.env.WORD_EXPORT_PYTHON || (existsSync(bundled) ? bundled : process.platform === 'win32' ? 'py' : 'python3');
  const args = [...(command === 'py' ? ['-3'] : []), EXTRACTOR, charset || 'utf-8'];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let stderr = '';
    const stop = () => child.kill();
    const timer = setTimeout(stop, 30000);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(failure('research_source_unsupported', { cause: error.code })); });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      if (signal?.aborted) return reject(failure('research_cancelled', {}));
      try {
        if (code !== 0) throw new Error(stderr);
        const { text } = JSON.parse(output);
        if (!text?.trim()) throw new Error('No readable source text');
        resolve(text);
      } catch (error) { reject(failure('research_source_unsupported', { cause: error.message })); }
    });
    child.stdin.end(buffer);
  });
}

async function readSourceDocument(source, { signal, fetchImpl = fetch, lookupImpl = lookup, extractImpl = extractText, onTrace }, initialUrl) {
  const timeout = AbortSignal.timeout(45000);
  const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let url = initialUrl ?? await publicSourceUrl(source.url, lookupImpl, bounded);
  for (let redirect = 0; redirect < 6; redirect++) {
    const request = () => fetchImpl(url, { redirect: 'manual', signal: bounded, headers: { 'user-agent': 'ArticleStudio/1.0 (source verification)', accept: 'text/html,application/pdf,text/plain' } });
    let response;
    try { response = await request(); }
    catch (error) {
      const code = error.cause?.code ?? error.code;
      if (bounded.aborted || !['UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code)) throw error;
      onTrace?.({ event: 'source_read_retry', sourceId: source.sourceId, url: url.href, cause: code });
      response = await request(); // One same-URL transport retry within the same deadline; never relax content checks.
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw failure('research_source_unreachable', { sourceId: source.sourceId, url: url.href, reason: 'redirect_missing_location' });
      let redirectUrl;
      try { redirectUrl = new URL(location, url).href; }
      catch { throw failure('research_source_unreachable', { sourceId: source.sourceId, url: url.href, reason: 'redirect_invalid_location' }); }
      url = await publicSourceUrl(redirectUrl, lookupImpl, bounded);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw failure('research_source_unreachable', { sourceId: source.sourceId, url: url.href, status: response.status }); }
    if (!response.body) throw failure('research_source_unreadable', { sourceId: source.sourceId, url: url.href, reason: 'empty_body' });
    const chunks = []; let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_BYTES) throw failure('research_source_unsupported', { sourceId: source.sourceId, reason: 'source_too_large' });
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof ContractError) throw error;
      throw failure('research_source_unreadable', { sourceId: source.sourceId, url: url.href, cause: error?.cause?.code ?? error?.code ?? error?.message });
    }
    const buffer = Buffer.concat(chunks);
    const contentType = response.headers.get('content-type') ?? '';
    const charset = /charset\s*=\s*([^;\s]+)/iu.exec(contentType)?.[1]?.replaceAll('"', '');
    const text = await extractImpl(buffer, charset, bounded);
    if (!String(text ?? '').trim()) throw failure('research_source_unreadable', { sourceId: source.sourceId, url: url.href, reason: 'empty_text' });
    const restriction = detectRestrictedPage(text, contentType);
    if (restriction) {
      throw failure('research_source_restricted', {
        sourceId: source.sourceId,
        url: url.href,
        restriction: restriction.kind,
        signal: restriction.signal,
      });
    }
    return { url, contentType, buffer, text };
  }
  throw failure('research_source_unreachable', { sourceId: source.sourceId, reason: 'redirect_limit' });
}

async function readSource(source, options, document) {
    const { url, contentType, buffer, text } = document;
    if (typeof source?.excerpt !== 'string' || !source.excerpt.trim()) {
      throw failure('research_source_invalid', { sourceId: source?.sourceId, url: source?.url, field: 'excerpt' });
    }
    const exactMatches = matchSourceExcerpt(text, source.excerpt);
    const matches = exactMatches ?? matchSourceExcerpt(text, source.excerpt, { listPunctuation: true });
    if (!matches) throw failure('research_excerpt_mismatch', { sourceId: source.sourceId, url: url.href, excerpt: source.excerpt });
    const excerpt = matches.map(match => match.original.replace(/\s+/gu, ' ').trim()).join('…');
    // Preserve surrounding source text as well: a bare percentage can lose
    // the population, year or experimental conditions stated just above it.
    const contextualExcerpt = matches.map(match => `…${match.text.replace(/\s+/gu, ' ').trim()}…`).join('\n');
    return {
      ...sourceMetadata(source),
      finalUrl: url.href,
      checkedAt: new Date().toISOString(),
      contentType,
      contentHash: sha256(buffer.toString('base64')),
      excerpt,
      contextualExcerpt,
      originalSubmittedExcerpt: source.excerpt,
      punctuationRestored: !exactMatches,
      matchedContexts: matches.map(match => match.text),
      excerptKind: 'direct_quote',
      verificationStatus: 'matched',
      checked: true,
      status: 'excerpt_matched',
    };
}

/** Independent public-page reads; metadata supplied by the model cannot mark a source verified. */
export async function verifyResearchSources(packet, options = {}) {
  if (!packet || !Array.isArray(packet.sources)) throw failure('research_source_invalid', { field: 'packet.sources' });
  if (options.signal?.aborted) throw failure('research_cancelled', {});

  // Cache only for this invocation.  We cache the fetched/extracted document,
  // not a verification decision: two records at the same URL may submit
  // different excerpts and must receive separate results.
  const validationCache = new Map();
  const documentCache = new Map();
  const records = [];

  for (const source of packet.sources) {
    if (options.signal?.aborted) throw failure('research_cancelled', {});
    options.onProgress?.({ stage: 'research_audit', sourceId: source?.sourceId, url: source?.url });
    options.onTrace?.({ event: 'source_read_started', sourceId: source?.sourceId, url: source?.url });

    const kind = excerptKind(source);
    if (kind === 'synthesized_summary') {
      const error = failure('research_excerpt_not_quote', {
        sourceId: source?.sourceId,
        url: source?.url,
        evidenceKind: 'synthesized_summary',
        reason: 'submitted_excerpt_is_not_a_direct_quote',
      });
      const record = outcomeFailure(source, error);
      record.status = 'summary_not_verified';
      record.verificationStatus = 'not_a_direct_quote';
      options.onTrace?.({ event: 'source_verification_failed', code: error.code, details: error.details });
      records.push(record);
      continue;
    }

    try {
      const rawKey = canonicalSourceUrl(source?.url);
      let validation;
      if (rawKey && validationCache.has(rawKey)) {
        validation = validationCache.get(rawKey);
      } else {
        const validationTimeout = AbortSignal.timeout(45000);
        const validationSignal = options.signal ? AbortSignal.any([options.signal, validationTimeout]) : validationTimeout;
        validation = publicSourceUrl(source?.url, options.lookupImpl ?? lookup, validationSignal);
        if (rawKey) validationCache.set(rawKey, validation);
      }
      const validatedUrl = await validation;
      const key = canonicalSourceUrl(validatedUrl.href) ?? validatedUrl.href;
      let entry = documentCache.get(key);
      if (!entry) {
        entry = { sourceId: source?.sourceId, promise: readSourceDocument(source, options, validatedUrl) };
        documentCache.set(key, entry);
      } else {
        options.onTrace?.({ event: 'source_read_reused', sourceId: source?.sourceId, url: source?.url, reusedFrom: entry.sourceId });
      }
      const document = await entry.promise;
      const record = await readSource(source, options, document);
      options.onTrace?.({ event: 'source_excerpt_verified', ...record });
      records.push(record);
    } catch (error) {
      if (options.signal?.aborted || error?.code === 'research_cancelled') {
        throw error instanceof ContractError ? error : failure('research_cancelled', {});
      }
      const wrapped = error instanceof ContractError
        ? error
        : failure('research_source_unreachable', { sourceId: source?.sourceId, url: source?.url, cause: error?.cause?.code ?? error?.code ?? error?.message });
      const record = outcomeFailure(source, wrapped);
      options.onTrace?.({ event: 'source_verification_failed', code: wrapped.code, details: record.details });
      records.push(record);
    }
  }
  return records;
}
