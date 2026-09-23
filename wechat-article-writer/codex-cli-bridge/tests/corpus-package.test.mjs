import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createCorpusPackageManager } from '../corpus-package-manager.mjs';
import { createBridgeServer } from '../server.mjs';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

function resolveSchema(schema, registry) {
  if (!schema || typeof schema !== 'object') return schema;
  if (typeof schema.$ref === 'string') {
    if (schema.$ref.startsWith('#/')) return schema;
    return registry.get(schema.$ref) ?? schema;
  }
  return schema;
}

function assertResponseShape(value, schema, registry, location = '$') {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertResponseShape(item, schema?.items, registry, `${location}[${index}]`);
    return;
  }
  if (typeof value !== 'object') return;
  let resolved = resolveSchema(schema, registry);
  if (resolved?.anyOf) {
    const candidate = resolved.anyOf.find((item) => item && (item.type === 'object' || item.$ref));
    if (candidate) resolved = resolveSchema(candidate, registry);
  }
  const properties = resolved?.properties ?? {};
  for (const required of resolved?.required ?? []) {
    assert.equal(Object.hasOwn(value, required), true, `${location} missing required ${required}`);
  }
  for (const [key, child] of Object.entries(value)) {
    assert.equal(Object.hasOwn(properties, key), true, `${location}.${key} is not declared by schema`);
    assertResponseShape(child, properties[key], registry, `${location}.${key}`);
  }
}

function loadSchema(name) {
  return fs.readFile(path.join(TEST_DIRECTORY, '..', name), 'utf8').then(JSON.parse);
}

function httpRequest(port, pathname, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const requestHeaders = { ...headers };
    if (payload) requestHeaders['content-length'] = payload.length;
    const req = request({ host: '127.0.0.1', port, path: pathname, method, headers: requestHeaders }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.end(payload); else req.end();
  });
}

