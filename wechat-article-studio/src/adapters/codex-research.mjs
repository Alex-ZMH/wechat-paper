import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEvidencePacket } from '../contracts/evidence-packet.mjs';
import { ContractError, requiredText } from '../lib/primitives.mjs';
import { resolveCodexExecutable } from '../lib/codex-executable.mjs';

export const CODEX_RESEARCH_PROVIDER = 'codex-cli';
export const CODEX_RESEARCH_SCHEMA_PATH = fileURLToPath(new URL('../schemas/codex-research-output.schema.json', import.meta.url));

function id(value, field) {
  // IDs are contract keys.  Replacing punctuation (for example, both
  // `source/a` and `source-a`) is lossy and can create collisions between a
  // source and the claim that cites it.  Keep the caller's value intact;
  // createEvidencePacket performs the actual uniqueness check.
  return requiredText(value, field);
}

function fail(code, message, details = {}) {
  return new ContractError(code, message, details);
}

export function buildCodexResearchPrompt(brief) {
  return [
    '你是严谨的中文研究员。请针对以下写作任务进行真实联网检索，并只返回 output-schema 所要求的 JSON。',
    '硬约束：',
    '1. 只保留你实际访问到的公开 URL；不得编造论文、网页、日期、摘录、统计数据或机构。',
    '2. source 的 excerpt 若是可确认的原文短摘录须如实保留标点；若只能获得资料要点，请明确标注为整理要点，不要用引号伪装原文。提供可用的章节或网页位置；不清楚时留空，不要编造。',
    '3. 每个 claim 必须绑定至少一个 sourceId；事实和推断要区分，年份、地区、条件及不确定性如实说明。',
    '4. 资料不足时返回少量可用来源；若没有可用来源，sources 和 claims 都可以返回空数组，系统会如实报告证据不足。',
    '5. 优先原始论文、官方统计、监管或机构原始资料；新闻只可作为补充，且必须标明其限制。',
    `任务：${JSON.stringify({ topic: brief.topic, purpose: brief.purpose, audience: brief.audience, channel: brief.channel, cutoff: new Date().toISOString().slice(0, 10) })}`,
  ].join('\n');
}

function normalizeOutput(brief, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.sources) || !Array.isArray(raw.claims)) {
    throw fail('research_invalid_json', '联网研究返回的资料格式不完整。请重试。');
  }
  if (raw.sources.length === 0 || raw.claims.length === 0) {
    throw fail('research_insufficient_evidence', '联网研究没有返回足够的来源与论点证据。', {
      sources: raw.sources.length,
      claims: raw.claims.length,
    });
  }
  const accessedAt = new Date().toISOString();
  const skipped = [];
  const sources = raw.sources.flatMap((source, index) => {
    const url = String(source?.url ?? '').trim();
    if (!/^https?:\/\//iu.test(url) || !String(source?.title ?? '').trim() || !String(source?.excerpt ?? '').trim() || !String(source?.sourceId ?? '').trim()) {
      skipped.push({ kind: 'source', index, reason: 'missing_url_title_excerpt_or_id' });
      return [];
    }
    return [{
      sourceId: id(source.sourceId, `research.sources[${index}].sourceId`),
      title: requiredText(source.title, `research.sources[${index}].title`), url,
      excerpt: requiredText(source.excerpt, `research.sources[${index}].excerpt`),
      locator: String(source?.locator ?? ''),
      publisher: String(source?.publisher ?? ''), publishedAt: String(source?.publishedAt ?? ''),
      sourceType: String(source?.sourceType ?? ''), authority: String(source?.authority ?? ''),
      accessedAt, sourceOrigin: 'realtime_research',
    }];
  });
  const sourceIds = new Set(sources.map(source => source.sourceId));
  const claims = raw.claims.flatMap((claim, index) => {
    if (!claim?.claimId || !claim?.text || !Array.isArray(claim?.evidenceIds) || !claim.evidenceIds.length || claim.evidenceIds.some(id => !sourceIds.has(id))) {
      skipped.push({ kind: 'claim', index, reason: 'missing_claim_or_valid_source' });
      return [];
    }
    const kind = claim?.kind == null || claim.kind === ''
      ? 'fact'
      : requiredText(claim.kind, `research.claims[${index}].kind`);
    if (!['fact', 'inference'].includes(kind)) {
      throw fail('research_invalid_json', '研究结果中的论点 kind 只能是 fact 或 inference。', {
        index,
        kind,
      });
    }
    return [{
      claimId: id(claim?.claimId, `research.claims[${index}].claimId`),
      text: requiredText(claim?.text, `research.claims[${index}].text`),
      evidenceIds: Array.isArray(claim?.evidenceIds) ? claim.evidenceIds.map((value) => id(value, `research.claims[${index}].evidenceIds`)) : [],
      confidence: Number.isFinite(claim?.confidence) ? claim.confidence : 0.7,
      caveat: String(claim?.caveat ?? ''), kind, status: String(claim?.status ?? 'supported'),
    }];
  });
  if (!sources.length || !claims.length) throw fail('research_insufficient_evidence', '联网研究没有返回可用的来源与论点。', { skipped });
  try { return { packet: createEvidencePacket(brief, { sources, claims }), skipped }; }
  catch (error) { throw fail('research_source_invalid', '研究结果没有完整的来源与论点对应关系。', { cause: error?.code }); }
}

