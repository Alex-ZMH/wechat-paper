import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWriterResponse, WRITER_REQUEST_SCHEMA_VERSION } from '../contracts/writer.mjs';
import { assertContractVersion, ContractError } from '../lib/primitives.mjs';
import { resolveCodexExecutable } from '../lib/codex-executable.mjs';

export const CODEX_WRITER_PROVIDER = 'codex-cli';
export const CODEX_WRITER_SCHEMA_PATH = fileURLToPath(new URL('../schemas/codex-writer-output.schema.json', import.meta.url));

function compactContext(writerRequest) {
  return JSON.stringify({
    brief: writerRequest.brief,
    evidencePacket: writerRequest.evidencePacket,
    argumentMap: writerRequest.argumentMap,
    styleProfile: writerRequest.styleProfile,
    previousDraft: writerRequest.draft,
    annotationSet: writerRequest.annotationSet,
  });
}

export function buildCodexWriterPrompt(writerRequest) {
  assertContractVersion(writerRequest, 'writerRequest', WRITER_REQUEST_SCHEMA_VERSION);
  const selectedClaimIds = writerRequest.argumentMap.points.flatMap((point) => point.claimIds);
  return [
    '你是证据约束的微信公众号文章 writer。只处理下方已经确认的 Brief、EvidencePacket、ArgumentMap 和可选 StyleProfile。',
    '最终响应必须是 output-schema 要求的 JSON 对象，不要 Markdown、代码围栏、解释、前后缀或另一种纯文本 draft。',
    '写作硬约束：',
    `1. 只写 ArgumentMap 选中的 claims（claimIds：${JSON.stringify(selectedClaimIds)}）。EvidencePacket 中未被 ArgumentMap 选中的 claims 仅是背景资料，不得在正文或结构化字段中补入、绑定或展开。`,
    '2. 只能使用选中 claims 的 sources 和 ArgumentMap 的 thesis；没有证据支持的事实、数字、因果、人物、时间和建议不得补写。',
    '3. sections/paragraphs 必须服务于文章结构；每个 paragraph 都要提供 claimIds 数组。组织、过渡和概括段可以使用空数组；有引用时只能引用已选中的 claimId。',
    '4. 只在确实推进文章时使用选中的 claim，不要为了机械覆盖率强行重复或补写内容；段落内容应自然解释所引用的 claim，不要把 claimIds 写进正文。',
    '5. 用自然、克制、可读的中文写作，避免同义反复、空泛口号和未经来源支持的确定性判断。',
    '6. 如果资料不足，删掉无法证实的内容，不要用常识或模型记忆填空。',
    '7. 每个 paragraph 只能使用其 claimIds 对应 claims 的 evidenceIds 所指向的 sources；不得把另一个 claim 的来源或未绑定来源的信息带进该段。',
    '8. 对 kind=inference 的 claim，正文应自然表达其证据边界和不确定性；不要把推断写成来源直接证明的事实。',
    `编辑上下文（JSON）：${compactContext(writerRequest)}`,
  ].join('\n');
}

function assertStructuredDraft(writerRequest, draftInput) {
  if (!draftInput || typeof draftInput !== 'object' || Array.isArray(draftInput)) {
    throw new ContractError('writer_response_invalid', 'Codex writer did not return a structured draftInput');
  }
  if (!Array.isArray(draftInput.sections) || draftInput.sections.length === 0) {
    throw new ContractError('writer_response_invalid', 'Codex writer returned no article sections');
  }
  const selectedClaims = writerRequest.argumentMap.points.flatMap((point) => point.claimIds);
  const knownClaims = new Set(selectedClaims);
  const paragraphs = [];
  for (const section of draftInput.sections) {
    if (!section || !Array.isArray(section.paragraphs) || section.paragraphs.length === 0) {
      throw new ContractError('writer_response_invalid', 'Every writer section must contain paragraphs');
    }
    for (const paragraph of section.paragraphs) paragraphs.push(paragraph);
  }
  if (paragraphs.length === 0) {
    throw new ContractError('writer_response_invalid', 'Codex writer returned no article sections or paragraphs');
  }
  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph.claimIds)) {
      throw new ContractError('writer_response_invalid', `Paragraph ${paragraph?.paragraphId ?? '(unknown)'} must provide claimIds as an array`, {
        paragraphId: paragraph?.paragraphId,
      });
    }
    for (const claimId of paragraph.claimIds) {
      if (!knownClaims.has(claimId)) {
        throw new ContractError('writer_response_invalid', `Paragraph references unknown claim ${claimId}`, {
          claimId,
          paragraphId: paragraph?.paragraphId,
          argumentMapId: writerRequest.argumentMap.mapId,
        });
      }
    }
  }
  return draftInput;
}

