import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this._innerHTML = '';
    this._paragraphControls = null;
    this.style = {};
    this.listeners = {};
    const classes = new Set();
    this.classList = {
      toggle(name, force) {
        if (force === undefined ? !classes.has(name) : force) classes.add(name);
        else classes.delete(name);
      },
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    };
  }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) { this._innerHTML = String(value ?? ''); this._paragraphControls = null; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  querySelectorAll(selector) {
    if (this.id !== 'article-editor' || !['[data-paragraph-index]', '.article-paragraph'].includes(selector)) return [];
    if (!this._paragraphControls) {
      this._paragraphControls = [];
      const pattern = /<textarea\b[^>]*data-paragraph-index="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g;
      let match;
      while ((match = pattern.exec(this._innerHTML))) {
        const classes = new Set();
        this._paragraphControls.push({
          dataset: { paragraphIndex: match[1] },
          value: match[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
          style: {},
          scrollHeight: 0,
          offsetParent: true,
          classList: {
            toggle(name, force) {
              if (force === undefined ? !classes.has(name) : force) classes.add(name);
              else classes.delete(name);
            },
            add(name) { classes.add(name); },
            remove(name) { classes.delete(name); },
            contains(name) { return classes.has(name); },
          },
        });
      }
    }
    return this._paragraphControls;
  }
  querySelector() { return null; }
  setAttribute() {}
  reportValidity() { return true; }
}

class FakeDocument {
  constructor() { this.elements = new Map(); }
  getElementById(id) {
    if (!this.elements.has(id)) this.elements.set(id, new FakeElement(id));
    return this.elements.get(id);
  }
  querySelectorAll(selector) {
    if (selector === '.article-paragraph') return this.getElementById('article-editor').querySelectorAll(selector);
    return [];
  }
  createElement() { return new FakeElement(); }
}

class FakeStorage {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries)); }
  get length() { return this.values.size; }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  key(index) { return [...this.values.keys()][index] ?? null; }
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