const TOOL_ITEM_TYPES = new Set([
  'command_execution', 'computer_call', 'custom_tool_call', 'file_change',
  'file_search_call', 'function_call', 'local_shell_call', 'mcp_tool_call',
  'shell_command', 'tool_call',
]);

function redactText(value) {
  return String(value ?? '')
    .replace(/\bBearer\s+[^\s]+/giu, 'Bearer [redacted]')
    .replace(/\b(?:sk|pk|rk|ghp|github_pat|xoxb|xoxp|pplx)-[a-z0-9_-]+\b/giu, '[redacted]')
    .replace(/([?&](?:token|access_token|api[_-]?key|key|secret|password)=)[^&\s]+/giu, '$1[redacted]')
    .replace(/\b(authorization|cookie|set-cookie|api[_-]?key|password|secret|token)\s*[:=]\s*[^\s]+/giu, '$1 [redacted]');
}

function failureText(value, max = 2000) {
  const text = redactText(value);
  return text.length > max ? text.slice(-max) : text;
}

function safeAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return undefined;
  const value = {};
  for (const key of ['type', 'query', 'url', 'domain', 'q']) {
    if (typeof action[key] === 'string') value[key] = redactText(action[key]);
  }
  if (Array.isArray(action.domains)) value.domains = action.domains.filter((item) => typeof item === 'string').map(redactText);
  return Object.keys(value).length > 0 ? value : undefined;
}

function safeItem(item, { includeAction = false } = {}) {
  const value = {};
  if (item && typeof item === 'object') {
    for (const key of ['id', 'type', 'status', 'name']) {
      if (typeof item[key] === 'string') value[key] = redactText(item[key]);
    }
    if (includeAction) {
      const action = safeAction(item.action);
      if (action) value.action = action;
    }
  }
  return value;
}

function itemFromEvent(event) {
  if (!event || typeof event !== 'object') return undefined;
  if (event.item && typeof event.item === 'object' && !Array.isArray(event.item)) return event.item;
  if (event.data?.item && typeof event.data.item === 'object' && !Array.isArray(event.data.item)) return event.data.item;
  return undefined;
}

function itemTypeFromEvent(event, item) {
  if (typeof item?.type === 'string') return item.type;
  if (typeof event?.item_type === 'string') return event.item_type;
  return typeof event?.type === 'string' ? event.type : '';
}

function isWebSearchItem(event, item) {
  const type = itemTypeFromEvent(event, item);
  return type === 'web_search_call' || type === 'web_search' || type === 'web_search_result';
}

function isToolItem(event, item) {
  const type = itemTypeFromEvent(event, item);
  return TOOL_ITEM_TYPES.has(type);
}

function messageText(item) {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.text === 'string') return item.text;
  if (Array.isArray(item.content)) return item.content.map((part) => {
    if (typeof part === 'string') return part;
    return typeof part?.text === 'string' ? part.text : '';
  }).join('');
  return '';
}

