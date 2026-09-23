import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from '../src/orchestrator.mjs';
import { sampleInput } from '../src/sample-data.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const backup = join(root, 'data', 'backups', 'delivery-r01-20260922');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

test('old data remains intact; unapproved annotated current version saves and exports', { timeout: 25000 }, async () => {
  const dataDir = await mkdtemp(join(root, 'data', 'delivery-api-'));
  assert.ok(dataDir.startsWith(join(root, 'data', 'delivery-api-')));
  let child;
  try {
    await copyFile(join(backup, 'workspace.json'), join(dataDir, 'workspace.json'));
    await copyFile(join(backup, 'research-sessions.json'), join(dataDir, 'research-sessions.json'));
    const original = JSON.parse(await readFile(join(dataDir, 'workspace.json'), 'utf8'));
    const ids = original.workspaces.map(item => item.workspaceId);
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: root, env: { ...process.env, WECHAT_STUDIO_PORT: String(port), WECHAT_STUDIO_DATA_DIR: dataDir },
      stdio: 'ignore', windowsHide: true,
    });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) throw new Error(`isolated server exited ${child.exitCode}`);
      try { ready = (await (await fetch(`${origin}/api/health`)).json()).ok === true; } catch {}
      if (ready) break;
      await delay(100);
    }
    assert.ok(ready, 'isolated server must become healthy');
    const post = async (path, value) => {
      const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
      return { response, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.arrayBuffer() };
    };
    for (const id of ids) {
      const response = await fetch(`${origin}/api/workspace/${encodeURIComponent(id)}`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).workspace.workspaceId, id);
    }
    const payload = structuredClone(runPipeline(sampleInput));
    payload.draft.sections[0].paragraphs[0].text += ' 本次编辑保留在当前版本。';
    const paragraphId = payload.draft.sections[0].paragraphs[0].paragraphId;
    const annotation = { annotationId: 'delivery-high', targetParagraphId: paragraphId, kind: 'replace_paragraph', replacementText: payload.draft.sections[0].paragraphs[0].text, instruction: '核对这一段', priority: 'high', status: 'open' };
    const saved = await post('/api/workspace', { workspaceId: 'delivery-isolated', baseVersion: 0, mode: 'verified_materials', payload, annotationHistory: [annotation] });
    assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
    const workspace = saved.body.workspace;
    assert.equal(workspace.humanApproval, null);
    assert.equal(workspace.annotationHistory[0].status, 'open');
    const stale = await post('/api/export/word', { workspaceId: workspace.workspaceId, version: 0 });
    assert.equal(stale.response.status, 409);
    const exported = await post('/api/export/word', { workspaceId: workspace.workspaceId, version: workspace.version });
    assert.equal(exported.response.status, 200, JSON.stringify(exported.body));
    assert.match(exported.response.headers.get('content-disposition'), /\.docx/u);
    assert.doesNotMatch(exported.response.headers.get('content-disposition'), /审阅稿/u);
    assert.equal(Buffer.from(exported.body).subarray(0, 2).toString(), 'PK');
    const after = JSON.parse(await readFile(join(dataDir, 'workspace.json'), 'utf8'));
    for (const id of ids) assert.equal(after.workspaces.filter(item => item.workspaceId === id).length, 1);
    assert.equal(after.workspaces.find(item => item.workspaceId === 'delivery-isolated').annotationHistory[0].status, 'open');
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('close', resolve));
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
