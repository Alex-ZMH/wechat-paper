const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const copy = value => structuredClone(value);
const labels = ['选题与要求','资料与大纲','写作与批注','检查与下载'];
const fresh = (brief = {}) => ({ workspaceId: crypto.randomUUID(), version: 0, step: 1, payload: {brief:{topic:'',audience:'',purpose:'',tone:'清晰、克制、可信',targetLength:3500,...brief}}, sessionId:null, mode:'unknown', annotationHistory:[], revisionHistory:[], resolvedAnnotationIds:[], selectedParagraphId:null, panel:'evidence', dirty:false, jobId:null, researchFailed:false });
let state = fresh(), scope = '', busy = '', epoch = 0, editSequence = 0, importChoices = [];
let localSaveError = false;
const scopeHintKey = 'article-studio-v2:last-scope';
const scopedKey = value => value ? `article-studio-v2:${value}` : '';
const paragraphs = () => state.payload.draft?.sections.flatMap(s => s.paragraphs) ?? [];
const currentParagraph = () => paragraphs().find(p => p.paragraphId === state.selectedParagraphId);
const key = () => scopedKey(scope);
function message(text, error=false) { $('top-status').textContent=text; $('top-status').style.color=error?'var(--danger)':''; }
function autoGrow(el) { el.style.height='auto'; el.style.height=`${Math.max(el.scrollHeight, parseFloat(getComputedStyle(el).minHeight)||0)}px`; }
function growAll() { document.querySelectorAll('textarea').forEach(el=>{ if(el.offsetParent) autoGrow(el); }); }
function remember() {
  // A failed health check leaves the workspace scope unknown. Never write a
  // cache entry under an empty scope, which would otherwise replace a valid
  // browser copy when initialization falls back to a blank screen.
  if(!scope||!key())return;
  try { localStorage.setItem(key(),JSON.stringify(state)); localSaveError=false; }
  catch { localSaveError=true; message('浏览器暂时无法保留草稿，请保存修改后再离开。',true); }
}
function readLocal(scopeValue=scope) {
  const storageKey=scopedKey(scopeValue);
  if(!storageKey)return null;
  try { const value=JSON.parse(localStorage.getItem(storageKey)??'null'); return value&&typeof value==='object'?value:null; }
  catch { return null; }
}
function readScopeHint() {
  try { return String(localStorage.getItem(scopeHintKey)??'').trim(); }
  catch { return ''; }
}
function writeScopeHint(value) {
  if(!value)return;
  try { localStorage.setItem(scopeHintKey,value); }
  catch { /* The article cache itself will report persistence failures. */ }
}
function readFallbackLocal() {
  const hinted=readScopeHint();
  if(hinted) {
    const local=readLocal(hinted);
    if(local)return {scopeValue:hinted,local};
  }
  try {
    const candidates=[];
    for(let i=0;i<localStorage.length;i++) {
      const storageKey=localStorage.key(i);
      if(!storageKey||storageKey===scopeHintKey||!storageKey.startsWith('article-studio-v2:'))continue;
      const candidate=readLocal(storageKey.slice('article-studio-v2:'.length));
      if(candidate)candidates.push({scopeValue:storageKey.slice('article-studio-v2:'.length),local:candidate});
    }
    candidates.sort((a,b)=>Number(Boolean(b.local.dirty))-Number(Boolean(a.local.dirty)) || Number(b.local.version??0)-Number(a.local.version??0));
    return candidates[0]??null;
  } catch { return null; }
}
function dirty() { state.dirty=true; editSequence++; remember(); updateChrome(); }
function date(value) { return value ? String(value).slice(0,10) : '日期未标明'; }
function safeUrl(value) { try { const u=new URL(value); return ['https:','http:'].includes(u.protocol)?u.href:''; } catch { return ''; } }
function modeLabel() { return state.mode==='realtime_research'?'自动搜集':state.mode==='verified_materials'?'你导入的资料':''; }
function textWithReaderCitations(value) {
  const sources=state.payload.evidencePacket?.sources??[];
  return String(value??'').replace(/\[([^\[\]]+)\]/g,(all,id)=>{const n=sources.findIndex(s=>s.sourceId===id);return n>=0?`[${n+1}]`:all;});
}
function assertReaderDraft(payload) {
  const d=payload?.draft;if(!d)return;
  const values=[d.title,d.digest,d.lead,d.closingCta,...d.sections.flatMap(s=>[s.heading,...s.paragraphs.map(p=>p.text)])];
  const control=/\b(?:human_curated|realtime_research|review_required|claimId|sourceId|sourceOrigin|EvidencePacket|ArgumentMap|WriterRequest|WechatPackage|clientRunId|allReady|research_timeout)\b|\[(?:claim|source):|HTTP\s+\d{3}|(?:浏览器人工编辑验收|人工编辑验收|浏览器批注修订)|^\s*(?:candidate|Bridge)\s*$/im;
  if(values.some(v=>control.test(v??''))) {const error=new Error('Unsafe reader content');error.code='word_export_reader_fields';throw error;}
}
function errorMessage(error, action='操作') {
  const code=error?.code??'';
  const messages={
    busy:'已有资料搜集正在进行，请等待完成或停止后再试。',
    research_timeout:'资料搜集未完成，已停止等待。你的输入已保留，可以稍后重试或导入已有资料。',
    research_upstream_timeout:'资料服务未能及时完成。你的输入已保留，请稍后重试或导入已有资料。',
    research_cancelled:'资料搜集已停止，你的输入已保留。',
    research_interrupted:'上次资料搜集因服务中断而停止，请重新开始。',
    research_audit_failed:'资料未通过来源核验，不能用于写作。请重试或导入已核验资料。',
    research_response_invalid:'收到的资料不完整，不能用于写作。请重试或更换资料。',
    research_invalid_json:'资料结果无法读取，请重试。',
    research_source_invalid:'搜集到的资料无法形成完整、可追溯的依据，不能用于写作。请调整选题后重试，或导入已有资料。',
    research_failed:'资料搜集未完成，当前没有可用于写作的结果。请稍后重试或导入已有资料。',
    research_unavailable:'资料服务暂时不可用，请稍后重试或导入已有资料。',
    invalid_request:'资料服务未能接受这次请求。你的输入已保留，请稍后重试。',
    argument_map_unconfirmed:'请先确认大纲，再生成初稿。',
    workspace_conflict:'这篇文章已有更新版本。当前修改已保留，请另存一篇或重新打开文章比较。',
    persistence_failed:'保存失败，当前修改已保留。请重试保存，不要关闭页面。',
    topic_mismatch:'资料选题与当前选题不同，请先确认是否适用。',
    import_selection_required:'文件包含多份资料，请明确选择一份。',
    import_topic_confirmation_required:'请确认所选资料适用于当前选题。',
    word_export_reader_fields:'文章的引用或内容标记需要检查，当前内容已保留，不能直接交付。',
     research_upstream_504:'资料服务未能及时完成。你的输入已保留，请稍后重试或导入已有资料。',
     research_transport_error:'资料服务连接中断，输入已保留。请稍后重试。',
     research_incomplete:'资料搜集尚不完整，不能用于写作。请重试或导入已有资料。',
     research_unverified:'资料未通过来源核验，不能用于写作。请重试或导入已核验资料。',
     research_insufficient_evidence:'资料中的证据不足，暂时不能用于写作。请补充可靠来源或调整选题后重试。',
     research_source_unreachable:'部分来源暂时无法访问，无法完成资料核对。请检查链接或稍后重试。',
     research_excerpt_mismatch:'有来源摘录未能在原文中核对，请重试或导入已核验资料。',
     research_source_unsupported:'当前来源类型暂不支持核验，请更换为可访问、可追溯的可靠来源。',
     verified_materials_invalid:'资料缺少完整的来源或观点信息，不能用于写作。请检查所选文件。',
    verified_materials_selection_required:'请选择一份与当前文章匹配的资料。',
    topic_mismatch_confirmation_required:'请先确认所选资料适用于当前选题。',
    argument_map_incomplete:'大纲仍有待编辑内容，请为每节填写标题和要说明的观点。',
    finalization_blocked:'当前文章仍有未处理问题，不能定稿。请查看审查和批注。',
    writer_unavailable:'写作服务暂时不可用，资料与大纲已保留，请稍后重试。',
    writer_timeout:'初稿未在等待时间内完成，资料与大纲已保留。请稍后重试。',
    writer_failed:'初稿生成失败，资料与大纲已保留。请稍后重试。',
    writer_provider_mismatch:'写作服务暂时无法使用，资料与大纲已保留。',
     writer_response_invalid:'生成的初稿结构不完整，未载入文章。请重试。',
     writer_paragraph_unbound:'部分正文缺少依据，未载入文章。请检查大纲和资料后重试。',
     writer_claim_uncovered:'初稿遗漏了已确认的论点，未载入文章。请重试。',
     missing_claim:'部分段落无法对应已确认论点，请检查资料与大纲。',
     lineage_mismatch:'文章与所选资料不匹配，请重新打开对应文章。',
     content_review_failed:'文章内容复核未完成，当前内容已保留。请稍后重试。',
     content_review_required:'文章仍需完成内容复核，请先重新核对当前文章。',
   };
   return messages[code]??`${action}未完成，当前内容已保留。请稍后重试。`;
 }
 async function request(url, data, method=data===undefined?'GET':'POST') {
  const response=await fetch(url,{method,signal:AbortSignal.timeout(url.endsWith('/draft')||url.endsWith('/source-check')||url==='/api/workspace/review'?210000:30000),headers:data===undefined?{}:{'content-type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});
  const result=await response.json();
  if(!response.ok) { const e=new Error('Request failed');e.code=result.error;throw e; }
  return result;
}
const openHigh = () => state.annotationHistory.some(a=>a.priority==='high'&&a.status!=='resolved');
function blocked(step) {
  if(step===2&&!state.payload.evidencePacket) return '请先完成资料获取';
  if(step===3&&!state.payload.argumentMap) return '请先获取资料和大纲';
  if(step===4&&!state.payload.draft) return '请先生成文章';
  return '';
}
function updateChrome() {
  $('top-step').textContent=`第 ${state.step} 步：${labels[state.step-1]}`;
  $('top-topic').textContent=state.payload.brief?.topic?` · ${state.payload.brief.topic}`:'';
  $('save-state').textContent=state.dirty?'有未保存修改':state.version?'已保存':'尚未保存';
  document.querySelectorAll('[data-step]').forEach(b=>{
    const step=Number(b.dataset.step), reason=blocked(step);
    b.classList.toggle('active',step===state.step); b.classList.toggle('blocked',Boolean(reason));
    b.querySelector('.step-reason').textContent=reason; b.setAttribute('aria-disabled',String(Boolean(reason)));
  });
  const draft=state.payload.draft, locked=Boolean(state.sessionId), doing=Boolean(busy);
  $('save-button').disabled=doing||!state.dirty; $('save-button').title=doing?'请等待当前操作完成':!state.dirty?'当前没有未保存修改':'';
  const downloadReason=!draft?'当前没有可下载文章':doing?'请等待当前操作完成':'';
  for(const id of ['download-button','review-download']){ $(id).disabled=Boolean(downloadReason);$(id).title=downloadReason; }
  const busyNames={restore:'正在恢复工作区',open:'正在打开文章',writer:'正在生成初稿',research:'正在搜集资料',cancelling:'正在停止搜集',save:'正在保存',review:'正在检查文章',sources:'正在检查来源',import:'正在导入资料',outline:'正在采用大纲',download:'正在准备 Word'};
  $('top-action-reason').textContent=doing?`${busyNames[busy]??'正在处理'}，请稍候。`:downloadReason||(!state.dirty?'当前没有未保存修改。':'');
  $('research-button').disabled=doing||locked;
  $('research-button').textContent=state.jobId&&!doing?'继续查看资料':state.researchFailed?'重试实时研究':'开始查资料';
  $('research-reason').textContent=locked?'已获取资料。修改选题请使用“修改选题与要求”。':busy==='research'?'研究在服务后台运行；关闭浏览器不会停止任务。':doing?'当前操作正在进行，请稍候。':'';
  ['topic','audience','purpose','tone','targetLength'].forEach(id=>$(id).readOnly=locked||Boolean(state.jobId)||doing);
  $('outline-editor').querySelectorAll('input,textarea').forEach(el=>el.readOnly=doing||Boolean(draft));
  $('outline-editor').querySelectorAll('[data-outline-up],[data-outline-down],[data-outline-delete],#add-outline-section').forEach(el=>el.disabled=doing||Boolean(draft));
  $('article-editor').querySelectorAll('input,textarea').forEach(el=>el.readOnly=doing);
  $('brief-lock').classList.toggle('hidden',!locked);
  $('cancel-research').classList.toggle('hidden',!state.jobId||!['research','cancelling'].includes(busy));
  $('cancel-research').disabled=busy==='cancelling';
  $('verified-materials-button').disabled=doing||locked;
  $('check-sources').disabled=doing||!state.sessionId;
  $('new-article').disabled=doing; $('open-workspace').disabled=doing;
  $('change-brief').disabled=doing;
  $('confirm-outline').disabled=doing||Boolean(draft);
  $('outline-reason').textContent=draft?'文章已生成；大纲保留为本稿依据。要改变研究方向，请另写一篇。':'';
  $('generate-draft').disabled=doing||Boolean(draft)||Boolean(blocked(3));
  $('writer-actions').classList.toggle('hidden',Boolean(draft));
  $('review-article').disabled=doing||!draft; $('rerun-review').disabled=doing||!draft;
  // Keep the reason visible even when there is no article or the global download is disabled.
  $('download-button').setAttribute('aria-label',downloadReason?`下载 Word：${downloadReason}`:'下载 Word');
}
function stepTo(n,{persist=true}={}) {
  const reason=blocked(n);if(reason){message(reason);return;}
  state.step=n; document.querySelectorAll('[data-stage]').forEach(el=>el.classList.toggle('active',Number(el.dataset.stage)===n));
  updateChrome();renderInspector();growAll();if(persist)remember();
}
function renderBrief() { for(const id of ['topic','audience','purpose','tone','targetLength']) $(id).value=state.payload.brief?.[id]??''; }
function sourceCard(source,index) {
  const url=safeUrl(source.url??source.link??source.doi);
  return `<article class="source-card"><h3>${index===undefined?'':`[${index+1}] `}${esc(source.title)}</h3><p class="source-meta">${esc([source.publisher,source.publishedAt??source.publicationDate??source.date??source.year].filter(Boolean).join(' · ')||'日期未标明')}</p><p class="source-excerpt">${esc(source.excerpt??'未提供摘录')}</p>${url?`<p><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">查看原文</a></p>`:''}</article>`;
}
function renderSources() {
  const packet=state.payload.evidencePacket;
  $('source-count').textContent=packet?`${modeLabel()} · ${packet.sources.length} 个来源`:'';
  $('source-list').innerHTML=packet?packet.sources.map(sourceCard).join(''):'';
  $('source-check-status').textContent='来源检查可选；检查失败不会撤销资料。';
}
async function checkSources() {
  if(busy||!state.sessionId)return;
  const token=epoch;busy='sources';updateChrome();$('source-check-status').textContent='正在逐条读取公开来源…';
  try {
    const {results}=await request(`/api/research/${encodeURIComponent(state.sessionId)}/source-check`,{});
    if(token!==epoch)return;
    const failures=results.filter(item=>!item.checked);
    $('source-check-status').textContent=`已检查 ${results.length} 条：${results.length-failures.length} 条原文可定位，${failures.length} 条未核实。检查结果仅供参考。`;
    $('source-list').querySelectorAll('.source-card').forEach((card,index)=>{
      const result=results[index];if(!result)return;
      const status=document.createElement('p');status.className='source-meta';
      status.textContent=result.checked?'原文摘录已定位':result.status==='summary_not_verified'?'这是整理要点，不是原文引语':result.details?.status===403?'来源拒绝访问，未核实':'来源暂无法核实；请查看原文链接';
      card.append(status);
    });
  } catch(e) { $('source-check-status').textContent='来源检查未完成，已有资料仍可用于写作。';message(errorMessage(e,'来源检查'),true); }
  finally {busy='';updateChrome();}
}
function outlineMap() {
  if(!state.payload.argumentMap)state.payload.argumentMap={status:'confirmed',points:[]};
  if(!Array.isArray(state.payload.argumentMap.points))state.payload.argumentMap.points=[];
  return state.payload.argumentMap;
}
function claimLabel(claim) {
  return String(claim?.text??claim?.summary??claim?.title??'待核对的论点').trim()||'待核对的论点';
}
function outlineChanged() {
  outlineMap().status='confirmed';
  dirty();
}
function repairOutlineOrder(points) {
  points.forEach((point,index)=>{point.order=index+1;});
}
function renderOutline() {
  const points=state.payload.argumentMap?.points??[], claims=state.payload.evidencePacket?.claims??[], locked=Boolean(state.payload.draft);
  const claimOptions=(point,index)=>claims.length?`<fieldset class="claim-list" ${locked?'disabled':''}><legend>本节绑定的论点（可多选）</legend>${claims.map(claim=>{
    const claimId=String(claim?.claimId??'');
    if(!claimId)return '';
    const selected=Array.isArray(point.claimIds)&&point.claimIds.includes(claimId);
    return `<label class="claim-option" title="选择这条论点"><input type="checkbox" data-outline-index="${index}" data-outline-claim="${esc(claimId)}" aria-label="${esc(claimLabel(claim))}" ${selected?'checked':''}><span>${esc(claimLabel(claim))}</span></label>`;
  }).join('')}</fieldset>`:'<p class="field-hint">当前资料没有可供绑定的论点。</p>';
  $('outline-editor').innerHTML=`${points.map((p,i)=>`<article class="outline-card" data-outline-card="${i}"><div class="outline-card-header"><strong>章节 ${i+1}</strong><div class="outline-controls"><button type="button" class="button-quiet" data-outline-up="${i}" ${locked||i===0?'disabled':''}>上移</button><button type="button" class="button-quiet" data-outline-down="${i}" ${locked||i===points.length-1?'disabled':''}>下移</button><button type="button" class="button-quiet" data-outline-delete="${i}" ${locked||points.length<=1?'disabled':''}>删除</button></div></div><label for="outline-heading-${i}">章节标题</label><input id="outline-heading-${i}" data-outline-heading="${i}" aria-label="章节 ${i+1} 标题" value="${esc(p.heading??p.title)}" ${locked?'readonly':''}><label for="outline-thesis-${i}">本节要说明的观点</label><textarea id="outline-thesis-${i}" data-outline-thesis="${i}" ${locked?'readonly':''}>${esc(p.thesis)}</textarea>${claimOptions(p,i)}</article>`).join('')}${locked?'':'<div class="outline-toolbar"><button type="button" class="button-secondary" id="add-outline-section">新增章节</button><span class="field-hint">每节至少绑定一条论点；未选中的论点不会进入本篇。</span></div>'}`;
  $('outline-list').innerHTML=points.map((p,i)=>`<li><button data-outline-jump="${i}">${i+1}. ${esc(p.heading??p.title)}</button></li>`).join('');
  $('outline-rail').classList.toggle('hidden',!points.length);
  $('outline-editor').querySelectorAll('input,textarea').forEach(el=>el.addEventListener('input',()=>{
    const idx=Number(el.dataset.outlineHeading??el.dataset.outlineThesis), prop=el.dataset.outlineHeading!==undefined?'heading':'thesis';
    const point=state.payload.argumentMap?.points?.[idx];if(!point)return;
    point[prop]=el.value;outlineChanged();if(el.tagName==='TEXTAREA')autoGrow(el);
  }));
  $('outline-editor').querySelectorAll('[data-outline-claim]').forEach(el=>el.addEventListener('change',()=>{
    const idx=Number(el.dataset.outlineIndex), claimId=String(el.dataset.outlineClaim??''), map=outlineMap(), point=map.points[idx];
    if(!point||!claimId)return;
    point.claimIds=Array.isArray(point.claimIds)?point.claimIds.filter(Boolean):[];
    if(el.checked) {
      if(!point.claimIds.includes(claimId))point.claimIds.push(claimId);
    } else point.claimIds=point.claimIds.filter(id=>id!==claimId);
    outlineChanged();renderOutline();updateChrome();
  }));
  $('outline-editor').querySelector('#add-outline-section')?.addEventListener('click',()=>{
    if(busy||locked)return;
    const map=outlineMap();map.points.push({pointId:`point-${crypto.randomUUID()}`,order:map.points.length+1,heading:'新章节',thesis:'',claimIds:[]});
    outlineChanged();renderOutline();updateChrome();
  });
  $('outline-editor').querySelectorAll('[data-outline-delete]').forEach(button=>button.addEventListener('click',()=>{
    if(busy||locked)return;
    const index=Number(button.dataset.outlineDelete), map=outlineMap(), point=map.points[index];
    if(!point)return;
    if(map.points.length<=1){message('大纲至少保留一个章节。');return;}
    if(Array.isArray(point.claimIds)&&point.claimIds.length){message('请先把本节论点移到其他章节，再删除本节。');return;}
    map.points.splice(index,1);repairOutlineOrder(map.points);outlineChanged();renderOutline();updateChrome();
  }));
  const moveOutline=(index,direction)=>{
    if(busy||locked)return;
    const map=outlineMap(), target=index+direction;
    if(!map.points[index]||!map.points[target])return;
    [map.points[index],map.points[target]]=[map.points[target],map.points[index]];repairOutlineOrder(map.points);outlineChanged();renderOutline();updateChrome();
  };
  $('outline-editor').querySelectorAll('[data-outline-up]').forEach(button=>button.addEventListener('click',()=>moveOutline(Number(button.dataset.outlineUp),-1)));
  $('outline-editor').querySelectorAll('[data-outline-down]').forEach(button=>button.addEventListener('click',()=>moveOutline(Number(button.dataset.outlineDown),1)));
  $('outline-list').querySelectorAll('button').forEach((b,i)=>b.onclick=()=>{stepTo(state.payload.draft?3:2);if(state.payload.draft)$(`article-section-${i}`)?.scrollIntoView({block:'center',behavior:'smooth'});});
}
function renderEditor() {
  const d=state.payload.draft;
  if(!d){$('article-editor').innerHTML='<p class="inspector-empty">查看或编辑大纲后，点击“生成初稿”。</p>';return;}
  const sources=state.payload.evidencePacket.sources;
  $('article-editor').innerHTML=`<label class="field-hint" for="article-title">标题</label><textarea id="article-title" class="editor-title" data-draft-field="title">${esc(textWithReaderCitations(d.title))}</textarea><label class="field-hint" for="article-digest">摘要</label><textarea id="article-digest" class="editor-digest" data-draft-field="digest">${esc(textWithReaderCitations(d.digest))}</textarea><label class="field-hint" for="article-lead">导语</label><textarea id="article-lead" class="editor-lead" data-draft-field="lead">${esc(textWithReaderCitations(d.lead))}</textarea>${d.sections.map((s,i)=>`<section class="article-section" id="article-section-${i}"><input class="article-heading" aria-label="章节标题" data-section="${i}" value="${esc(textWithReaderCitations(s.heading))}">${s.paragraphs.map((p,j)=>`<textarea class="article-paragraph" aria-label="第 ${i+1} 节第 ${j+1} 段" data-paragraph-index="${i}:${j}">${esc(textWithReaderCitations(p.text))}</textarea>`).join('')}</section>`).join('')}<label class="field-hint" for="article-closing">结语</label><textarea id="article-closing" class="editor-closing" data-draft-field="closingCta">${esc(textWithReaderCitations(d.closingCta))}</textarea><section class="references"><h2>参考文献</h2><ol>${sources.map(s=>{const url=safeUrl(s.url);return `<li>${esc([Array.isArray(s.authors)?s.authors.join(', '):s.authors,s.title,s.publisher,s.year??s.publishedAt?.slice(0,4)].filter(Boolean).join('，'))}${url?` <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">原文链接</a>`:''}</li>`;}).join('')}</ol></section>`;
  $('article-editor').querySelectorAll('[data-draft-field]').forEach(el=>el.oninput=()=>{state.payload.draft[el.dataset.draftField]=el.value;dirty();autoGrow(el);});
  $('article-editor').querySelectorAll('[data-section]').forEach(el=>el.oninput=()=>{state.payload.draft.sections[Number(el.dataset.section)].heading=el.value;dirty();});
  $('article-editor').querySelectorAll('[data-paragraph-index]').forEach(el=>{
    const [i,j]=el.dataset.paragraphIndex.split(':').map(Number), p=state.payload.draft.sections[i].paragraphs[j];
    if(p.paragraphId===state.selectedParagraphId)el.classList.add('selected');
    el.onfocus=()=>{state.selectedParagraphId=p.paragraphId;document.querySelectorAll('.article-paragraph').forEach(e=>e.classList.toggle('selected',e===el));renderInspector();};
    el.oninput=()=>{p.text=el.value;dirty();autoGrow(el);};
  });
}
const issueLabels={structure_incomplete:'文章结构尚不完整',claim_not_used:'有大纲观点尚未写入正文',unknown_claim_reference:'有段落未能对应已确认观点',claim_without_evidence:'有观点缺少来源依据',missing_source_reference:'有引用找不到对应来源',duplicate_claim_reference:'有重复引用的观点',duplicate_paragraph:'有段落重复表达',paragraph_too_long:'有段落过长，建议拆分或精简',too_many_paragraphs:'段落数量过多，请检查结构',style_avoid_phrase:'存在不符合约定文风的措辞',unresolved_high_priority_annotation:'仍有高优先级批注未解决',content_review_required:'文章仍需完成内容复核',content_review_failed:'文章内容复核未完成',content_contradiction:'正文与资料存在可能矛盾',content_unsupported:'正文中有内容缺少资料支持',content_logic:'文章论述逻辑需要复核',content_repetition:'文章存在重复表达',content_style:'文章文风需要复核',content_readability:'文章可读性需要复核'};
const issueInternalTokens=/\b(?:source(?:Id|Origin)?|claim(?:Id)?|EvidencePacket|ArgumentMap|WriterRequest|WechatPackage|clientRunId|allReady|human_curated|realtime_research|review_required|provider|Bridge)(?:[-_:#][A-Za-z0-9_-]+)?\b|\[(?:claim|source):|HTTP\s+\d{3}/iu;
function issueText(issue) {
  const label=issueLabels[issue?.code]??'有一处内容需要复核，请检查对应段落。';
  const code=String(issue?.code??'');
  const detail=String(issue?.message??'').trim();
  // Only content-review messages are server-filtered natural-language
  // details. Structural checks may contain internal IDs or English contract
  // text, so keep those on the reader-safe label path.
  const safeDetail=code.startsWith('content_')&&detail!==code&&/[\u3400-\u9fff]/u.test(detail)&&!issueInternalTokens.test(detail)?detail:'';
  return esc(safeDetail||label);
}
function reviewHtml() {
  if(!state.payload.draft)return '<p class="inspector-empty">生成文章后再进行审查。</p>';
  const issues=state.payload.reviewReport?.issues??[];
  return `${state.dirty?'<p class="notice">当前有未保存修改，检查建议可能针对旧内容。</p>':''}${issues.map(i=>`<div class="review-item warn">${issueText(i)}</div>`).join('')}${openHigh()&&!issues.some(i=>i.code==='unresolved_high_priority_annotation')?'<div class="review-item warn">仍有高优先级批注未解决，可继续保存和下载。</div>':''}${!issues.length?'<p>暂无检查建议；你可以直接保存或下载当前文章。</p>':''}`;
}
function renderReview() {
  $('review-summary').textContent=openHigh()?'有未解决的高优先级批注；它会保留为提醒，不阻止下载。':'检查是可选建议；下载时先保存当前修改。';
  $('review-list').innerHTML=reviewHtml();
}
function renderInspector() {
  document.querySelectorAll('[data-panel]').forEach(b=>b.classList.toggle('active',b.dataset.panel===state.panel));
  if(state.panel==='review'){$('inspector-body').innerHTML=`<h2>当前审查</h2>${reviewHtml()}`;return;}
  const p=currentParagraph();
  if(state.panel==='evidence') {
    const packet=state.payload.evidencePacket;
    if(!p||!packet){$('inspector-body').innerHTML='<h2>段落依据</h2><p class="inspector-empty">点击正文段落，查看它使用的来源。</p>';return;}
    const ids=new Set(packet.claims.filter(c=>p.claimIds.includes(c.claimId)).flatMap(c=>c.evidenceIds));
    $('inspector-body').innerHTML=`<h2>本段来源</h2><div class="evidence-detail">${packet.sources.filter(s=>ids.has(s.sourceId)).map(s=>sourceCard(s,packet.sources.indexOf(s))).join('')}</div>`;
    return;
  }
  $('inspector-body').innerHTML=`<h2>文章批注</h2>${p?'<form id="annotation-form" class="annotation-form"><label for="annotation-text">对这段的意见</label><textarea id="annotation-text" required placeholder="写下需要修改或核实的地方"></textarea><label for="annotation-priority">优先级</label><select id="annotation-priority"><option value="normal">一般</option><option value="high">高：重要提醒</option><option value="low">低</option></select><button class="button-primary" type="submit">添加批注</button></form>':'<p class="inspector-empty">先点击正文中的一段，再添加批注。</p>'}<div class="annotation-history"><h3>已有批注</h3>${state.annotationHistory.length?state.annotationHistory.map((a,i)=>`<article class="comment"><strong>${a.priority==='high'?'高优先级 · ':''}${a.status==='resolved'?'已解决':'待处理'}</strong><p>${esc(a.instruction)}</p><button class="button-quiet" data-comment-jump="${i}">查看段落</button>${a.status!=='resolved'?`<button class="button-secondary" data-comment-resolve="${i}">标记已解决</button>`:''}</article>`).join(''):'<p>尚无批注。</p>'}</div>`;
  $('annotation-form')?.addEventListener('submit',event=>{event.preventDefault();const paragraph=currentParagraph();if(!paragraph)return;state.annotationHistory.push({annotationId:crypto.randomUUID(),kind:'replace_paragraph',targetParagraphId:paragraph.paragraphId,instruction:$('annotation-text').value.trim(),priority:$('annotation-priority').value,status:'open',replacementText:paragraph.text});dirty();renderInspector();renderReview();message('批注已添加，请保存修改。');});
  $('inspector-body').querySelectorAll('[data-comment-resolve]').forEach(b=>b.onclick=()=>{const a=state.annotationHistory[Number(b.dataset.commentResolve)];a.status='resolved';state.resolvedAnnotationIds.push(a.annotationId);dirty();renderInspector();renderReview();message('批注已标记解决，请保存修改。');});
  $('inspector-body').querySelectorAll('[data-comment-jump]').forEach(b=>b.onclick=()=>{const a=state.annotationHistory[Number(b.dataset.commentJump)];state.selectedParagraphId=a.targetParagraphId;stepTo(3);const index=paragraphs().findIndex(p=>p.paragraphId===a.targetParagraphId);$('article-editor').querySelectorAll('.article-paragraph')[index]?.focus();});
  growAll();
}
function render({persist=true}={}) { renderBrief();renderSources();renderOutline();renderEditor();renderReview();stepTo(state.step,{persist});updateChrome();growAll(); }
function saveBody() { return {workspaceId:state.workspaceId,baseVersion:state.version,sessionId:state.sessionId,mode:state.mode,payload:copy(state.payload),annotationHistory:copy(state.annotationHistory),revisionHistory:copy(state.revisionHistory),resolvedAnnotationIds:[...state.resolvedAnnotationIds]}; }
function adopt(workspace) {
  assertReaderDraft(workspace.payload);
  state={...fresh(),...workspace,workspaceId:workspace.workspaceId,version:workspace.version??0,sessionId:workspace.sessionId??null,dirty:false,resolvedAnnotationIds:[],step:workspace.payload.draft?3:workspace.payload.evidencePacket?2:1};
  state.payload=copy(workspace.payload);state.annotationHistory=copy(workspace.annotationHistory??[]);state.revisionHistory=copy(workspace.revisionHistory??[]);
  epoch++;remember();render();
}
function workspaceStep(workspace) {
  return workspace?.payload?.draft?3:workspace?.payload?.evidencePacket?2:1;
}
function restoreBrowserCopy(local,{markUnsaved=false,newWorkspace=false}={}) {
  if(!local?.workspaceId||!local?.payload||typeof local.payload!=='object')return false;
  assertReaderDraft(local.payload);
  const preserved=copy(local);
  state={...fresh(),...preserved};
  state.workspaceId=newWorkspace?crypto.randomUUID():preserved.workspaceId;
  state.version=newWorkspace?0:Number(preserved.version??0);
  state.payload=copy(preserved.payload);
  state.annotationHistory=copy(preserved.annotationHistory??[]);
  state.revisionHistory=copy(preserved.revisionHistory??[]);
  state.resolvedAnnotationIds=copy(preserved.resolvedAnnotationIds??[]);
  state.step=Number.isInteger(preserved.step)&&preserved.step>=1&&preserved.step<=4?preserved.step:workspaceStep(state);
  state.dirty=Boolean(preserved.dirty||markUnsaved||newWorkspace);
  epoch++;editSequence=0;render();
  return true;
}
function renderFreshWithoutPersist() {
  state=fresh();
  render({persist:false});
}
async function refreshList() {
  try {const data=await request('/api/workspaces');const items=data.workspaces??[];$('workspace-select').innerHTML='<option value="">选择文章</option>'+items.map(w=>`<option value="${esc(w.workspaceId)}">${esc(w.title??w.topic??w.payload?.brief?.topic??'未命名文章')}${w.legacy||w.legacyFlag||w.quarantined?'（早期保存，需检查）':''}</option>`).join('');}catch{ /* Existing content remains usable during a temporary listing error. */ }
}
async function saveChanges() {
  if(busy){message('请等待当前操作完成。');return false;}
  if(!$('brief-form').reportValidity()) { stepTo(1);return false; }
  const token=epoch, sequence=editSequence, data=saveBody();busy='save';updateChrome();
  try {
    const result=await request('/api/workspace',data);if(token!==epoch)return false;
    const previousStep=state.step;
    if(sequence===editSequence){adopt(result.workspace);state.step=previousStep;stepTo(previousStep);} else {state.version=result.workspace.version;remember();}
    message(sequence===editSequence?'已保存当前文章和批注。':'上一版已保存；新修改仍未保存。');await refreshList();return sequence===editSequence;
  } catch(e){message(errorMessage(e,'保存'),true);remember();return false;}
  finally {busy='';updateChrome();}
}
async function preserveBeforeLeaving() { return !state.dirty || await saveChanges(); }
async function newArticle(withRequirements=false) {
  if(busy)return;
  if(!await preserveBeforeLeaving())return;
  const brief=withRequirements?copy(state.payload.brief):{};
  state=fresh(brief);epoch++;editSequence=0;remember();render();message(withRequirements?'原文章已保留。请修改这篇新文章的要求。':'已新建文章。');
}
async function openWorkspace() {
  if(busy)return;
  const id=$('workspace-select').value;if(!id){message('请先选择一篇已保存文章。');return;}
  if(!await preserveBeforeLeaving())return;
  const token=epoch,sequence=editSequence;busy='open';updateChrome();
  try {const result=await request(`/api/workspace/${encodeURIComponent(id)}`);if(token!==epoch||sequence!==editSequence){message('当前修改已保留，请保存后重新打开所选文章。');return;}const w=result.workspace;if(w.legacy||w.legacyFlag||w.quarantined){message('这是一篇早期保存的文章，可能包含旧的操作记录。原文件已保留，请先检查再使用。');return;}adopt(w);message('已恢复所选文章、资料和批注。');}catch(e){message(errorMessage(e,'打开文章'),true);}finally{busy='';updateChrome();}
}
async function pollResearch(id,token) {
  busy='research';state.jobId=id;remember();updateChrome();
  try {
    while(token===epoch&&state.jobId===id){
      const response=await request(`/api/research/jobs/${encodeURIComponent(id)}`);
      const job=response.job??response;
      if(token!==epoch)return;
      const seconds=Math.max(0,Math.round((Date.now()-Date.parse(job.startedAt))/1000));
      $('global-status').textContent=`${job.message} · 已等待 ${Math.floor(seconds/60)} 分 ${seconds%60} 秒`;
      if(job.status==='completed') {
        const record=job.record;
        const expected=state.payload.brief;
        if(job.workspaceId!==state.workspaceId||['topic','purpose','audience','tone','targetLength'].some(k=>String(record?.brief?.[k]??'')!==String(expected[k]??''))){state.jobId=null;remember();message('收到的资料与当前选题不一致，未载入文章。请重新查资料。',true);return;}
        const sessionId=record.researchSession.sessionId;
        const outlined=await request(`/api/research/${encodeURIComponent(sessionId)}/argument-map`);
        if(token!==epoch)return;state.sessionId=sessionId;state.mode='realtime_research';state.researchFailed=false;state.payload=copy(outlined);state.jobId=null;dirty();render();stepTo(2);message('资料已整理，可查看来源并直接使用当前大纲。');return;
      }
      if(['failed','cancelled'].includes(job.status)){state.jobId=null;state.researchFailed=true;message(job.status==='cancelled'?'资料搜集已停止，你的输入已保留。':errorMessage(job.error,'资料搜集'),true);$('global-status').textContent=$('top-status').textContent;remember();return;}
      await new Promise(resolve=>setTimeout(resolve,1500));
    }
  } catch(e){state.researchFailed=true;if(e.code==='research_job_not_found'){state.jobId=null;remember();message('上次资料任务无法恢复，输入已保留。请重试实时研究。',true);}else message('暂时无法读取资料进度或大纲。输入已保留，请点击“继续查看资料”重试。',true);remember();}
  finally {if(token===epoch){busy='';updateChrome();}}
}
async function startResearch(event) {
  event?.preventDefault();if(busy||state.sessionId)return;if(!$('brief-form').reportValidity())return;
  if(state.jobId){await pollResearch(state.jobId,epoch);return;}
  const token=epoch;busy='research';updateChrome();$('global-status').textContent='正在提交资料搜集任务…';
  try {const job=await request('/api/research/jobs',{brief:state.payload.brief,workspaceId:state.workspaceId});const id=job.jobId??job.job?.jobId;if(!id)throw new Error('Missing job');if(token===epoch)await pollResearch(id,token);}
  catch(e){state.researchFailed=true;message(errorMessage(e,'资料搜集'),true);$('global-status').textContent=$('top-status').textContent;remember();}
  finally {if(token===epoch){busy='';updateChrome();}}
}
async function cancelResearch() {if(!state.jobId)return;busy='cancelling';updateChrome();try{await request(`/api/research/jobs/${state.jobId}/cancel`,{});message('正在停止资料搜集，请稍候。');}catch{busy='research';message('停止请求未能发送，请稍后重试。',true);updateChrome();}}
function importEntries(input) {
  const entries=Array.isArray(input.runs)?input.runs:Array.isArray(input)?input:[input];
  return entries.map((entry,index)=>{const packet=copy(entry.evidencePacket??entry.evidence??entry.packet??entry);if(Array.isArray(packet.sources))packet.sources=packet.sources.map(s=>({...s,url:s.url??s.link??(s.doi?.startsWith('10.')?`https://doi.org/${s.doi}`:s.doi)}));return {index,topic:entry.brief?.topic??entry.topic??entry.evidencePacket?.topic??'',packet};});
}
function previewImport(index) {
  const chosen=importChoices[index], panel=$('import-preview');if(!chosen)return;
  const sources=chosen.packet?.sources,claims=chosen.packet?.claims;
  if(!Array.isArray(sources)||!sources.length||!Array.isArray(claims)||!claims.length){$('import-detail').innerHTML='<p>这份文件缺少来源或观点，不能用于写作。请选择含有完整研究资料的文件。</p>';return;}
  const missing=sources.some(s=>!s.title||!safeUrl(s.url)||!(s.excerpt??s.quote??s.summary));
  const mismatch=!chosen.topic||chosen.topic.trim()!==state.payload.brief.topic.trim();
  $('import-detail').innerHTML=`<p>${sources.length} 个来源，${claims.length} 个观点。</p>${missing?'<p>有来源缺少标题、链接或摘录，请补齐资料后重新导入。</p>':''}${sources.map(sourceCard).join('')}${mismatch?'<p class="notice">这份资料的选题与当前选题不同，或未标明选题。请先确认它确实适用。</p><label><input id="confirm-topic-match" type="checkbox" style="width:auto"> 我已核对，这份资料适用于当前文章</label>':''}<div class="actions"><button id="confirm-import" class="button-primary" type="button" ${missing?'disabled':''}>使用所选资料</button></div>`;
  $('confirm-import').onclick=()=>useImport(chosen,mismatch);
  panel.classList.remove('hidden');
}
async function readImport(file) {
  if(!file)return;if(!$('brief-form').reportValidity())return;
  try {importChoices=importEntries(JSON.parse(await file.text()));$('import-preview').innerHTML=`<label for="import-choice">选择资料</label><select id="import-choice"><option value="">请选择一份资料</option>${importChoices.map((c,i)=>`<option value="${i}">${esc(c.topic||`未标明选题的资料 ${i+1}`)}</option>`).join('')}</select><div id="import-detail"></div>`;$('import-preview').classList.remove('hidden');$('import-choice').onchange=e=>e.target.value!==''?previewImport(Number(e.target.value)):$('import-detail').replaceChildren();const matches=importChoices.filter(c=>c.topic.trim()===state.payload.brief.topic.trim());if(matches.length===1){$('import-choice').value=String(matches[0].index);previewImport(matches[0].index);}message('请查看所选资料，确认后再导入。');}
  catch{$('verified-materials-status').textContent='无法读取这个资料文件。请导入含来源和观点的研究资料文件。';}
}
async function useImport(chosen,mismatch) {
  if(busy||state.sessionId)return;if(mismatch&&!$('confirm-topic-match')?.checked){message('请先确认所选资料适用于当前选题。');return;}
  const token=epoch;busy='import';updateChrome();
  try {const result=await request('/api/research/verified',{brief:state.payload.brief,evidencePacket:chosen.packet,materialTopic:chosen.topic,confirmTopicMismatch:mismatch});const sessionId=result.researchSession.sessionId;const outlined=await request(`/api/research/${encodeURIComponent(sessionId)}/argument-map`);if(token!==epoch)return;state.sessionId=sessionId;state.mode='verified_materials';state.payload=copy(outlined);dirty();render();stepTo(2);message('已采用你导入的资料，可查看来源并直接使用当前大纲。');}
  catch(e){message(errorMessage(e,'导入资料'),true);}
  finally{busy='';updateChrome();}
}
function outlineValidation() {
  const points=state.payload.argumentMap?.points??[], claims=new Set((state.payload.evidencePacket?.claims??[]).map(claim=>String(claim?.claimId??'')));
  if(!points.length)return '大纲至少需要一个章节。';
  for(const [index,point] of points.entries()) {
    if(!String(point?.heading??'').trim())return `请填写第 ${index+1} 节标题。`;
    if(!String(point?.thesis??'').trim())return `请填写第 ${index+1} 节要说明的观点。`;
    const ids=Array.isArray(point?.claimIds)?point.claimIds.filter(Boolean):[];
    if(!ids.length)return `请为第 ${index+1} 节至少绑定一条论点。`;
    for(const id of ids) {
      if(!claims.has(String(id)))return `第 ${index+1} 节包含无法识别的论点，请重新选择。`;
    }
  }
  return '';
}
async function confirmOutline() {
  if(busy||state.payload.draft||!state.sessionId)return;
  const invalid=outlineValidation();if(invalid){message(invalid,true);return;}
  busy='outline';updateChrome();
  try {const result=await request(`/api/research/${encodeURIComponent(state.sessionId)}/argument-map`,{points:state.payload.argumentMap.points});state.payload=copy(result);dirty();render();stepTo(3);message('大纲已确认，可以生成初稿。');}catch(e){message(errorMessage(e,'确认大纲'),true);}finally{busy='';updateChrome();}
}
async function generateDraft() {
  if(busy||state.payload.draft||blocked(3))return;const invalid=outlineValidation();if(invalid){message(invalid,true);return;}const token=epoch;busy='writer';updateChrome();$('writer-status').textContent='正在根据当前资料和大纲生成初稿，请稍候。';
  try {const result=await request(`/api/research/${encodeURIComponent(state.sessionId)}/draft`,{argumentMap:state.payload.argumentMap});if(token!==epoch)return;assertReaderDraft(result);state.payload=copy(result);state.revisionHistory.push({draftHash:result.draft.draftHash,draft:copy(result.draft),savedAt:new Date().toISOString()});state.selectedParagraphId=paragraphs()[0]?.paragraphId??null;dirty();render();stepTo(3);message('初稿已生成，尚未保存。请阅读并修改。');}
  catch(e){message(errorMessage(e,'生成初稿'),true);$('writer-status').textContent=$('top-status').textContent;}
  finally {busy='';updateChrome();}
}
async function runReview() {
  if(busy||!state.payload.draft)return;busy='review';$('global-status').textContent='正在核对文章与来源，请稍候';updateChrome();const sequence=editSequence;
  try {const result=await request('/api/workspace/review',saveBody());if(sequence===editSequence){state.payload=copy(result.payload);state.annotationHistory=copy(result.annotationHistory??state.annotationHistory);renderEditor();dirty();renderReview();stepTo(4);message('已完成内容复核，请查看问题并保存当前版本。');}else message('复核期间内容有变化，请再次核对当前版本。');}
  catch(e){message(errorMessage(e,'审查'),true);}finally{$('global-status').textContent=$('top-status').textContent;busy='';updateChrome();}
}
async function downloadWord() {
  if(busy||!state.payload.draft){message('当前没有可下载文章。');return;}
  if((state.dirty||!state.version)&&!await saveChanges())return;
  const token=epoch, sequence=editSequence, version=state.version;
  busy='download';updateChrome();
  try {const response=await fetch('/api/export/word',{method:'POST',signal:AbortSignal.timeout(135000),headers:{'content-type':'application/json'},body:JSON.stringify({workspaceId:state.workspaceId,version})});if(!response.ok){const r=await response.json();const e=new Error();e.code=r.error;throw e;}const buffer=await response.blob();if(token!==epoch||sequence!==editSequence||state.dirty){message('下载期间文章发生变化，请再次下载当前版本。',true);return;}const filename=response.headers.get('content-disposition')?.match(/filename\*=UTF-8''([^;]+)/)?.[1];const url=URL.createObjectURL(buffer);const link=document.createElement('a');link.href=url;link.download=filename?decodeURIComponent(filename):'文章.docx';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);message('已开始下载当前保存版本的 Word。');}
  catch(e){message(errorMessage(e,'下载'),true);}finally{busy='';updateChrome();}
}
document.querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>stepTo(Number(b.dataset.step)));
document.querySelectorAll('[data-panel]').forEach(b=>b.onclick=()=>{state.panel=b.dataset.panel;renderInspector();});
['topic','audience','purpose','tone','targetLength'].forEach(id=>$(id).oninput=()=>{state.payload.brief[id]=id==='targetLength'?Number($(id).value):$(id).value;dirty();if(id==='purpose')autoGrow($(id));});
$('brief-form').onsubmit=startResearch;
$('cancel-research').onclick=cancelResearch;
$('new-article').onclick=()=>newArticle();$('change-brief').onclick=()=>newArticle(true);
$('open-workspace').onclick=openWorkspace;
$('verified-materials-button').onclick=()=>{if($('brief-form').reportValidity()){$('verified-materials-file').value='';$('verified-materials-file').click();}};
$('check-sources').onclick=checkSources;
$('verified-materials-file').onchange=e=>readImport(e.target.files[0]);
$('confirm-outline').onclick=confirmOutline;$('generate-draft').onclick=generateDraft;
$('back-to-brief').onclick=()=>stepTo(1);$('back-to-outline').onclick=()=>stepTo(2);$('back-to-writing').onclick=()=>stepTo(3);
$('review-article').onclick=runReview;$('rerun-review').onclick=runReview;
$('save-button').onclick=saveChanges;$('download-button').onclick=downloadWord;$('review-download').onclick=downloadWord;
window.addEventListener('beforeunload',event=>{remember();if(state.dirty||localSaveError){event.preventDefault();event.returnValue='';}});
window.addEventListener('resize',growAll);
async function initialize() {
  busy='restore';updateChrome();
  try {
    const health=await request('/api/health');
    const healthScope=String(health.workspaceScope??'').trim();
    if(!healthScope)throw Object.assign(new Error('Workspace scope unavailable'),{code:'workspace_scope_unavailable'});
    scope=healthScope;writeScopeHint(scope);
    const local=readLocal();
    let restored=false;
    if(local?.workspaceId&&local?.payload) {
      try {
        assertReaderDraft(local.payload);
        if(local.version&&!local.dirty&&!local.jobId) {
          try {
            const saved=(await request(`/api/workspace/${encodeURIComponent(local.workspaceId)}`)).workspace;
            if(!saved)throw Object.assign(new Error('Workspace not found'),{code:'workspace_not_found'});
            adopt(saved);restored=true;
          } catch(error) {
            if(error?.code==='workspace_not_found') {
              // Keep the browser copy, but give it a new identity so the next
              // save creates a separate workspace instead of overwriting a
              // different server-side article.
              restoreBrowserCopy(local,{markUnsaved:true,newWorkspace:true});
              message('服务器已找不到原文章，内容已另存为新的未保存工作区。请重试保存。',true);
            } else {
              restoreBrowserCopy(local,{markUnsaved:true});
              message('暂时无法核对已保存文章，已保留浏览器副本并标记为未保存。请稍后重试。',true);
            }
            restored=true;
          }
        } else {
          restoreBrowserCopy(local);restored=true;
          if(local.dirty)message('已恢复浏览器保留的修改；仍需点击保存。');
        }
      } catch {
        // Ignore a malformed browser copy and fall through to the server's
        // latest valid workspace. A valid copy is never replaced by this path.
      }
    }
    if(!restored) {
      try {
        const latest=(await request('/api/workspace/latest')).workspace;
        if(latest&&!latest.legacy&&!latest.legacyFlag&&!latest.quarantined)adopt(latest);
        else render();
      } catch {
        // No browser copy exists, so there is no content to protect. Avoid
        // persisting a fresh placeholder while the server is unavailable.
        renderFreshWithoutPersist();
        message('暂时无法读取最近文章，当前输入会保留在浏览器。请确认服务已启动后重试。',true);
      }
    }
    await refreshList();
  } catch {
    // Health failed before a scope was available. Reuse the last known scoped
    // browser copy when possible, but never write article-studio-v2: (empty).
    const fallback=readFallbackLocal();
    if(fallback) {
      scope=fallback.scopeValue;
      try {
        if(restoreBrowserCopy(fallback.local,{markUnsaved:true}))message('暂时无法连接工作台，已保留浏览器副本并标记为未保存。服务恢复后可重试保存。',true);
        else {renderFreshWithoutPersist();message('暂时无法连接工作台，请确认服务已启动后重试。',true);}
      } catch {renderFreshWithoutPersist();message('暂时无法连接工作台，请确认服务已启动后重试。',true);}
    } else {
      renderFreshWithoutPersist();
      message('暂时无法连接工作台，当前输入会保留在浏览器。请确认服务已启动后重试。',true);
    }
  }
  finally{busy='';updateChrome();}
  if(state.jobId)void pollResearch(state.jobId,epoch);
}
void initialize();
