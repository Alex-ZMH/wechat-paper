import { readFile } from 'node:fs/promises';
import { createStyleProfile } from '../contracts/style-profile.mjs';

function section(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = markdown.match(new RegExp(`^##\\s+${escaped}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s+|\\s*$)`, 'imu'));
  return match?.[1] ?? '';
}

function bulletValues(text) {
  return [...text.matchAll(/^\s*-\s+(.*)$/gmu)]
    .map((match) => match[1].replace(/\*\*/gu, '').trim())
    .filter(Boolean);
}

/**
 * Load an existing Writing-DNA markdown artifact without making it a hidden
 * prompt. The loader extracts explicit rules only; raw articles remain a
 * separate future input to the drafting adapter.
 */
export function styleProfileFromMarkdown(markdown, { name = 'Imported style profile' } = {}) {
  const language = section(markdown, 'L1');
  const cognition = section(markdown, 'L5');
  const principles = [
    ...bulletValues(language).filter((item) => /句法|连接|语气|节奏/iu.test(item)),
    ...bulletValues(cognition).filter((item) => /核心表达命题|论证链|立场/iu.test(item)),
  ].slice(0, 12);
  const avoid = [];
  for (const match of markdown.matchAll(/(?:避免|规避)[“"]([^”"]+)[”"]/gu)) avoid.push(match[1]);
  const samples = [];
  const firstQuote = markdown.match(/^>\s+(.+)$/mu);
  if (firstQuote) samples.push({ sampleId: 'imported-note', title: 'DNA 说明', text: firstQuote[1] });
  return createStyleProfile({ name, principles: principles.length ? principles : ['先说明问题，再给出判断'], avoid, samples });
}

export async function loadStyleProfileFromMarkdown(filePath, options = {}) {
  return styleProfileFromMarkdown(await readFile(filePath, 'utf8'), { ...options, sourcePath: filePath });
}
