import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBrief } from '../src/contracts/brief.mjs';
import { createEvidencePacket } from '../src/contracts/evidence-packet.mjs';
import { createArgumentMap } from '../src/contracts/argument-map.mjs';
import { createDraft } from '../src/contracts/draft.mjs';
import { reviewDraft } from '../src/contracts/review-report.mjs';
import { attachContentAudit, contentTargets, createContentReviewer, normalizeContentAudit } from '../src/lib/content-review.mjs';
import { LocalWorkspaceStore } from '../src/lib/workspace-store.mjs';

function payload() {
  const brief = createBrief({ topic: '统计口径', purpose: '区分样本与全国', audience: '读者' });
  const evidencePacket = createEvidencePacket(brief, { sources: [{ sourceId: 's1', title: '样本报告', url: 'https://example.org', excerpt: '样本比例为10%。', sourceOrigin: 'human_curated' }], claims: [{ claimId: 'c1', text: '样本比例为10%。', evidenceIds: ['s1'] }] });
  const argumentMap = createArgumentMap(brief, evidencePacket, { points: [{ pointId: 'p1', heading: '统计范围', thesis: '比例仅代表样本', claimIds: ['c1'] }] });
  const draft = createDraft(brief, argumentMap, { title: '样本说明', digest: '样本比例为10%。', lead: '先看统计范围。', sections: [{ sectionId: 's1', heading: '范围', paragraphs: [{ paragraphId: 'p1', text: '全国比例为90%。', claimIds: ['c1'] }] }], closingCta: '请核对样本范围。' });
  return { brief, evidencePacket, argumentMap, draft };
}

function verdicts(value) { return { targets: contentTargets(value).map(target => ({ id: target.id, verdict: target.id === 'paragraph:p1' ? 'contradicted' : 'supported', reason: target.id === 'paragraph:p1' ? '来源只支持样本10%，不能写成全国90%。' : '没有新增无依据事实。', quote: '样本比例为10%。' })), editorialIssues: [] }; }

test('missing optional review adds no approval prerequisite, while findings remain visible', () => {
  const value = payload(); const structure = reviewDraft(value);
  assert.equal(structure.status, 'approved');
  assert.equal(attachContentAudit(structure, null).status, 'approved');
  const audit = normalizeContentAudit(verdicts(value), contentTargets(value));
  const reviewed = attachContentAudit(structure, audit);
  assert.equal(reviewed.status, 'review_required');
  assert.equal(reviewed.checks.contentSupported, false);
  assert.ok(reviewed.issues.some(issue => issue.code === 'content_contradiction'));
});

test('content audit refuses missing targets but never certifies model-repeated quotes', () => {
  const value = payload(); const targets = contentTargets(value);
  const missing = verdicts(value); missing.targets.pop();
  assert.throws(() => normalizeContentAudit(missing, targets), { code: 'content_review_failed' });
  const fake = verdicts(value); fake.targets[0].quote = '全国比例为90%。';
  assert.doesNotThrow(() => normalizeContentAudit(fake, targets));
});

test('optional review is on demand and never creates an approval receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-content-review-'));
  try {
    const value = payload(); let calls = 0;
    const reviewer = createContentReviewer(dir, { runImpl: async () => { calls++; return verdicts(value); } });
    await reviewer.review(value);
    assert.equal(calls, 1);
    const restarted = createContentReviewer(dir);
    assert.equal(restarted.apply(value, reviewDraft(value)).status, 'approved');
    const changed = structuredClone(value); changed.draft.sections[0].paragraphs[0].text = '样本比例为10%。';
    changed.contentAudit = { status: 'checked', issues: [] };
    assert.equal(restarted.apply(changed, reviewDraft(value)).status, 'approved');
    assert.equal(readdirSync(dir).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('malformed optional check reports a failure without writing receipts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-review-reason-'));
  try {
    const value = payload(); const raw = verdicts(value);
    raw.targets.pop();
    const reviewer = createContentReviewer(dir, { runImpl: async () => raw });
    await assert.rejects(reviewer.review(value), error => error.code === 'content_review_failed' && error.details.cause === 'incomplete_audit');
    assert.equal(readdirSync(dir).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt saved workspaces are backed up before any recovery write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-corrupt-workspace-'));
  try {
    const file = join(dir, 'workspace.json'); const original = '{damaged-but-recoverable';
    writeFileSync(file, original);
    const store = new LocalWorkspaceStore({ filePath: file });
    store.save({ workspaceId: 'recovery', baseVersion: 0, payload: { brief: { topic: '恢复副本' } } });
    const backup = readdirSync(dir).find(name => name.includes('.corrupt-'));
    assert.ok(backup); assert.equal(readFileSync(join(dir, backup), 'utf8'), original);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
