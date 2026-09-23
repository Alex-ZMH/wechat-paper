import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import test from 'node:test';

import {
  ASSET_BUNDLE_SCHEMA_VERSION,
  CONTENT_EXPORT_MANIFEST_SCHEMA_VERSION,
  DELIVERY_LIST_SCHEMA_VERSION,
  DELIVERY_MANIFEST_SCHEMA_VERSION,
  DELIVERY_REQUEST_SCHEMA_VERSION,
  DELIVERY_RESPONSE_SCHEMA_VERSION,
  DeliveryStoreError,
  createBridgeServer,
  createContentStore,
  createDeliveryStore,
  createMultiPostDeliveryManager,
  MultiPostAdapterError,
} from '../server.mjs';

function httpJson(port, route, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    const encoded = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    if (encoded !== undefined) {
      requestHeaders['Content-Type'] ??= 'application/json';
      requestHeaders['Content-Length'] = Buffer.byteLength(encoded);
    }
    const req = request({ host: '127.0.0.1', port, path: route, method, headers: requestHeaders }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (encoded !== undefined) req.write(encoded);
    req.end();
  });
}

async function tempDirectory(prefix = 'content-desk-delivery-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function waitForEvent(store, type, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const events = await store.readEvents();
    if (events.some((event) => event.type === type)) return events;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

function textManifest({ text = '# 版本化正文', title = '一篇文章', contentHash = undefined } = {}) {
  return {
    schemaVersion: CONTENT_EXPORT_MANIFEST_SCHEMA_VERSION,
    manifestId: 'manifest-1',
    documentId: 'doc-1',
    revisionId: 'rev-1',
    contentHash: contentHash ?? createHash('sha256').update(text).digest('hex'),
    title,
    titleCandidates: [title],
    text,
    contentStatus: 'assets_pending',
    blockingReasons: ['assets_missing'],
    assets: { required: true, complete: false, policy: 'external_project' },
    delivery: { status: 'not_started', attempts: [] },
    generatedAt: '2026-08-31T00:00:00.000Z',
  };
}

const FIXTURE_ASSET_DIR = path.join(os.tmpdir(), 'content-desk-delivery-fixtures');
const FIXTURE_COVER = path.join(FIXTURE_ASSET_DIR, 'cover.jpg');
const FIXTURE_IMAGE = path.join(FIXTURE_ASSET_DIR, 'figure.png');

async function ensureFixtureAssets() {
  await fs.mkdir(FIXTURE_ASSET_DIR, { recursive: true });
  await fs.writeFile(FIXTURE_COVER, 'fixture-cover-bytes');
  await fs.writeFile(FIXTURE_IMAGE, 'fixture-image-bytes');
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function makeFixture({
  manifest = textManifest(),
  accounts = [{
    id: 'a1',
    platform: 'wechat',
    username: 'owner',
    displayName: '研发账号',
    remark: '测试账号',
    isLoggedIn: true,
    isDefault: true,
  }],
  platforms = [{ id: 'wechat', name: 'wechat', supportedContentTypes: ['ARTICLE'] }],
  publishError = undefined,
} = {}) {
  const manifests = new Map([[manifest.manifestId, clone(manifest)]]);
  const calls = {
    publish: [],
    status: [],
    submit: [],
    retry: [],
  };
  const statusQueue = [];
  const adapter = {
    async accounts() { return { status: 'ready', accounts: clone(accounts), count: accounts.length }; },
    async platforms() { return { status: 'ready', platforms: clone(platforms), count: platforms.length }; },
    async publish(payload) {
      calls.publish.push(clone(payload));
      if (publishError) throw publishError;
      return {
        status: 'accepted',
        upstreamStatus: 202,
        official: {
          groupId: 'group-1',
          status: {
            status: 'preparing',
            targets: payload.accountIds.map((accountId) => ({ platform: 'wechat', accountId, status: 'pending' })),
          },
        },
      };
    },
    async publishStatus(groupId) {
      calls.status.push(groupId);
      return statusQueue.shift() ?? {
        status: 'polled',
        upstreamStatus: 200,
        official: {
          groupId,
          status: 'publishing',
          targets: [{ platform: 'wechat', accountId: 'a1', status: 'pending' }],
        },
      };
    },
    async submit(groupId) {
      calls.submit.push(groupId);
      return {
        status: 'submitted',
        upstreamStatus: 202,
        official: {
          groupId,
          status: 'publishing',
          targets: [{ platform: 'wechat', accountId: 'a1', status: 'ready' }],
        },
      };
    },
    async retryTarget(groupId, accountId) {
      calls.retry.push([groupId, accountId]);
      return {
        status: 'retry_accepted',
        upstreamStatus: 202,
        official: {
          groupId,
          status: 'publishing',
          targets: [{ platform: 'wechat', accountId, status: 'pending' }],
        },
      };
    },
  };
  const contentStore = {
    async getExportManifestById(id) { return clone(manifests.get(id)); },
    replace(next) { manifests.set(next.manifestId, clone(next)); },
  };
  return { manifest, manifests, contentStore, adapter, calls, statusQueue };
}

async function makeManager(fixture = makeFixture()) {
  await ensureFixtureAssets();
  const directory = await tempDirectory();
  const deliveryStore = createDeliveryStore({ filePath: path.join(directory, 'multipost-deliveries.v1.json') });
  const manager = createMultiPostDeliveryManager({
    contentStore: fixture.contentStore,
    adapter: fixture.adapter,
    deliveryStore,
    assetSnapshotRoot: path.join(directory, 'delivery-assets'),
  });
  return { ...fixture, manager, deliveryStore, directory };
}

async function withBridge(options, callback) {
  const bridge = createBridgeServer({ port: 0, statusProvider: async () => ({ ok: true }), ...options });
  bridge.listen(0, '127.0.0.1');
  await once(bridge, 'listening');
  try { return await callback(bridge.address().port); } finally {
    const closed = once(bridge, 'close');
    bridge.close();
    await closed;
  }
}

test('asset backfill validates cover paths and keeps the text manifest immutable', async () => {
  const fixture = await makeManager();
  await assert.rejects(
    () => fixture.manager.createAssets('manifest-1', { schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION, images: [] }),
    (error) => error.code === 'asset_missing_cover' && error.status === 400,
  );
  for (const cover of ['cover.jpg', 'blob:https://example.test/id', 'data:image/png;base64,abc', 'file:///tmp/cover.jpg', 'https://cdn.example.test/cover.jpg', { url: 'https://cdn.example.test/cover.jpg', name: 'cover.jpg' }, { url: FIXTURE_COVER, name: 'cover.jpg' }]) {
    await assert.rejects(
      () => fixture.manager.createAssets('manifest-1', { schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION, cover }),
      (error) => error.code === 'asset_invalid' && error.status === 400,
    );
  }
  const sourceBefore = clone(fixture.manifests.get('manifest-1'));
  const deliveryManifest = await fixture.manager.createAssets('manifest-1', {
    schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION,
    cover: FIXTURE_COVER,
    images: [FIXTURE_IMAGE],
  });
  assert.equal(deliveryManifest.schemaVersion, DELIVERY_MANIFEST_SCHEMA_VERSION);
  assert.equal(deliveryManifest.sourceManifestId, 'manifest-1');
  assert.equal(deliveryManifest.state, 'ready_to_send');
  assert.equal(deliveryManifest.content.markdownContent, sourceBefore.text);
  assert.notEqual(deliveryManifest.deliveryManifestId, sourceBefore.manifestId);
  assert.deepEqual(fixture.manifests.get('manifest-1'), sourceBefore);
  assert.deepEqual(await fixture.manager.getDeliveryManifest(deliveryManifest.deliveryManifestId), deliveryManifest);
  const duplicate = await fixture.manager.createAssets('manifest-1', {
    schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION,
    cover: FIXTURE_COVER,
    images: [FIXTURE_IMAGE],
  });
  assert.equal(duplicate.deliveryManifestId, deliveryManifest.deliveryManifestId);
  const [parallelA, parallelB] = await Promise.all([
    fixture.manager.createAssets('manifest-1', { schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION, cover: FIXTURE_COVER, images: [FIXTURE_IMAGE] }),
    fixture.manager.createAssets('manifest-1', { schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION, cover: FIXTURE_COVER, images: [FIXTURE_IMAGE] }),
  ]);
  assert.equal(parallelA.deliveryManifestId, deliveryManifest.deliveryManifestId);
  assert.equal(parallelB.deliveryManifestId, deliveryManifest.deliveryManifestId);
});

test('delivery store enforces expected event-count CAS inside its write queue', async () => {
  const directory = await tempDirectory();
  const store = createDeliveryStore({ filePath: path.join(directory, 'events.json') });
  await store.append({ type: 'seed' });
  await assert.rejects(
    () => store.append({ type: 'stale-intent', expectedEventCount: 0 }),
    (error) => error instanceof DeliveryStoreError && error.code === 'delivery_event_cas_failed' && error.status === 409,
  );
  const events = await store.readEvents();
  assert.equal(events.length, 1);
  await store.append({ type: 'fresh-intent', expectedEventCount: 1 });
  assert.equal((await store.readEvents()).length, 2);
});

test('delivery stores sharing one path serialize cross-instance CAS and keep both non-CAS appends', async () => {
  const directory = await tempDirectory();
  const filePath = path.join(directory, 'events.json');
  const first = createDeliveryStore({ filePath });
  const second = createDeliveryStore({ filePath });
  const results = await Promise.allSettled([
    first.append({ type: 'intent-a', expectedEventCount: 0 }),
    second.append({ type: 'intent-b', expectedEventCount: 0 }),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter((item) => item.status === 'rejected' && item.reason?.code === 'delivery_event_cas_failed').length, 1);
  assert.equal((await first.readEvents()).length, 1);
  await Promise.all([first.append({ type: 'plain-a' }), second.append({ type: 'plain-b' })]);
  assert.equal((await second.readEvents()).length, 3);
  assert.equal(await fs.access(`${filePath}.lock`).then(() => true, () => false), false);
});

test('asset backfill freezes ordinary files and rejects a tampered snapshot before publish', async () => {
  const fixture = await makeManager();
  const packageManifest = await fixture.manager.createAssets('manifest-1', {
    schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION,
    cover: FIXTURE_COVER,
    images: [FIXTURE_IMAGE],
  });
  assert.equal(packageManifest.assetRecords.cover.kind, 'local_file');
  assert.equal(packageManifest.assetRecords.cover.bytes, Buffer.byteLength('fixture-cover-bytes'));
  assert.match(packageManifest.assetRecords.cover.sha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(packageManifest.assets.cover, FIXTURE_COVER);
  assert.equal(await fs.readFile(packageManifest.assets.cover, 'utf8'), 'fixture-cover-bytes');
  await fs.writeFile(packageManifest.assets.cover, 'tampered-cover');
  await assert.rejects(
    () => fixture.manager.createDelivery({
      schemaVersion: DELIVERY_REQUEST_SCHEMA_VERSION,
      deliveryManifestId: packageManifest.deliveryManifestId,
      accountIds: ['a1'],
      contentType: 'ARTICLE',
    }),
    (error) => error.code === 'asset_snapshot_failed' && error.status === 409,
  );
  assert.equal(fixture.calls.publish.length, 0);
});

test('empty titles and markdown cannot enter a delivery manifest', async () => {
  const blankTitle = await makeManager(makeFixture({ manifest: textManifest({ title: '   ' }) }));
  await assert.rejects(
    () => blankTitle.manager.createAssets('manifest-1', { schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION, cover: FIXTURE_COVER }),
    (error) => error.code === 'text_manifest_corrupt' && error.status === 500,
  );
  const blankText = await makeManager(makeFixture({ manifest: textManifest({ text: '   ' }) }));
  await assert.rejects(
    () => blankText.manager.createAssets('manifest-1', { schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION, cover: FIXTURE_COVER }),
    (error) => error.code === 'text_manifest_corrupt' && error.status === 500,
  );
});

test('delivery creation rejects arbitrary body fields and invalid targets before publish', async () => {
  const fixture = await makeManager();
  const packageManifest = await fixture.manager.createAssets('manifest-1', {
    schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION,
    cover: FIXTURE_COVER,
  });
  const requestBody = {
    schemaVersion: DELIVERY_REQUEST_SCHEMA_VERSION,
    deliveryManifestId: packageManifest.deliveryManifestId,
    accountIds: ['a1'],
    contentType: 'ARTICLE',
  };
  await assert.rejects(
    () => fixture.manager.createDelivery({ ...requestBody, autoSubmit: true }),
    (error) => error.code === 'delivery_invalid' && error.status === 400,
  );
  await assert.rejects(
    () => fixture.manager.createDelivery({ ...requestBody, markdownContent: '替换正文' }),
    (error) => error.code === 'delivery_invalid' && error.status === 400,
  );
  await assert.rejects(
    () => fixture.manager.createDelivery({ ...requestBody, accountIds: ['unknown'] }),
    (error) => error.code === 'delivery_account_not_found' && error.status === 422,
  );
  const unsupported = await makeManager(makeFixture({
    platforms: [{ id: 'wechat', name: 'wechat', supportedContentTypes: ['VIDEO'] }],
  }));
  const unsupportedManifest = await unsupported.manager.createAssets('manifest-1', {
    schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION,
    cover: FIXTURE_COVER,
  });
  await assert.rejects(
    () => unsupported.manager.createDelivery({ ...requestBody, deliveryManifestId: unsupportedManifest.deliveryManifestId }),
    (error) => error.code === 'delivery_unsupported_content_type' && error.status === 422,
  );
  const loggedOut = await makeManager(makeFixture({ accounts: [{ id: 'a1', platform: 'wechat', isLoggedIn: false }] }));
  const loggedOutManifest = await loggedOut.manager.createAssets('manifest-1', {
    schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION,
    cover: FIXTURE_COVER,
  });
  await assert.rejects(
    () => loggedOut.manager.createDelivery({ ...requestBody, deliveryManifestId: loggedOutManifest.deliveryManifestId }),
    (error) => error.code === 'delivery_account_not_logged_in' && error.status === 409,
  );
  assert.equal(fixture.calls.publish.length, 0);
  assert.equal(loggedOut.calls.publish.length, 0);
});

test('happy path sends the exact safe publish payload and is idempotent', async () => {
  const fixture = await makeManager();
  const packageManifest = await fixture.manager.createAssets('manifest-1', {
    schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION,
    cover: FIXTURE_COVER,
    images: [FIXTURE_IMAGE],
  });
  const requestBody = {
    schemaVersion: DELIVERY_REQUEST_SCHEMA_VERSION,
    deliveryManifestId: packageManifest.deliveryManifestId,
    accountIds: ['a1'],
    contentType: 'ARTICLE',
  };
  const delivery = await fixture.manager.createDelivery(requestBody);
  assert.equal(delivery.schemaVersion, DELIVERY_RESPONSE_SCHEMA_VERSION);
  assert.equal(delivery.state, 'awaiting_ready');
  assert.equal(delivery.groupId, 'group-1');
  assert.deepEqual(fixture.calls.publish, [{
    contentType: 'ARTICLE',
    accountIds: ['a1'],
    autoSubmit: false,
    data: {
      title: '一篇文章',
      markdownContent: '# 版本化正文',
      cover: packageManifest.assets.cover,
      images: packageManifest.assets.images,
    },
  }]);
  const repeated = await fixture.manager.createDelivery(requestBody);
  assert.equal(repeated.deliveryId, delivery.deliveryId);
  assert.equal(fixture.calls.publish.length, 1);
  const [parallelA, parallelB] = await Promise.all([
    fixture.manager.createDelivery(requestBody),
    fixture.manager.createDelivery(requestBody),
  ]);
  assert.equal(parallelA.deliveryId, delivery.deliveryId);
  assert.equal(parallelB.deliveryId, delivery.deliveryId);
  assert.equal(fixture.calls.publish.length, 1);
  const list = await fixture.manager.listDeliveries();
  assert.equal(list.length, 1);
  assert.equal(list[0].deliveryManifestId, packageManifest.deliveryManifestId);
});

test('polling exposes ready-to-submit and submit requires the expected ids plus confirm', async () => {
  const fixture = await makeManager();
  const packageManifest = await fixture.manager.createAssets('manifest-1', {
    schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION,
    cover: FIXTURE_COVER,
  });
  const requestBody = {
    schemaVersion: DELIVERY_REQUEST_SCHEMA_VERSION,
    deliveryManifestId: packageManifest.deliveryManifestId,
    accountIds: ['a1'],
    contentType: 'ARTICLE',
  };
  const delivery = await fixture.manager.createDelivery(requestBody);
  fixture.statusQueue.push({
    status: 'polled',
    upstreamStatus: 200,
    official: {
      groupId: 'group-1',
      status: 'ready',
      targets: [{ platform: 'wechat', accountId: 'a1', status: 'ready' }],
    },
  });
  const ready = await fixture.manager.getDelivery(delivery.deliveryId);
  assert.equal(ready.state, 'ready_to_submit');
  assert.equal(ready.targets[0].status, 'ready');
  const expected = { expectedGroupId: 'group-1', expectedDeliveryManifestId: packageManifest.deliveryManifestId };
  await assert.rejects(
    () => fixture.manager.submitDelivery(delivery.deliveryId, { ...expected, confirm: false }),
    (error) => error.code === 'delivery_confirm_required' && error.status === 400,
  );
  await assert.rejects(
    () => fixture.manager.submitDelivery(delivery.deliveryId, { ...expected, confirm: true, expectedGroupId: 'wrong' }),
    (error) => error.code === 'delivery_expected_mismatch' && error.status === 409,
  );
  assert.equal(fixture.calls.submit.length, 0);
  const submitted = await fixture.manager.submitDelivery(delivery.deliveryId, { ...expected, confirm: true });
  assert.equal(submitted.state, 'submitted_pending');
  assert.equal(fixture.calls.submit.length, 1);
  const submittedAgain = await fixture.manager.submitDelivery(delivery.deliveryId, { ...expected, confirm: true });
  assert.equal(submittedAgain.deliveryId, delivery.deliveryId);
  assert.equal(fixture.calls.submit.length, 1);
});

test('failed targets can be retried individually and non-failed targets are blocked', async () => {
  const fixture = await makeManager({
    ...makeFixture({
      accounts: [
        { id: 'a1', platform: 'wechat', isLoggedIn: true },
        { id: 'a2', platform: 'wechat', isLoggedIn: true },
      ],
    }),
  });
  const packageManifest = await fixture.manager.createAssets('manifest-1', {
    schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION,
    cover: FIXTURE_COVER,
  });
  const requestBody = {
    schemaVersion: DELIVERY_REQUEST_SCHEMA_VERSION,
    deliveryManifestId: packageManifest.deliveryManifestId,
    accountIds: ['a1', 'a2'],
    contentType: 'ARTICLE',
  };
  const delivery = await fixture.manager.createDelivery(requestBody);
  fixture.statusQueue.push({
    status: 'polled',
    upstreamStatus: 200,
    official: {
      groupId: 'group-1',
      status: 'publishing',
      targets: [
        { platform: 'wechat', accountId: 'a1', status: 'failed', error: '上游失败' },
        { platform: 'wechat', accountId: 'a2', status: 'ready' },
      ],
    },
  });
  const failed = await fixture.manager.getDelivery(delivery.deliveryId);
  assert.equal(failed.state, 'awaiting_ready');
  assert.equal(failed.targets.find((target) => target.accountId === 'a1').status, 'failed');
  const expected = { expectedGroupId: 'group-1', expectedDeliveryManifestId: packageManifest.deliveryManifestId };
  await assert.rejects(
    () => fixture.manager.retryDeliveryTarget(delivery.deliveryId, 'a1', { ...expected, confirm: true }),
    (error) => error.code === 'delivery_invalid' && error.status === 400,
  );
  await assert.rejects(
    () => fixture.manager.retryDeliveryTarget(delivery.deliveryId, 'a2', expected),
    (error) => error.code === 'delivery_target_not_failed' && error.status === 409,
  );
  const retried = await fixture.manager.retryDeliveryTarget(delivery.deliveryId, 'a1', expected);
  assert.equal(retried.targets.find((target) => target.accountId === 'a1').status, 'pending');
  assert.deepEqual(fixture.calls.retry, [['group-1', 'a1']]);
});

test('target statuses map to filling and mixed terminal outcomes', async () => {
  const fixture = await makeManager(makeFixture({
    accounts: [
      { id: 'a1', platform: 'wechat', isLoggedIn: true },
      { id: 'a2', platform: 'wechat', isLoggedIn: true },
    ],
  }));
  const packageManifest = await fixture.manager.createAssets('manifest-1', {
    schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION,
    cover: FIXTURE_COVER,
  });
  const request = {
    schemaVersion: DELIVERY_REQUEST_SCHEMA_VERSION,
    deliveryManifestId: packageManifest.deliveryManifestId,
    accountIds: ['a1', 'a2'],
    contentType: 'ARTICLE',
  };
  const delivery = await fixture.manager.createDelivery(request);
  fixture.statusQueue.push({
    status: 'polled',
    upstreamStatus: 200,
    official: { groupId: 'group-1', status: 'publishing', targets: [
      { accountId: 'a1', status: 'success' },
      { accountId: 'a2', status: 'cancelled' },
    ] },
  });
  const partialCancelled = await fixture.manager.getDelivery(delivery.deliveryId);
  assert.equal(partialCancelled.state, 'partial_cancelled');
  assert.equal(partialCancelled.targets[0].status, 'success');
  assert.equal(partialCancelled.targets[1].status, 'cancelled');

  const failedFixture = await makeManager(makeFixture({
    accounts: [
      { id: 'a1', platform: 'wechat', isLoggedIn: true },
      { id: 'a2', platform: 'wechat', isLoggedIn: true },
    ],
  }));
  const failedManifest = await failedFixture.manager.createAssets('manifest-1', {
    schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION,
    cover: FIXTURE_COVER,
  });
  const failedDelivery = await failedFixture.manager.createDelivery({ ...request, deliveryManifestId: failedManifest.deliveryManifestId });
  failedFixture.statusQueue.push({
    status: 'polled',
    upstreamStatus: 200,
    official: { groupId: 'group-1', status: 'publishing', targets: [
      { accountId: 'a1', status: 'failed' },
      { accountId: 'a2', status: 'cancelled' },
    ] },
  });
  const partialFailed = await failedFixture.manager.getDelivery(failedDelivery.deliveryId);
  assert.equal(partialFailed.state, 'partial_failed');
});

test('stale text blocks delivery, persisted events recover, and tokens never enter delivery output', async () => {
  const token = 'embedded-delivery-secret';
  const fixture = await makeManager({
    ...makeFixture({ publishError: new MultiPostAdapterError(502, 'multipost_upstream_failed', `upstream ${token}`, { nested: { token } }) }),
  });
  const packageManifest = await fixture.manager.createAssets('manifest-1', {
    schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION,
    cover: FIXTURE_COVER,
  });
  const changed = textManifest({ text: '# 已修改正文', title: '一篇文章' });
  fixture.contentStore.replace(changed);
  await assert.rejects(
    () => fixture.manager.createDelivery({
      schemaVersion: DELIVERY_REQUEST_SCHEMA_VERSION,
      deliveryManifestId: packageManifest.deliveryManifestId,
      accountIds: ['a1'],
      contentType: 'ARTICLE',
    }),
    (error) => error.code === 'delivery_manifest_stale' && error.status === 409,
  );
  assert.equal(fixture.calls.publish.length, 0);

  // Restore the source to exercise the upstream error path and check the
  // append-only store has no credential-bearing fields.
  fixture.contentStore.replace(fixture.manifest);
  const requestBody = {
    schemaVersion: DELIVERY_REQUEST_SCHEMA_VERSION,
    deliveryManifestId: packageManifest.deliveryManifestId,
    accountIds: ['a1'],
    contentType: 'ARTICLE',
  };
  await assert.rejects(() => fixture.manager.createDelivery(requestBody), (error) => error.code === 'multipost_upstream_failed');
  const events = await fixture.deliveryStore.readEvents();
  assert.equal(JSON.stringify(events).includes(token), false);
  const recovered = createMultiPostDeliveryManager({
    contentStore: fixture.contentStore,
    adapter: fixture.adapter,
    deliveryStore: createDeliveryStore({ filePath: fixture.deliveryStore.filePath }),
  });
  const listed = await recovered.listDeliveries();
  assert.equal(listed.length, 1);
  assert.equal(JSON.stringify(listed).includes(token), false);
});

test('definite prefill 4xx failures require an explicit retry and preserve the failed attempt', async () => {
  const token = 'prefill-token';
  const fixture = await makeManager({
    ...makeFixture({ publishError: new MultiPostAdapterError(422, 'multipost_account_not_found', `account rejected ${token}`, { nested: token }) }),
  });
  const packageManifest = await fixture.manager.createAssets('manifest-1', {
    schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION,
    cover: FIXTURE_COVER,
  });
  const requestBody = {
    schemaVersion: DELIVERY_REQUEST_SCHEMA_VERSION,
    deliveryManifestId: packageManifest.deliveryManifestId,
    accountIds: ['a1'],
    contentType: 'ARTICLE',
  };
  await assert.rejects(() => fixture.manager.createDelivery(requestBody), (error) => error.code === 'multipost_account_not_found');
  const failedList = await fixture.manager.listDeliveries();
  assert.equal(failedList.length, 1);
  assert.equal(failedList[0].state, 'failed');
  assert.equal(failedList[0].groupId, null);
  await assert.rejects(
    () => fixture.manager.retryPrefillDelivery(failedList[0].deliveryId, {
      confirm: true,
      expectedDeliveryManifestId: packageManifest.deliveryManifestId,
      expectedGroupId: 'must-be-rejected',
    }),
    (error) => error.code === 'delivery_invalid' && error.status === 400,
  );
  fixture.adapter.publish = async (payload) => {
    fixture.calls.publish.push(clone(payload));
    return {
      status: 'accepted',
      upstreamStatus: 202,
      official: { groupId: 'group-retry', status: { status: 'preparing', targets: [{ platform: 'wechat', accountId: 'a1', status: 'pending' }] } },
    };
  };
  const retried = await fixture.manager.retryPrefillDelivery(failedList[0].deliveryId, {
    confirm: true,
    expectedDeliveryManifestId: packageManifest.deliveryManifestId,
  });
  assert.notEqual(retried.deliveryId, failedList[0].deliveryId);
  assert.equal(retried.attemptOfDeliveryId, failedList[0].deliveryId);
  assert.equal(retried.groupId, 'group-retry');
  assert.equal((await fixture.manager.listDeliveries()).length, 2);
  const repeatedRetry = await fixture.manager.retryPrefillDelivery(failedList[0].deliveryId, {
    confirm: true,
    expectedDeliveryManifestId: packageManifest.deliveryManifestId,
  });
  assert.equal(repeatedRetry.deliveryId, retried.deliveryId);
  assert.equal(fixture.calls.publish.length, 2);
  assert.equal(JSON.stringify(await fixture.deliveryStore.readEvents()).includes(token), false);
});

test('uncertain prefill response is persisted as unknown and cannot be retried', async () => {
  const fixture = await makeManager({
    ...makeFixture({ publishError: new MultiPostAdapterError(503, 'multipost_unavailable', 'desktop timeout') }),
  });
  const packageManifest = await fixture.manager.createAssets('manifest-1', {
    schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION,
    cover: FIXTURE_COVER,
  });
  const requestBody = {
    schemaVersion: DELIVERY_REQUEST_SCHEMA_VERSION,
    deliveryManifestId: packageManifest.deliveryManifestId,
    accountIds: ['a1'],
    contentType: 'ARTICLE',
  };
  await assert.rejects(() => fixture.manager.createDelivery(requestBody), (error) => error.code === 'multipost_unavailable');
  const [unknown] = await fixture.manager.listDeliveries();
  assert.equal(unknown.state, 'prefill_unknown');
  assert.equal(unknown.error.code, 'delivery_prefill_unknown');
  const statusCallsBeforeRefresh = fixture.calls.status.length;
  const refreshed = await fixture.manager.getDelivery(unknown.deliveryId);
  assert.equal(refreshed.state, 'prefill_unknown');
  assert.equal(fixture.calls.status.length, statusCallsBeforeRefresh);
  await assert.rejects(
    () => fixture.manager.retryPrefillDelivery(unknown.deliveryId, {
      confirm: true,
      expectedDeliveryManifestId: packageManifest.deliveryManifestId,
    }),
    (error) => error.code === 'delivery_not_ready' && error.status === 409,
  );
});

test('submit intent is serialized, response loss is unknown, and restart never resubmits', async () => {
  const fixture = await makeManager();
  const packageManifest = await fixture.manager.createAssets('manifest-1', {
    schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION,
    cover: FIXTURE_COVER,
  });
  const requestBody = {
    schemaVersion: DELIVERY_REQUEST_SCHEMA_VERSION,
    deliveryManifestId: packageManifest.deliveryManifestId,
    accountIds: ['a1'],
    contentType: 'ARTICLE',
  };
  const delivery = await fixture.manager.createDelivery(requestBody);
  fixture.statusQueue.push({
    status: 'polled',
    upstreamStatus: 200,
    official: { groupId: 'group-1', status: 'ready', targets: [{ accountId: 'a1', platform: 'wechat', status: 'ready' }] },
  });
  const ready = await fixture.manager.getDelivery(delivery.deliveryId);
  assert.equal(ready.state, 'ready_to_submit');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  fixture.adapter.submit = async (groupId) => {
    fixture.calls.submit.push(groupId);
    await gate;
    throw new MultiPostAdapterError(503, 'multipost_unavailable', 'response lost after request');
  };
  const expected = { confirm: true, expectedGroupId: 'group-1', expectedDeliveryManifestId: packageManifest.deliveryManifestId };
  const first = fixture.manager.submitDelivery(delivery.deliveryId, expected);
  await waitForEvent(fixture.deliveryStore, 'submit_requested');
  const second = await fixture.manager.submitDelivery(delivery.deliveryId, expected);
  assert.equal(second.state, 'submitting');
  assert.equal(fixture.calls.submit.length, 1);
  const statusCallsWhileSubmitting = fixture.calls.status.length;
  const stillSubmitting = await fixture.manager.getDelivery(delivery.deliveryId);
  assert.equal(stillSubmitting.state, 'submitting');
  assert.equal(fixture.calls.status.length, statusCallsWhileSubmitting);
  release();
  await assert.rejects(first, (error) => error.code === 'multipost_unavailable');
  const unknown = await fixture.manager.getDelivery(delivery.deliveryId, { poll: false });
  assert.equal(unknown.state, 'submit_unknown');
  assert.equal(fixture.calls.submit.length, 1);
  let restartedCalls = 0;
  let restartedStatusCalls = 0;
  const restartedAdapter = {
    ...fixture.adapter,
    async submit() { restartedCalls += 1; throw new Error('must not submit after unknown'); },
    async publishStatus(groupId) {
      restartedStatusCalls += 1;
      return { status: 'polled', upstreamStatus: 200, official: { groupId, status: 'success', targets: [{ accountId: 'a1', platform: 'wechat', status: 'success' }] } };
    },
  };
  const restarted = createMultiPostDeliveryManager({
    contentStore: fixture.contentStore,
    adapter: restartedAdapter,
    deliveryStore: createDeliveryStore({ filePath: fixture.deliveryStore.filePath }),
  });
  const afterRestartSubmit = await restarted.submitDelivery(delivery.deliveryId, expected);
  assert.equal(afterRestartSubmit.state, 'submit_unknown');
  assert.equal(restartedCalls, 0);
  const recovered = await restarted.getDelivery(delivery.deliveryId);
  assert.equal(recovered.state, 'submit_unknown');
  assert.equal(restartedStatusCalls, 0);
});

test('submit intent remains owned when a same-delivery poll event follows its CAS append', async () => {
  const fixture = makeFixture();
  await ensureFixtureAssets();
  const directory = await tempDirectory();
  const baseStore = createDeliveryStore({ filePath: path.join(directory, 'multipost-deliveries.v1.json') });
  let injected = false;
  const deliveryStore = {
    filePath: baseStore.filePath,
    readEvents: (...args) => baseStore.readEvents(...args),
    append: async (event) => {
      const result = await baseStore.append(event);
      if (!injected && event.type === 'submit_requested') {
        injected = true;
        await baseStore.append({
          type: 'status_polled',
          deliveryId: event.deliveryId,
          groupId: event.groupId,
          state: 'submitting',
          targets: [{ accountId: 'a1', platform: 'wechat', status: 'ready' }],
          upstreamStatus: 200,
        });
      }
      return result;
    },
  };
  const manager = createMultiPostDeliveryManager({
    contentStore: fixture.contentStore,
    adapter: fixture.adapter,
    deliveryStore,
    assetSnapshotRoot: path.join(directory, 'delivery-assets'),
  });
  const packageManifest = await manager.createAssets('manifest-1', {
    schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION,
    cover: FIXTURE_COVER,
  });
  const delivery = await manager.createDelivery({
    schemaVersion: DELIVERY_REQUEST_SCHEMA_VERSION,
    deliveryManifestId: packageManifest.deliveryManifestId,
    accountIds: ['a1'],
    contentType: 'ARTICLE',
  });
  fixture.statusQueue.push({
    status: 'polled',
    upstreamStatus: 200,
    official: { groupId: 'group-1', status: 'ready', targets: [{ accountId: 'a1', status: 'ready' }] },
  });
  const ready = await manager.getDelivery(delivery.deliveryId);
  assert.equal(ready.state, 'ready_to_submit');
  const submitted = await manager.submitDelivery(delivery.deliveryId, {
    confirm: true,
    expectedGroupId: 'group-1',
    expectedDeliveryManifestId: packageManifest.deliveryManifestId,
  });
  assert.equal(submitted.state, 'submitted_pending');
  assert.equal(fixture.calls.submit.length, 1);
  const events = await baseStore.readEvents();
  const intentIndex = events.findIndex((event) => event.type === 'submit_requested');
  const pollIndex = events.findIndex((event, index) => index > intentIndex && event.type === 'status_polled');
  assert.ok(intentIndex >= 0 && pollIndex > intentIndex);
});

test('target retry intent is serialized, response loss is unknown, and restart does not retry', async () => {
  const fixture = await makeManager(makeFixture({
    accounts: [
      { id: 'a1', platform: 'wechat', isLoggedIn: true },
      { id: 'a2', platform: 'wechat', isLoggedIn: true },
    ],
  }));
  const packageManifest = await fixture.manager.createAssets('manifest-1', {
    schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION,
    cover: FIXTURE_COVER,
  });
  const requestBody = {
    schemaVersion: DELIVERY_REQUEST_SCHEMA_VERSION,
    deliveryManifestId: packageManifest.deliveryManifestId,
    accountIds: ['a1', 'a2'],
    contentType: 'ARTICLE',
  };
  const delivery = await fixture.manager.createDelivery(requestBody);
  fixture.statusQueue.push({
    status: 'polled',
    upstreamStatus: 200,
    official: { groupId: 'group-1', status: 'publishing', targets: [
      { accountId: 'a1', platform: 'wechat', status: 'failed' },
      { accountId: 'a2', platform: 'wechat', status: 'failed' },
    ] },
  });
  const failed = await fixture.manager.getDelivery(delivery.deliveryId);
  assert.equal(failed.targets.length, 2);
  assert.equal(failed.targets[0].status, 'failed');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  fixture.adapter.retryTarget = async (groupId, accountId) => {
    fixture.calls.retry.push([groupId, accountId]);
    await gate;
    throw new MultiPostAdapterError(503, 'multipost_unavailable', 'response lost after retry');
  };
  const expected = { expectedGroupId: 'group-1', expectedDeliveryManifestId: packageManifest.deliveryManifestId };
  const first = fixture.manager.retryDeliveryTarget(delivery.deliveryId, 'a1', expected);
  await waitForEvent(fixture.deliveryStore, 'target_retry_requested');
  const second = await fixture.manager.retryDeliveryTarget(delivery.deliveryId, 'a1', expected);
  assert.equal(second.state, 'retrying');
  const otherWhileRetrying = await fixture.manager.retryDeliveryTarget(delivery.deliveryId, 'a2', expected);
  assert.equal(otherWhileRetrying.state, 'retrying');
  assert.equal(fixture.calls.retry.length, 1);
  const statusCallsWhileRetrying = fixture.calls.status.length;
  const stillRetrying = await fixture.manager.getDelivery(delivery.deliveryId);
  assert.equal(stillRetrying.state, 'retrying');
  assert.equal(fixture.calls.status.length, statusCallsWhileRetrying);
  release();
  await assert.rejects(first, (error) => error.code === 'multipost_unavailable');
  const unknown = await fixture.manager.getDelivery(delivery.deliveryId, { poll: false });
  assert.equal(unknown.state, 'target_retry_unknown');
  let restartedCalls = 0;
  let restartedStatusCalls = 0;
  const restartedAdapter = {
    ...fixture.adapter,
    async retryTarget() { restartedCalls += 1; throw new Error('must not retry after unknown'); },
    async publishStatus(groupId) {
      restartedStatusCalls += 1;
      return { status: 'polled', upstreamStatus: 200, official: { groupId, status: 'success', targets: [
        { accountId: 'a1', platform: 'wechat', status: 'success' },
        { accountId: 'a2', platform: 'wechat', status: 'success' },
      ] } };
    },
  };
  const restarted = createMultiPostDeliveryManager({
    contentStore: fixture.contentStore,
    adapter: restartedAdapter,
    deliveryStore: createDeliveryStore({ filePath: fixture.deliveryStore.filePath }),
  });
  const afterRestartRetry = await restarted.retryDeliveryTarget(delivery.deliveryId, 'a1', expected);
  assert.equal(afterRestartRetry.state, 'target_retry_unknown');
  const otherAccount = await restarted.retryDeliveryTarget(delivery.deliveryId, 'a2', expected);
  assert.equal(otherAccount.state, 'target_retry_unknown');
  assert.equal(restartedCalls, 0);
  const recovered = await restarted.getDelivery(delivery.deliveryId);
  assert.equal(recovered.state, 'target_retry_unknown');
  assert.equal(restartedStatusCalls, 0);
});

test('Bridge delivery routes expose CORS, immutable manifests, and unknown publish routes stay 404', async () => {
  const fixture = await makeManager();
  await withBridge({ deliveryManager: fixture.manager, multiPostAdapter: fixture.adapter }, async (port) => {
    const created = await httpJson(port, '/v1/exports/manifest-1/assets', {
      method: 'POST',
      body: { schemaVersion: ASSET_BUNDLE_SCHEMA_VERSION, cover: FIXTURE_COVER },
    });
    assert.equal(created.status, 200);
    const packageManifest = created.body;
    const manifest = await httpJson(port, `/v1/delivery-manifests/${packageManifest.deliveryManifestId}`);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.body.deliveryManifestId, packageManifest.deliveryManifestId);
    assert.equal(manifest.raw.includes('embedded-delivery-secret'), false);
    const requestBody = {
      schemaVersion: DELIVERY_REQUEST_SCHEMA_VERSION,
      deliveryManifestId: packageManifest.deliveryManifestId,
      accountIds: ['a1'],
      contentType: 'ARTICLE',
    };
    const delivery = await httpJson(port, '/v1/integrations/multipost/deliveries', { method: 'POST', body: requestBody });
    assert.equal(delivery.status, 200);
    assert.equal(delivery.body.state, 'awaiting_ready');
    const listed = await httpJson(port, '/v1/integrations/multipost/deliveries');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.schemaVersion, DELIVERY_LIST_SCHEMA_VERSION);
    assert.equal(listed.body.deliveries.length, 1);
    const options = await httpJson(port, '/v1/integrations/multipost/deliveries', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3000' },
    });
    assert.equal(options.status, 204);
    assert.match(options.headers['access-control-allow-methods'] ?? '', /GET,POST,OPTIONS/);
    const unknown = await httpJson(port, '/v1/integrations/multipost/publish', { method: 'POST', body: {} });
    assert.equal(unknown.status, 404);
    const malformed = await httpJson(port, '/v1/integrations/multipost/deliveries', {
      method: 'POST',
      body: '{"schemaVersion":',
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.code, 'invalid_json');
  });
});