async function withServer(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-corpus-'));
  const jobs = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-corpus-jobs-'));
  let observed;
  const server = createBridgeServer({
    port: 0,
    projectRoot: root,
    corpusPath: root,
    dnaJobsPath: jobs,
    statusProvider: async () => ({ ok: true }),
    dnaRunner: async (mode, options) => {
      observed = { mode, options };
      return { summary: 'ok', outputFiles: ['Academic-Writing-DNA.md'] };
    },
    artifactCollector: async () => {
      const files = [{ path: 'Academic-Writing-DNA.md', bytes: 2, sha256: 'a'.repeat(64) }];
      const canonical = JSON.stringify({ mode: 'academic', workspace: 'writing-dna-workspace/academic', files });
      const hash = createHash('sha256').update(canonical).digest('hex');
      return {
        schemaVersion: 'content-desk.dna-artifact.v1',
        mode: 'academic',
        workspace: 'writing-dna-workspace/academic',
        files,
        sha256: hash,
        artifactHash: hash,
      };
    },
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try { return await callback(server.address().port, () => observed); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(jobs, { recursive: true, force: true });
  }
}

const validText = '这是经本人授权的本地学术语料。\r\n第二行用于验证换行归一化。\n';

test('v30 corpus package stages local UTF-8 bytes, sanitizes names, and rejects rights/format violations', async () => {
  await withServer(async (port) => {
    const unknownRights = await httpRequest(port, '/v1/corpus-packages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { schemaVersion: 'content-desk.corpus-import.v1', mode: 'academic', rightsAttestation: 'unknown', files: [] },
    });
    assert.equal(unknownRights.status, 400);
    assert.equal(unknownRights.body.code, 'rights_attestation_required');

    const unsupported = await httpRequest(port, '/v1/corpus-packages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: {
        schemaVersion: 'content-desk.corpus-import.v1', mode: 'academic', rightsAttestation: 'self_authored',
        files: [{ clientFileId: 'html_1', name: '../../secret.html', mediaType: 'text/html', bytes: 1 }],
      },
    });
    assert.equal(unsupported.status, 415);

    const created = await httpRequest(port, '/v1/corpus-packages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: {
        schemaVersion: 'content-desk.corpus-import.v1', mode: 'academic', rightsAttestation: 'self_authored', idempotencyKey: 'corpus-key-1',
        files: [{ clientFileId: 'local_1', name: '../../notes/论文.md', mediaType: 'text/markdown', bytes: Buffer.byteLength(validText) }],
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.state, 'staging');
    assert.equal(created.body.files[0].state, 'awaiting_upload');
    assert.equal(created.body.files[0].name, '论文.md');
    assert.equal('preview' in created.body.files[0], false);
    const file = created.body.files[0];
    const incomplete = await httpRequest(port, `/v1/corpus-packages/${created.body.packageId}/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: { schemaVersion: 'content-desk.corpus-confirm.v1' },
    });
    assert.equal(incomplete.status, 409);
    assert.equal(incomplete.body.code, 'corpus_upload_incomplete');

    const badPackage = await httpRequest(port, '/v1/corpus-packages', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: {
        schemaVersion: 'content-desk.corpus-import.v1', mode: 'academic', rightsAttestation: 'self_authored',
        files: [{ clientFileId: 'bad_utf8', name: 'bad.md', mediaType: 'text/markdown', bytes: 3 }],
      },
    });
    const invalidUtf8 = await httpRequest(port, `/v1/corpus-packages/${badPackage.body.packageId}/files/${badPackage.body.files[0].fileId}`, {
      method: 'PUT', headers: { 'content-type': 'text/markdown' }, body: Buffer.from([0xff, 0xfe, 0xfd]),
    });
    assert.equal(invalidUtf8.status, 415);
    assert.equal(invalidUtf8.body.schemaVersion, 'content-desk.corpus-error-response.v1');
    assert.deepEqual(invalidUtf8.body.issues, ['invalid_utf8']);
    const errorSchema = await loadSchema('corpus-error-response.schema.json');
    assertResponseShape(invalidUtf8.body, errorSchema, new Map([[errorSchema.$id, errorSchema]]), '$.error');

    const goodUpload = await httpRequest(port, `/v1/corpus-packages/${created.body.packageId}/files/${file.fileId}`, {
      method: 'PUT', headers: { 'content-type': 'text/markdown' }, body: Buffer.from(validText, 'utf8'),
    });
    assert.equal(goodUpload.status, 200);
    assert.equal(goodUpload.body.schemaVersion, 'content-desk.corpus-upload-response.v1');
    assert.equal(goodUpload.body.file.state, 'parsed');
    assert.equal(goodUpload.body.file.normalizedTextHash.length, 64);
    assert.equal(goodUpload.body.file.characterCount > 0, true);
    assert.equal('preview' in goodUpload.body.file, false);

    const refresh = await httpRequest(port, `/v1/corpus-packages/${created.body.packageId}`);
    assert.equal(refresh.status, 200);
    assert.equal(refresh.body.state, 'ready_to_confirm');
    assert.equal(refresh.body.canConfirm, true);
    assert.equal(refresh.body.files[0].state, 'parsed');
    assert.equal(JSON.stringify(refresh.body).includes('\\\\'), false);

    const duplicate = await httpRequest(port, '/v1/corpus-packages', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: {
        schemaVersion: 'content-desk.corpus-import.v1', mode: 'academic', rightsAttestation: 'self_authored', idempotencyKey: 'corpus-key-1',
        files: [{ clientFileId: 'local_1', name: '../../notes/论文.md', mediaType: 'text/markdown', bytes: Buffer.byteLength(validText) }],
      },
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.idempotent, true);
    assert.equal(duplicate.body.packageId, created.body.packageId);

    const packageSchema = JSON.parse(await fs.readFile(path.join(TEST_DIRECTORY, '..', 'corpus-package.schema.json'), 'utf8'));
    const uploadSchema = await loadSchema('corpus-upload-response.schema.json');
    const registry = new Map([[packageSchema.$id, packageSchema], [uploadSchema.$id, uploadSchema]]);
    assertResponseShape(goodUpload.body, uploadSchema, registry, '$.upload');
  });
});

test('v30 confirm freezes an immutable snapshot and passes it to the existing DNA job executor', async () => {
  await withServer(async (port, getObserved) => {
    const body = {
      schemaVersion: 'content-desk.corpus-import.v1', mode: 'academic', rightsAttestation: 'permission_granted', idempotencyKey: 'snapshot-key-1',
      files: [{ clientFileId: 'paper_1', name: 'paper.txt', mediaType: 'text/plain', bytes: Buffer.byteLength(validText) }],
    };
    const created = await httpRequest(port, '/v1/corpus-packages', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const file = created.body.files[0];
    await httpRequest(port, `/v1/corpus-packages/${created.body.packageId}/files/${file.fileId}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: Buffer.from(validText) });
    const confirmed = await httpRequest(port, `/v1/corpus-packages/${created.body.packageId}/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: { schemaVersion: 'content-desk.corpus-confirm.v1' },
    });
    assert.equal(confirmed.status, 201);
    assert.equal(confirmed.body.schemaVersion, 'content-desk.corpus-confirm-response.v1');
    assert.equal(confirmed.body.snapshot.snapshotId.length > 0, true);
    assert.equal(confirmed.body.snapshot.fileCount, 1);
    assert.equal(confirmed.body.snapshot.corpusSnapshotId, confirmed.body.snapshot.snapshotId);
    assert.equal(confirmed.body.package.snapshot.snapshotId, confirmed.body.snapshot.snapshotId);
    assert.equal('rootPath' in confirmed.body.snapshot, false);

    const repeatedConfirm = await httpRequest(port, `/v1/corpus-packages/${created.body.packageId}/confirm`, { method: 'POST' });
    assert.equal(repeatedConfirm.status, 200);
    assert.equal(repeatedConfirm.body.idempotent, true);

    const job = await httpRequest(port, '/v1/dna/jobs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: {
        jobId: 'snapshot-job-1', mode: 'academic', corpusSnapshotId: confirmed.body.snapshot.snapshotId,
      },
    });
    assert.equal(job.status, 202);
    const observed = await (async () => {
      for (let i = 0; i < 100; i += 1) {
        const current = await httpRequest(port, '/v1/dna/jobs/snapshot-job-1');
        if (current.body?.state === 'succeeded' || current.body?.state === 'failed') return current.body;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return (await httpRequest(port, '/v1/dna/jobs/snapshot-job-1')).body;
    })();
    assert.equal(observed.state, 'succeeded');
    assert.equal(observed.corpusSnapshotId, confirmed.body.snapshot.snapshotId);
    assert.equal(getObserved().options.corpusSnapshotId, confirmed.body.snapshot.snapshotId);
    assert.equal(getObserved().options.corpusSnapshot.rootPath.endsWith(path.join('snapshots', confirmed.body.snapshot.snapshotId, 'files')), true);

    const packageSchema = JSON.parse(await fs.readFile(path.join(TEST_DIRECTORY, '..', 'corpus-package.schema.json'), 'utf8'));
    const snapshotSchema = JSON.parse(await fs.readFile(path.join(TEST_DIRECTORY, '..', 'corpus-snapshot.schema.json'), 'utf8'));
    const confirmSchema = await loadSchema('corpus-confirm-response.schema.json');
    const registry = new Map([[packageSchema.$id, packageSchema], [snapshotSchema.$id, snapshotSchema], [confirmSchema.$id, confirmSchema]]);
    assertResponseShape(confirmed.body, confirmSchema, registry, '$.confirm');
    assertResponseShape(repeatedConfirm.body, confirmSchema, registry, '$.confirm.idempotent');
  });
});

test('v30 parser rejects BOM-only/whitespace and invisible control text before parsed state', async () => {
  await withServer(async (port) => {
    for (const [clientFileId, name, value, code] of [
      ['blank', 'blank.txt', '\uFEFF \r\n\t', 'empty_text'],
      ['control', 'control.txt', '可见\u0000文本', 'unsupported_control_characters'],
    ]) {
      const created = await httpRequest(port, '/v1/corpus-packages', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: {
          schemaVersion: 'content-desk.corpus-import.v1', mode: 'academic', rightsAttestation: 'self_authored',
          files: [{ clientFileId, name, mediaType: 'text/plain', bytes: Buffer.byteLength(value) }],
        },
      });
      const response = await httpRequest(port, `/v1/corpus-packages/${created.body.packageId}/files/${created.body.files[0].fileId}`, {
        method: 'PUT', headers: { 'content-type': 'text/plain' }, body: Buffer.from(value),
      });
      assert.equal(response.status, 422);
      assert.equal(response.body.code, code);
      assert.deepEqual(response.body.issues, [code]);
      const packageResponse = await httpRequest(port, `/v1/corpus-packages/${created.body.packageId}`);
      assert.equal(packageResponse.body.files[0].state, 'awaiting_upload');
    }
  });
});

test('v30 corpus schemas cover canonical package and snapshot responses', async () => {
  const packageSchema = JSON.parse(await fs.readFile(path.join(TEST_DIRECTORY, '..', 'corpus-package.schema.json'), 'utf8'));
  const snapshotSchema = JSON.parse(await fs.readFile(path.join(TEST_DIRECTORY, '..', 'corpus-snapshot.schema.json'), 'utf8'));
  const registry = new Map([[packageSchema.$id, packageSchema], [snapshotSchema.$id, snapshotSchema]]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-corpus-schema-'));
  try {
    const manager = createCorpusPackageManager({ directory: root });
    const created = await manager.create({
      mode: 'writing',
      rightsAttestation: 'self_authored',
      idempotencyKey: 'schema-contract-1',
      files: [{ clientFileId: 'schema_file', name: 'article.md', mediaType: 'text/markdown', bytes: Buffer.byteLength(validText) }],
    });
    assertResponseShape({ ...created.package, created: true, idempotent: false }, packageSchema, registry, '$.create');
    const file = created.package.files[0];
    const bytes = Buffer.from(validText, 'utf8');
    await manager.upload(created.package.packageId, file.fileId, Readable.from([bytes]), { contentLength: bytes.length });
    const confirmed = await manager.confirm(created.package.packageId);
    assertResponseShape({ ...confirmed.package, created: false, idempotent: false }, packageSchema, registry, '$.confirm.package');
    assertResponseShape(confirmed.snapshot, snapshotSchema, registry, '$.confirm.snapshot');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