export function executableDefault(options = {}) {
  return resolveCodexExecutable(options).command;
}

function runCodex(executable, args, prompt, {
  spawnImpl = nodeSpawn,
  timeoutMs = 180000,
  executableSource = 'unknown',
} = {}) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let settled = false;
    let timer;
    let child;
    try {
      child = spawnImpl(executable, args, {
        cwd: process.cwd(),
        env: process.env,
        // The resolved value is an executable path, never a shell command.
        // Keep shell invocation disabled so .cmd shims cannot be concatenated
        // into an opaque command line on Windows.
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
    } catch (error) {
      reject(new ContractError('writer_unavailable', `Codex writer could not start: ${error.message}`, {
        cause: error.code,
        executable,
        executableSource,
      }));
      return;
    }
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    timer = setTimeout(() => {
      try { child.kill?.('SIGTERM'); } catch { /* process already exited */ }
      finish(reject, new ContractError('writer_timeout', `Codex writer timed out after ${timeoutMs} ms`, {
        timeoutMs,
        executable,
        executableSource,
      }));
    }, timeoutMs);
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => finish(reject, new ContractError('writer_unavailable', `Codex writer could not start: ${error.message}`, {
      cause: error.code,
      executable,
      executableSource,
    })));
    child.once('close', (code, signal) => {
      if (code !== 0) {
        finish(reject, new ContractError('writer_failed', `Codex writer exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`, {
          code,
          signal,
          executable,
          executableSource,
        }));
      } else {
        finish(resolve, { stderr, code, signal });
      }
    });
    child.stdin?.end(prompt);
  });
}

/** Call the authenticated local Codex CLI and fail closed on every provider/shape error. */
export async function fetchCodexWriter(writerRequest, {
  model = writerRequest?.model || process.env.WRITER_MODEL || 'gpt-5.6-sol',
  timeoutMs = 180000,
  executable,
  schemaPath = CODEX_WRITER_SCHEMA_PATH,
  spawnImpl = nodeSpawn,
  readFileImpl = readFile,
  mkdtempImpl = mkdtemp,
  rmImpl = rm,
} = {}) {
  assertContractVersion(writerRequest, 'writerRequest', WRITER_REQUEST_SCHEMA_VERSION);
  if (writerRequest.provider !== CODEX_WRITER_PROVIDER) {
    throw new ContractError('writer_provider_mismatch', `Codex writer requires provider=${CODEX_WRITER_PROVIDER}`);
  }
  const executableInfo = executable === undefined || executable === null
    ? resolveCodexExecutable()
    : { command: String(executable), source: 'option' };
  if (!executableInfo.command.trim()) {
    throw new ContractError('writer_unavailable', 'Codex writer executable is empty', { source: executableInfo.source });
  }
  const tempDir = await mkdtempImpl(join(tmpdir(), 'wechat-article-writer-'));
  const outputPath = join(tempDir, 'writer-output.json');
  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--output-schema', schemaPath,
    '--output-last-message', outputPath,
    ...(model ? ['--model', model] : []),
    '-',
  ];
  try {
    await runCodex(executableInfo.command, args, buildCodexWriterPrompt(writerRequest), {
      spawnImpl,
      timeoutMs,
      executableSource: executableInfo.source,
    });
    let raw;
    try {
      raw = JSON.parse(await readFileImpl(outputPath, 'utf8'));
    } catch (error) {
      throw new ContractError('writer_response_invalid', `Codex writer output was not valid JSON: ${error.message}`, {
        outputPath,
      });
    }
    const draftInput = assertStructuredDraft(writerRequest, raw);
    return createWriterResponse(writerRequest, {
      status: 'completed',
      provider: CODEX_WRITER_PROVIDER,
      model,
      draftInput,
      diagnostics: {
        structured: true,
        outputSchema: schemaPath,
        executable: executableInfo.command,
        executableSource: executableInfo.source,
      },
    });
  } finally {
    await rmImpl(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export { assertStructuredDraft };