async function boot({ storage = {}, fetchImpl }) {
  const document = new FakeDocument();
  const localStorage = new FakeStorage(storage);
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return fetchImpl(url, options);
  };
  const context = {
    console,
    document,
    localStorage,
    fetch,
    crypto: { randomUUID },
    structuredClone,
    AbortSignal,
    URL,
    Date,
    setTimeout,
    clearTimeout,
    getComputedStyle: () => ({ minHeight: '0px' }),
    confirm: () => true,
    window: { addEventListener() {} },
  };
  vm.createContext(context);
  vm.runInContext(`${appSource}\n globalThis.__studio = { snapshot: () => structuredClone(state), getScope: () => scope, storageKey: () => key(), getElement: id => $(id), runReview, saveBody };`, context, { filename: 'public/app.js' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { context, calls, storage: localStorage, studio: context.__studio };
}

function browserCopy({ workspaceId = 'old-workspace', version = 1, dirty = false, topic = '保留主题' } = {}) {
  return {
    workspaceId,
    version,
    step: 1,
    payload: { brief: { topic, audience: '读者', purpose: '说明问题', tone: '清晰', targetLength: 1200 } },
    sessionId: null,
    mode: 'unknown',
    annotationHistory: [],
    revisionHistory: [],
    resolvedAnnotationIds: [],
    selectedParagraphId: null,
    panel: 'evidence',
    dirty,
    humanApproval: null,
    jobId: null,
    researchFailed: false,
  };
}

test('health failure restores the last scoped browser copy without writing an empty-scope cache', async () => {
  const local = browserCopy({ dirty: true });
  const result = await boot({
    storage: {
      'article-studio-v2:last-scope': 'scope-a',
      'article-studio-v2:scope-a': JSON.stringify(local),
    },
    fetchImpl: async () => { throw new Error('offline'); },
  });

  const state = result.studio.snapshot();
  assert.equal(result.studio.getScope(), 'scope-a');
  assert.equal(state.workspaceId, 'old-workspace');
  assert.equal(state.payload.brief.topic, '保留主题');
  assert.equal(state.dirty, true);
  assert.equal(result.storage.getItem('article-studio-v2:'), null);
  assert.match(result.context.document.getElementById('top-status').textContent, /保留浏览器副本/);
});

test('a missing server workspace is copied to a new unsaved workspace', async () => {
  const local = browserCopy({ workspaceId: 'gone-workspace', version: 4, topic: '不能丢失的主题' });
  const result = await boot({
    storage: {
      'article-studio-v2:last-scope': 'scope-b',
      'article-studio-v2:scope-b': JSON.stringify(local),
    },
    fetchImpl: async (url) => {
      if (url === '/api/health') return jsonResponse({ ok: true, workspaceScope: 'scope-b' });
      if (url === '/api/workspace/gone-workspace') return jsonResponse({ error: 'workspace_not_found' }, { ok: false, status: 404 });
      if (url === '/api/workspaces') return jsonResponse({ workspaces: [] });
      throw new Error(`unexpected ${url}`);
    },
  });

  const state = result.studio.snapshot();
  assert.notEqual(state.workspaceId, 'gone-workspace');
  assert.equal(state.version, 0);
  assert.equal(state.dirty, true);
  assert.equal(state.payload.brief.topic, '不能丢失的主题');
  const cached = JSON.parse(result.storage.getItem('article-studio-v2:scope-b'));
  assert.equal(cached.workspaceId, state.workspaceId);
  assert.equal(cached.version, 0);
  assert.match(result.context.document.getElementById('top-status').textContent, /另存为新的未保存工作区/);
});

test('latest workspace failure does not persist a fresh placeholder under the scoped key', async () => {
  const result = await boot({
    storage: { 'article-studio-v2:last-scope': 'scope-c' },
    fetchImpl: async (url) => {
      if (url === '/api/health') return jsonResponse({ ok: true, workspaceScope: 'scope-c' });
      if (url === '/api/workspace/latest') return jsonResponse({ error: 'temporary' }, { ok: false, status: 503 });
      throw new Error(`unexpected ${url}`);
    },
  });

  assert.equal(result.storage.getItem('article-studio-v2:scope-c'), null);
  assert.equal(result.storage.getItem('article-studio-v2:'), null);
  assert.match(result.context.document.getElementById('top-status').textContent, /读取最近文章/);
});

test('outline controls expose claim text while keeping internal claim ids out of visible copy', async () => {
  const workspace = {
    workspaceId: 'outline-workspace',
    version: 1,
    sessionId: 'research-session',
    mode: 'realtime_research',
    payload: {
      brief: { topic: '主题', audience: '读者', purpose: '说明问题', tone: '清晰', targetLength: 1200 },
      evidencePacket: { sources: [], claims: [{ claimId: 'claim-secret', text: '公开资料支持这项判断。' }] },
      argumentMap: {
        status: 'draft',
        points: [{ pointId: 'point-1', order: 1, heading: '第一节', thesis: '解释判断', claimIds: ['claim-secret'] }],
      },
    },
  };
  const result = await boot({
    fetchImpl: async (url) => {
      if (url === '/api/health') return jsonResponse({ ok: true, workspaceScope: 'scope-outline' });
      if (url === '/api/workspace/latest') return jsonResponse({ workspace });
      if (url === '/api/workspaces') return jsonResponse({ workspaces: [] });
      throw new Error(`unexpected ${url}`);
    },
  });

  const html = result.studio.getElement('outline-editor').innerHTML;
  assert.match(html, /新增章节/);
  assert.match(html, /上移/);
  assert.match(html, /删除/);
  assert.match(html, /公开资料支持这项判断。/);
  assert.doesNotMatch(html, />claim-secret[<]/);
});

test('structural review messages stay on safe labels instead of exposing internal ids', async () => {
  const workspace = {
    workspaceId: 'review-workspace',
    version: 1,
    sessionId: 'review-session',
    mode: 'realtime_research',
    payload: {
      brief: { topic: '主题', audience: '读者', purpose: '说明问题', tone: '清晰', targetLength: 1200 },
      evidencePacket: { sources: [], claims: [{ claimId: 'claim-1', text: '论点' }] },
      argumentMap: { status: 'confirmed', points: [{ pointId: 'point-1', order: 1, heading: '第一节', thesis: '解释判断', claimIds: ['claim-1'] }] },
      draft: {
        title: '标题', digest: '摘要', lead: '导语', closingCta: '结语',
        sections: [{ sectionId: 'section-1', order: 1, heading: '第一节', paragraphs: [{ paragraphId: 'paragraph-1', text: '正文', claimIds: ['claim-1'] }] }],
      },
      reviewReport: { status: 'review_required', issues: [{ code: 'missing_source_reference', message: 'sourceId=secret-source-1' }] },
    },
  };
  const result = await boot({
    fetchImpl: async (url) => {
      if (url === '/api/health') return jsonResponse({ ok: true, workspaceScope: 'scope-review' });
      if (url === '/api/workspace/latest') return jsonResponse({ workspace });
      if (url === '/api/workspaces') return jsonResponse({ workspaces: [] });
      throw new Error(`unexpected ${url}`);
    },
  });

  const review = result.studio.getElement('review-list').innerHTML;
  assert.match(review, /有引用找不到对应来源/);
  assert.doesNotMatch(review, /sourceId|secret-source-1/iu);
});

test('successful review rebinds paragraph editing and preserves the local revision snapshot', async () => {
  const workspace = {
    workspaceId: 'review-edit-workspace',
    version: 0,
    sessionId: 'review-edit-session',
    mode: 'realtime_research',
    revisionHistory: [{ draftHash: 'local-draft-snapshot', savedAt: '2026-09-22T00:00:00.000Z' }],
    payload: {
      brief: { topic: '主题', audience: '读者', purpose: '说明问题', tone: '清晰', targetLength: 1200 },
      evidencePacket: { sources: [], claims: [] },
      argumentMap: { status: 'confirmed', points: [] },
      draft: {
        title: '标题', digest: '摘要', lead: '导语', closingCta: '结语',
        sections: [{ sectionId: 'section-1', order: 1, heading: '第一节', paragraphs: [{ paragraphId: 'paragraph-1', text: '审查前正文', claimIds: [] }] }],
      },
    },
  };
  const reviewedPayload = structuredClone(workspace.payload);
  reviewedPayload.reviewReport = { status: 'approved', issues: [] };
  const result = await boot({
    fetchImpl: async (url) => {
      if (url === '/api/health') return jsonResponse({ ok: true, workspaceScope: 'scope-review-edit' });
      if (url === '/api/workspace/latest') return jsonResponse({ workspace });
      if (url === '/api/workspaces') return jsonResponse({ workspaces: [] });
      if (url === '/api/workspace/review') return jsonResponse({
        payload: reviewedPayload,
        annotationHistory: [],
        revisionHistory: [],
        reviewReport: reviewedPayload.reviewReport,
      });
      throw new Error(`unexpected ${url}`);
    },
  });

  const beforeReview = result.studio.getElement('article-editor').querySelectorAll('[data-paragraph-index]')[0];
  beforeReview.onfocus();
  await result.studio.runReview();

  const stateAfterReview = result.studio.snapshot();
  const afterReview = result.studio.getElement('article-editor').querySelectorAll('[data-paragraph-index]')[0];
  assert.equal(stateAfterReview.selectedParagraphId, 'paragraph-1');
  assert.equal(afterReview.classList.contains('selected'), true);
  assert.notEqual(result.context.document.getElementById('global-status').textContent, '正在核对文章与来源，请稍候');

  afterReview.value = '审查后新正文';
  afterReview.oninput();
  const saved = result.studio.saveBody();
  assert.equal(saved.payload.draft.sections[0].paragraphs[0].text, '审查后新正文');
  assert.equal(saved.revisionHistory[0].draftHash, 'local-draft-snapshot');
});