function parseCandidate(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function errorDetails(error) {
  return {
    cause: error?.code,
    message: failureText(error?.message),
  };
}

/**
 * Run Codex in JSONL mode and return its structured final response.
 *
 * JSONL item events are observational only: reasoning and ordinary agent
 * messages are intentionally not forwarded to trace/progress hooks.  The
 * final response still comes from --output-last-message when available; the
 * completed agent_message is only a testable/defensive fallback.
 */
export async function runCodexResearchJson(prompt, options = {}) {
  const {
    signal,
    model = process.env.RESEARCH_MODEL ?? 'gpt-5.6-sol',
    search = true,
    executable,
    schemaPath = CODEX_RESEARCH_SCHEMA_PATH,
    spawnImpl = nodeSpawn,
    mkdtempImpl = mkdtemp,
    readFileImpl = readFile,
    rmImpl = rm,
    onProgress,
    onTrace,
    killGraceMs = 500,
  } = options;
  let executableInfo;
  try { executableInfo = executable == null ? resolveCodexExecutable() : { command: String(executable), source: 'option' }; }
  catch (error) { throw fail('research_unavailable', '联网研究服务无法启动。请检查 Codex 登录状态。', { cause: error?.code }); }
  if (!executableInfo.command.trim()) throw fail('research_unavailable', '联网研究服务无法启动。请检查 Codex 登录状态。');
  if (signal?.aborted) throw fail('research_cancelled', 'Research was cancelled by the user');
  const tempDir = await mkdtempImpl(join(tmpdir(), 'wechat-article-research-'));
  const outputPath = join(tempDir, 'research-output.json');
  const args = [
    '-c', 'approval_policy=never',
    ...(search === false ? ['-c', 'web_search="disabled"'] : []),
    ...(search === false ? [] : ['--search']),
    'exec', '--json',
    ...(model ? ['-m', model] : []),
    '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only',
    '--output-schema', schemaPath, '-o', outputPath, '-C', process.cwd(), '-',
  ];
  const emit = async (event) => {
    try { await onTrace?.({ timestamp: new Date().toISOString(), ...event }); } catch {}
    try { await onProgress?.({ stage: event.stage, ...event }); } catch {}
  };
  try {
    const processResult = await new Promise((resolve, reject) => {
      let stderr = '';
      let stdoutBuffer = '';
      let stdoutLine = 0;
      let child;
      let settled = false;
      let closeSeen = false;
      let cancelling = false;
      let forcedKill = false;
      let cancelTimer;
      let candidate;
      let processError;
      let stdinError;
      let stdoutError;
      let ioFailure;
      const jsonLineErrors = [];
      let eventQueue = Promise.resolve();

      function queueEvent(event) {
        eventQueue = eventQueue.then(() => emit(event)).catch(() => {});
      }

      function terminateChild() {
        if (settled || closeSeen || cancelTimer) return;
        cancelTimer = setTimeout(() => {
          if (closeSeen) return;
          forcedKill = true;
          try { child?.kill?.('SIGKILL'); } catch (error) { processError = processError ?? error; }
          queueEvent({
            event: 'direct_research_process_kill_escalated',
            stage: 'research', lifecycle: 'kill_escalated',
          });
        }, Math.max(0, Number(killGraceMs) || 0));
        try { child?.kill?.('SIGTERM'); } catch (error) { processError = processError ?? error; }
      }

      const abort = () => {
        if (settled || closeSeen || cancelling || ioFailure) return;
        cancelling = true;
        queueEvent({
          event: 'direct_research_process_cancellation_requested',
          stage: 'research', lifecycle: 'cancelling',
        });
        terminateChild();
      };

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (cancelTimer) clearTimeout(cancelTimer);
        signal?.removeEventListener?.('abort', abort);
        fn(value);
      };

      const parseLine = (line) => {
        const text = String(line).trim();
        if (!text) return;
        stdoutLine += 1;
        let event;
        try { event = JSON.parse(text); }
        catch {
          jsonLineErrors.push(stdoutLine);
          return;
        }
        if (!event || typeof event !== 'object' || Array.isArray(event)) return;
        const item = itemFromEvent(event);
        const itemType = itemTypeFromEvent(event, item);
        const itemEvent = typeof event.type === 'string' ? event.type : undefined;
        if (isWebSearchItem(event, item)) {
          const safe = safeItem(item ?? { type: itemType, action: event.action }, { includeAction: true });
          queueEvent({
            event: 'direct_research_search_item', stage: 'research_retrieval',
            itemEvent, item: safe, searchItem: safe,
          });
        } else if (isToolItem(event, item)) {
          queueEvent({
            event: 'direct_research_tool_item', stage: 'research', itemEvent,
            item: safeItem(item ?? { type: itemType }),
          });
        }

        if (itemType === 'agent_message' || itemType === 'assistant_message') {
          candidate = parseCandidate(messageText(item)) ?? candidate;
        }
      };

      const consumeStdout = (chunk) => {
        stdoutBuffer += String(chunk);
        let newline;
        while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, newline);
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          parseLine(line);
        }
      };
      const flushStdout = () => {
        if (stdoutBuffer.trim()) parseLine(stdoutBuffer);
        stdoutBuffer = '';
      };

      if (signal?.aborted) return finish(reject, fail('research_cancelled', 'Research was cancelled by the user'));
      try {
        child = spawnImpl(executableInfo.command, args, {
          cwd: process.cwd(), env: process.env, shell: false, windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        queueEvent({ event: 'direct_research_process_failed', stage: 'research', lifecycle: 'spawn_failed', failure: errorDetails(error) });
        eventQueue.then(() => finish(reject, fail('research_unavailable', '联网研究服务无法启动。请检查 Codex 登录状态。', errorDetails(error))));
        return;
      }

      queueEvent({
        event: 'direct_research_process_started', stage: 'research', lifecycle: 'started',
        executableSource: executableInfo.source, model, search: search !== false,
      });
      signal?.addEventListener?.('abort', abort, { once: true });
      child.stderr?.on?.('data', (chunk) => { stderr += String(chunk); });
      child.stdout?.on?.('data', consumeStdout);
      child.stdout?.once?.('error', (error) => {
        if (!stdoutError) stdoutError = error;
        if (!cancelling && !ioFailure && !closeSeen && !settled) {
          ioFailure = fail('research_unavailable', '联网研究服务无法读取输出。', errorDetails(error));
          queueEvent({ event: 'direct_research_process_failed', stage: 'research', lifecycle: 'stdout_error', failure: errorDetails(error) });
          terminateChild();
        }
      });
      child.stderr?.once?.('error', () => {});
      child.once?.('error', (error) => {
        processError = error;
        queueEvent({ event: 'direct_research_process_failed', stage: 'research', lifecycle: 'error', failure: errorDetails(error) });
        if (!cancelling && !ioFailure) eventQueue.then(() => finish(reject, fail('research_unavailable', '联网研究服务无法启动。请检查 Codex 登录状态。', errorDetails(error))));
      });
      child.once?.('close', (code, signalName) => {
        closeSeen = true;
        if (cancelTimer) clearTimeout(cancelTimer);
        flushStdout();
        eventQueue = eventQueue.then(async () => {
          const failed = code !== 0 || cancelling || processError || stdinError || stdoutError || ioFailure;
          const failure = !failed ? undefined : {
            code, signal: signalName, stderr: failureText(stderr),
          };
          await emit({
            event: failed ? 'direct_research_process_failed' : 'direct_research_process_finished',
            stage: 'research', lifecycle: 'closed', ...(failure ? { failure } : {}),
          });
          if (cancelling) {
            finish(reject, fail('research_cancelled', 'Research was cancelled by the user', {
              code, signal: signalName, forcedKill,
            }));
          } else if (ioFailure) {
            // An I/O error has already classified the failure.  Do not release
            // the job slot or remove the temp directory until child close has
            // confirmed that the terminated process is gone.
            finish(reject, ioFailure);
          } else if (code !== 0 || processError || stdinError || stdoutError) {
            finish(reject, fail('research_failed', '联网研究未能完成。请稍后重试。', {
              code, signal: signalName, stderr: failureText(stderr),
              ...(processError ? { process: errorDetails(processError) } : {}),
              ...(stdinError ? { stdin: errorDetails(stdinError) } : {}),
              ...(stdoutError ? { stdout: errorDetails(stdoutError) } : {}),
            }));
          } else {
            finish(resolve, { candidate, outputPath, jsonLineErrors, stderr });
          }
        }).catch((error) => finish(reject, error));
      });

      const stdin = child.stdin;
      const handleStdinError = (error) => {
        if (!stdinError) stdinError = error;
        if (!cancelling && !ioFailure && !closeSeen && !settled) {
          ioFailure = fail('research_unavailable', '联网研究服务无法发送研究请求。', errorDetails(error));
          queueEvent({ event: 'direct_research_process_failed', stage: 'research', lifecycle: 'stdin_error', failure: errorDetails(error) });
          terminateChild();
        }
      };
      stdin?.once?.('error', handleStdinError);
      try { stdin?.end?.(prompt); }
      catch (error) { handleStdinError(error); }
    });

    let raw;
    try {
      raw = JSON.parse(await readFileImpl(processResult.outputPath, 'utf8'));
    } catch (error) {
      raw = processResult.candidate;
      if (!raw) {
        await emit({
          event: 'direct_research_json_parse_failed', stage: 'research', lifecycle: 'output_parse_failed',
          failure: errorDetails(error), jsonLines: processResult.jsonLineErrors,
        });
        throw fail('research_invalid_json', '联网研究返回的资料格式不完整。请重试。', {
          cause: failureText(error?.message), jsonLines: processResult.jsonLineErrors,
        });
      }
    }
    return raw;
  } finally { await rmImpl(tempDir, { recursive: true, force: true }).catch(() => {}); }
}

/** Run a fresh live-web search in the authenticated local Codex CLI and fail closed on incomplete evidence. */
export async function fetchCodexResearchEvidence(brief, options = {}) {
  const raw = await runCodexResearchJson(buildCodexResearchPrompt(brief), {
    ...options,
    search: options.search ?? true,
    model: options.model ?? process.env.RESEARCH_MODEL ?? 'gpt-5.6-sol',
  });
  const { packet, skipped } = normalizeOutput(brief, raw);
  try { await options.onTrace?.({ timestamp: new Date().toISOString(), event: 'candidate_ready', stage: 'research', sources: packet.sources.length, claims: packet.claims.length, packetId: packet.packetId, skipped }); } catch {}
  return { packet, skipped, clientRunId: options.clientRunId ?? null, providerRef: null };
}

export function normalizeCodexResearchOutput(brief, raw) { return normalizeOutput(brief, raw).packet; }
