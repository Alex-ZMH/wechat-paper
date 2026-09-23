/*
 * Fresh fixed-entry browser acceptance in an isolated project data directory.
 * This is deliberately a real Chromium run, not a source-string check. It
 * uses the verified-materials path so it does not hide the separately recorded
 * realtime-research failure behind a 15-minute retry.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dataDir = join(root, 'data', 'acceptance-20260904-run3');
const evidenceFile = join(root, 'evaluation', 'acceptance-20260904', 'fresh-browser-flow-run3.json');
const materials = join(root, 'evaluation', 'acceptance-20260904', 'attapulgite-verified-materials.json');
const origin = 'http://127.0.0.1:43210';
const results = [];
const errors = [];
let server;

const record = (name, details = {}) => { results.push({ name, status: 'passed', ...details }); console.log(name); };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer() {
  server = spawn(process.execPath, ['src/server.mjs'], {
    cwd: root,
    env: { ...process.env, WECHAT_STUDIO_DATA_DIR: dataDir, WECHAT_STUDIO_PORT: '43210' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  server.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  server.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  for (let i = 0; i < 80; i += 1) {
    if (server.exitCode !== null) throw new Error(`isolated server exited: ${stderr || stdout}`);
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return { stdout, stderr };
    } catch { /* wait for listen */ }
    await wait(100);
  }
  throw new Error(`isolated server did not start: ${stderr || stdout}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill();
  for (let i = 0; i < 40 && server.exitCode === null; i += 1) await wait(50);
}

const modulePath = join(process.env.USERPROFILE, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright', 'index.mjs');
await mkdir(join(root, 'evaluation', 'acceptance-20260904'), { recursive: true });
await mkdir(dataDir, { recursive: true });
try {
  const started = await startServer();
  const health = await (await fetch(`${origin}/api/health`)).json();
  record('fixed_entry_isolated_server_started', { health, stdout: started.stdout.trim() });

  const { chromium } = await import(pathToFileURL(modulePath));
  const browser = await chromium.launch({
    executablePath: join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    headless: true,
    chromiumSandbox: true,
  });
  const context = await browser.newContext({ viewport: { width: 1480, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  try {
    await page.goto(origin);
    await page.locator('#topic').fill('凹凸棒石在新能源领域面临的挑战与实际应用');
    await page.locator('#audience').fill('关注电池材料应用的产业读者');
    await page.locator('#purpose').fill('根据公开论文判断凹凸棒石在电池材料中的具体作用、实验条件和应用边界，区分实验室结果与产业化证据。');
    await page.locator('#targetLength').fill('1200');
    await page.locator('#tone').fill('清晰、克制、可信');
    record('new_topic_and_requirements_entered');

    await page.locator('#verified-materials-file').setInputFiles(materials);
    await page.locator('#import-choice').waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(await page.locator('#import-choice').inputValue(), '0');
    await page.locator('#confirm-import').click();
    await page.locator('[data-outline-heading="0"]').waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(await page.locator('#source-list .source-card').count(), 3);
    assert.match(await page.locator('#source-count').innerText(), /你导入的资料/);
    record('verified_materials_selected_and_sources_visible');

    const outline = [
      ['先看隔膜：有效果，也有条件', '限定在论文测试条件下解释凹凸棒石复合涂层的作用，不能外推全固态或量产。'],
      ['正极载体是另一种角色', '只说明石墨烯功能化凹凸棒石与硫复合正极的研究路线，不引用未核实性能数字。'],
      ['锂离子电池中的多层隔膜', '说明多层隔膜路线及其研究对象，保留完整测试条件尚未核对的边界。'],
      ['从论文走向应用，还要验证什么', '把材料角色、配比、工艺和客户验证分开评估，不把论文结果写成量产结论。'],
    ];
    for (let i = 0; i < outline.length; i += 1) {
      await page.locator(`[data-outline-heading="${i}"]`).fill(outline[i][0]);
      await page.locator(`[data-outline-thesis="${i}"]`).fill(outline[i][1]);
    }
    await page.locator('#confirm-outline').click();
    await page.locator('#generate-draft').waitFor({ state: 'visible', timeout: 30000 });
    record('outline_edited_and_confirmed');

    await page.locator('#generate-draft').click();
    await page.locator('#article-title').waitFor({ state: 'visible', timeout: 220000 });
    assert.ok(await page.locator('[data-paragraph-index="0:0"]').count());
    record('real_structured_writer_generated_draft');

    const paragraph = page.locator('[data-paragraph-index="0:0"]');
    const originalParagraph = await paragraph.inputValue();
    const modifiedParagraph = `${originalParagraph} 这是本次编辑版本的人工限定。`;
    await paragraph.fill(modifiedParagraph);
    await page.locator('#article-title').fill(`${await page.locator('#article-title').inputValue()}（编辑版）`);
    await paragraph.click();
    await page.locator('[data-panel="evidence"]').click();
    assert.match(await page.locator('#inspector-body').innerText(), /Attapulgite|凹凸棒石/);
    record('paragraph_edit_and_evidence_view');

    await page.locator('[data-panel="annotation"]').click();
    await page.locator('#annotation-text').fill('请复核材料配比与阻抗关系，确认没有外推到量产场景。');
    await page.locator('#annotation-priority').selectOption('high');
    await page.locator('#annotation-form button[type="submit"]').click();
    assert.match(await page.locator('#save-state').innerText(), /未保存/);
    record('high_priority_annotation_added_and_dirty');

    await page.locator('#save-button').click();
    await page.getByText('已保存当前文章和批注', { exact: false }).waitFor({ state: 'visible', timeout: 30000 });
    await page.locator('[data-step="4"]').click();
    assert.equal(await page.locator('#finalize-button').isEnabled(), false);
    record('high_annotation_saved_and_blocks_finalization');

    await page.reload();
    await page.locator('#article-title').waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(await page.locator('[data-paragraph-index="0:0"]').inputValue(), modifiedParagraph);
    await page.locator('[data-panel="annotation"]').click();
    assert.match(await page.locator('#inspector-body').innerText(), /高优先级.*待处理/);
    record('refresh_restores_article_edit_and_open_annotation');

    await stopServer();
    await startServer();
    await page.reload();
    await page.locator('#article-title').waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(await page.locator('[data-paragraph-index="0:0"]').inputValue(), modifiedParagraph);
    await page.locator('[data-step="4"]').click();
    assert.equal(await page.locator('#finalize-button').isEnabled(), false);
    record('service_restart_restores_article_and_open_annotation_gate');

    await page.locator('#rerun-review').click();
    await page.getByText('已重新审查', { exact: false }).waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(await page.locator('#finalize-button').isEnabled(), false);
    await page.locator('[data-panel="annotation"]').click();
    await page.locator('[data-comment-resolve]').first().click();
    await page.locator('#rerun-review').click();
    await page.getByText('已重新审查', { exact: false }).waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(await page.locator('#finalize-button').isEnabled(), false, 'review is dirty until save');
    await page.locator('#save-button').click();
    await page.getByText('已保存当前文章和批注', { exact: false }).waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(await page.locator('#finalize-button').isEnabled(), true, 'automatic review passes after explicit resolve and save');
    record('resolved_annotation_requires_rereview_and_save_before_delivery');

    const downloadEvent = page.waitForEvent('download', { timeout: 30000 });
    await page.locator('#review-download').click();
    const download = await downloadEvent;
    assert.match(download.suggestedFilename(), /审阅稿\.docx$/);
    const output = join(root, 'evaluation', 'acceptance-20260904', download.suggestedFilename());
    await download.saveAs(output);
    const visible = await page.locator('body').innerText();
    for (const token of ['human_curated', 'realtime_research', 'sourceOrigin', 'sourceId', 'claimId', 'review_required', 'Bridge', 'HTTP 504', 'research_timeout', 'EvidencePacket', 'ArgumentMap', 'WriterRequest', 'clientRunId', 'provider', 'allReady']) assert.equal(visible.includes(token), false, token);
    record('current_version_word_download_and_reader_ui_clean', { file: output, filename: download.suggestedFilename() });
    await page.screenshot({ path: join(root, 'evaluation', 'acceptance-20260904', 'fresh-browser-flow.png'), fullPage: true });
  } finally {
    await browser.close();
  }
} catch (error) {
  errors.push(String(error));
  console.error(error);
  throw error;
} finally {
  await stopServer();
  await writeFile(evidenceFile, JSON.stringify({ kind: 'real_chromium_acceptance', dataDir, origin, notUserAcceptance: true, results, errors }, null, 2));
}
