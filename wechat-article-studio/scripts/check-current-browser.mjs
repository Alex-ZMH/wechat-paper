// Real Chromium checks against a deliberately isolated running studio.
// Never run against the default data directory or create an article fixture.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { sha256 } from '../src/lib/primitives.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const dataDir=resolve(process.env.WECHAT_STUDIO_DATA_DIR??'');
assert.ok(dataDir.startsWith(join(root,'data','acceptance-')), 'Must point to an isolated project acceptance directory');
const origin='http://127.0.0.1:43210';
const health=await (await fetch(`${origin}/api/health`)).json();
assert.equal(health.workspaceScope,sha256(dataDir).slice(0,12),'Refuse to test a non-isolated server');
const saved=(await (await fetch(`${origin}/api/workspace/latest`)).json()).workspace;
assert.equal(saved.payload.brief.topic,'凹凸棒石在新能源领域面临的挑战与实际应用');
assert.ok(saved.annotationHistory.some(a=>a.priority==='high'&&a.status==='open'));
const output=join(root,'evaluation','acceptance-20260904');await mkdir(output,{recursive:true});
const dependencyRoot=join(process.env.USERPROFILE,'.cache','codex-runtimes','codex-primary-runtime','dependencies','node','node_modules');
const {chromium}=await import(pathToFileURL(join(dependencyRoot,'playwright','index.mjs')));
const browser=await chromium.launch({executablePath:join(process.env.ProgramFiles,'Google','Chrome','Application','chrome.exe'),headless:true,chromiumSandbox:true});
const context=await browser.newContext({viewport:{width:1480,height:1000},acceptDownloads:true});
const page=await context.newPage();
const results=[],errors=[];page.on('pageerror',e=>errors.push(String(e)));
const report=(name,details={})=>{results.push({name,status:'passed',at:new Date().toISOString(),...details});console.log(name);};
try {
  await page.goto(origin);await page.locator('#article-title').waitFor();
  assert.equal(await page.locator('#article-title').inputValue(),saved.payload.draft.title);
  assert.equal(await page.locator('[data-paragraph-index="0:0"]').inputValue(),saved.payload.draft.sections[0].paragraphs[0].text);
  await page.locator('[data-step="4"]').click();assert.equal(await page.locator('#finalize-button').isEnabled(),false);
  await page.locator('[data-panel="annotation"]').click();assert.match(await page.locator('#inspector-body').innerText(),/高优先级 · 待处理/);
  report('restart_restore_high_comment_gate',{workspaceId:saved.workspaceId,version:saved.version});
  await page.reload();await page.locator('#article-title').waitFor();await page.locator('[data-step="4"]').click();
  assert.equal(await page.locator('#finalize-button').isEnabled(),false);report('refresh_restore_high_comment_gate');
  await page.screenshot({path:join(output,'review-open-comment.png'),fullPage:true});
  const downloadPromise=page.waitForEvent('download');await page.locator('#review-download').click();const download=await downloadPromise;
  assert.match(download.suggestedFilename(),/审阅稿\.docx$/);const file=join(output,download.suggestedFilename());await download.saveAs(file);report('browser_download_current_review_word',{file});
  await page.locator('[data-step="3"]').click();await page.locator('[data-paragraph-index="0:0"]').click();
  await page.locator('[data-panel="evidence"]').click();assert.match(await page.locator('#inspector-body').innerText(),/Attapulgite nanorods/);
  const body=await page.locator('body').innerText();for(const field of ['human_curated','realtime_research','claimId','sourceId','sourceOrigin','review_required','Bridge','HTTP 504','浏览器验收','人工编辑验收'])assert.equal(body.includes(field),false,field);
  report('paragraph_evidence_and_reader_ui');
  await page.screenshot({path:join(output,'writing-desktop.png'),fullPage:true});
  await page.setViewportSize({width:485,height:731});await page.screenshot({path:join(output,'writing-mobile.png'),fullPage:true});report('mobile_render_captured');
  assert.deepEqual(errors,[]);report('no_browser_script_errors');
} finally {await writeFile(join(output,'browser-checks.json'),JSON.stringify({kind:'agent_browser_automation',notUserAcceptance:true,results,errors},null,2));await browser.close();}
