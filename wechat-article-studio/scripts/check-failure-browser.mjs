// Isolated real-browser regression. Network faults below are explicitly injected,
// never recorded as real provider research/writing success.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from '../src/lib/primitives.mjs';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const data=resolve(process.env.WECHAT_STUDIO_DATA_DIR??'');
assert.ok(data.startsWith(join(root,'data','acceptance-')));
const origin='http://127.0.0.1:43210';
assert.equal((await(await fetch(origin+'/api/health')).json()).workspaceScope,sha256(data).slice(0,12));
const original=(await(await fetch(origin+'/api/workspace/c762920e-6923-44d4-b0d4-be314bd4c041')).json()).workspace;
const output=join(root,'evaluation','acceptance-20260904');await mkdir(output,{recursive:true});
const modulePath=join(process.env.USERPROFILE,'.cache','codex-runtimes','codex-primary-runtime','dependencies','node','node_modules','playwright','index.mjs');
const {chromium}=await import(pathToFileURL(modulePath));
const browser=await chromium.launch({executablePath:join(process.env.ProgramFiles,'Google','Chrome','Application','chrome.exe'),headless:true});
const context=await browser.newContext({viewport:{width:1480,height:1000},acceptDownloads:true});
const page=await context.newPage(),results=[],errors=[];
page.on('pageerror',e=>errors.push(String(e)));page.on('dialog',d=>d.type()==='beforeunload'?d.accept():d.dismiss());
const report=(name,details={})=>{results.push({name,status:'passed',...details});console.log(name)};
const waitMessage=async text=>{await page.getByText(text,{exact:false}).first().waitFor({timeout:30000});};
try {
  await page.goto(origin);await page.locator('#workspace-select').selectOption(original.workspaceId);await page.locator('#open-workspace').click();await page.locator('#article-title').waitFor();
  assert.equal(await page.locator('#article-title').inputValue(),original.payload.draft.title);
  await page.locator('[data-panel="annotation"]').click();assert.match(await page.locator('#inspector-body').innerText(),/已解决/);
  await page.locator('[data-step="4"]').click();assert.equal(await page.locator('#finalize-button').isEnabled(),true);
  assert.match(await page.locator('#review-summary').innerText(),/审阅稿/);report('resolved_comment_survives_restart_automatic_pass_is_not_human_approval');
  const downloadEvent=page.waitForEvent('download');await page.locator('#review-download').click();const download=await downloadEvent;
  assert.match(download.suggestedFilename(),/审阅稿\.docx$/);await download.saveAs(join(output,download.suggestedFilename()));report('current_saved_version_word_download',{version:original.version,file:download.suggestedFilename()});
  if(!process.argv.includes('--download-only')) {
  await waitMessage('已开始下载');await page.locator('[data-step="3"]').click();
  const paragraph=page.locator('[data-paragraph-index="0:0"]'),text=await paragraph.inputValue();const edited=text+' 这一判断仍应限定在论文的测试条件内。';
  await paragraph.fill(edited);assert.match(await page.locator('#save-state').innerText(),/未保存/);
  await page.route('**/api/workspace',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'persistence_failed',message:'INJECTED INTERNAL ERROR'})}));
  await page.locator('#save-button').click();await waitMessage('保存失败');assert.equal(await paragraph.inputValue(),edited);assert.match(await page.locator('#save-state').innerText(),/未保存/);
  await page.reload();await page.locator('#article-title').waitFor();assert.equal(await page.locator('[data-paragraph-index="0:0"]').inputValue(),edited);report('injected_save_failure_preserves_edit_and_refresh_local_recovery');
  await page.unroute('**/api/workspace');await page.locator('[data-paragraph-index="0:0"]').fill(text);await page.locator('#save-button').click();await waitMessage('已保存当前文章');
  await page.locator('[data-step="1"]').click();await page.locator('#change-brief').click();
  assert.equal(await page.locator('#article-title').count(),0);assert.equal(await page.locator('#source-list .source-card').count(),0);
  await page.locator('#topic').fill('凹凸棒石电池隔膜的制造一致性与应用边界');
  const longPurpose=original.payload.brief.purpose+'\n'+('需要核对公开论文中的实验条件、制造方式与尚未验证的问题。\n'.repeat(14));
  await page.locator('#purpose').fill(longPurpose);
  await page.setViewportSize({width:485,height:731});
  const dimensions=await page.locator('#purpose').evaluate(el=>({client:el.clientHeight,scroll:el.scrollHeight,height:el.getBoundingClientRect().height}));
  assert.ok(dimensions.height>200&&dimensions.scroll<=dimensions.client+2);report('purpose_auto_grows_no_internal_scroll',dimensions);
  await page.screenshot({path:join(output,'purpose-mobile-expanded.png'),fullPage:true});await page.setViewportSize({width:1480,height:1000});
  await page.locator('#purpose').fill(original.payload.brief.purpose);
  await page.route('**/api/research/jobs',route=>route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({job:{jobId:'injected-research-failure',status:'running'}})}));
  await page.route('**/api/research/jobs/injected-research-failure',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({job:{jobId:'injected-research-failure',status:'failed',startedAt:new Date().toISOString(),message:'资料搜集未完成',error:{code:'research_timeout'}}})}));
  await page.locator('#research-button').click();await waitMessage('资料搜集未完成');
  assert.equal(await page.locator('#article-title').count(),0);assert.equal(await page.locator('#source-list .source-card').count(),0);
  // Native buttons intentionally remain clickable to explain the prerequisite;
  // aria-disabled supplies accessibility semantics, not a native disabled prop.
  for(const step of [2,3,4]) {await page.locator(`[data-step="${step}"]`).click({force:true});assert.equal(await page.locator('[data-stage="1"]').isVisible(),true);}
  report('new_topic_failed_research_no_old_content_and_step_preconditions');
  await page.unroute('**/api/research/jobs');await page.unroute('**/api/research/jobs/injected-research-failure');
  const material=JSON.parse(await readFile(join(output,'attapulgite-verified-materials.json'),'utf8'));
  const ambiguous={runs:[{...material,topic:'凹凸棒石的隔膜应用'},{...material,topic:'凹凸棒石的正极应用'}]};
  await page.locator('#verified-materials-file').setInputFiles({name:'已有研究资料.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(ambiguous))});
  await page.locator('#import-choice').waitFor();assert.equal(await page.locator('#import-choice').inputValue(),'');assert.equal(await page.locator('#confirm-import').count(),0);
  await page.locator('#import-choice').selectOption('0');await page.locator('#confirm-import').click();await waitMessage('请先确认所选资料');
  assert.equal(await page.locator('[data-stage="1"]').isVisible(),true);report('ambiguous_import_requires_selection_and_mismatch_confirmation');
  await page.locator('#confirm-topic-match').check();await page.locator('#confirm-import').click();await page.locator('[data-outline-heading="0"]').waitFor();
  for(let i=0;i<original.payload.argumentMap.points.length;i++){await page.locator(`[data-outline-heading="${i}"]`).fill(original.payload.argumentMap.points[i].heading);await page.locator(`[data-outline-thesis="${i}"]`).fill(original.payload.argumentMap.points[i].thesis);}
  await page.locator('#confirm-outline').click();await page.locator('#generate-draft').waitFor();
  await page.route('**/api/research/*/draft',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'writer_failed',message:'Bridge HTTP 504 provider failed'})}));
  await page.locator('#generate-draft').click();await waitMessage('初稿生成失败');assert.equal(await page.locator('#article-title').count(),0);assert.equal(await page.locator('#generate-draft').isEnabled(),true);
  report('injected_writer_failure_no_sample_fallback_and_retry_available');await page.unroute('**/api/research/*/draft');
  await page.locator('#save-button').click();await waitMessage('已保存当前文章');
  await page.locator('#workspace-select').selectOption(original.workspaceId);await page.locator('#open-workspace').click();await page.locator('#article-title').waitFor();
  assert.equal(await page.locator('#topic').inputValue(),original.payload.brief.topic);assert.match(await page.locator('#top-topic').innerText(),/凹凸棒石在新能源领域/);assert.equal(await page.locator('[data-paragraph-index="0:0"]').inputValue(),text);
  report('saved_workspace_switch_restores_topic_outline_evidence_article_together');
  const body=await page.locator('body').innerText();for(const token of ['human_curated','realtime_research','claimId','sourceId','sourceOrigin','review_required','Bridge','HTTP 504','浏览器验收','人工编辑验收','INJECTED'])assert.equal(body.includes(token),false,token);
  await page.screenshot({path:join(output,'writing-desktop-current.png'),fullPage:true});
  await page.setViewportSize({width:485,height:731});await page.screenshot({path:join(output,'writing-mobile-current.png'),fullPage:true});
  assert.deepEqual(errors,[]);report('reader_ui_clean_no_script_errors');
  }
} catch(error) {errors.push(String(error));console.error(error);await page.screenshot({path:join(output,'failure-debug.png'),fullPage:true}).catch(()=>{});throw error;}
finally {await writeFile(join(output,process.argv.includes('--download-only')?'browser-download-current.json':'browser-failure-checks.json'),JSON.stringify({kind:'agent_browser_automation',networkFaults:process.argv.includes('--download-only')?'none':'explicitly_injected',notUserAcceptance:true,results,errors},null,2));await browser.close();}
