import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildWorkflowReceipt, normalizeCodexResponse } from '../server.mjs';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(TEST_DIRECTORY, '..', 'content-response.schema.json');
const REVIEW_SCHEMA_PATH = path.join(TEST_DIRECTORY, '..', 'content-review.schema.json');

function isObjectSchema(schema) {
  return schema && typeof schema === 'object'
    && (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object')));
}

function assertClosedObjectRequirements(schema, location = '$') {
  if (!schema || typeof schema !== 'object') return;
  if (isObjectSchema(schema)) {
    const keys = Object.keys(schema.properties ?? {}).sort();
    const optional = new Set(Array.isArray(schema['x-optional']) ? schema['x-optional'] : []);
    const required = [...(schema.required ?? [])].sort();
    const expected = keys.filter((key) => !optional.has(key)).sort();
    assert.deepEqual(required, expected, `${location} must require every non-optional property exactly once`);
  }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [key, child] of Object.entries(schema.properties)) {
      assert.equal(Object.hasOwn(child, 'type'), true, `${location}.properties.${key} must declare type`);
      assertClosedObjectRequirements(child, `${location}.properties.${key}`);
    }
  }
  if (schema.items) assertClosedObjectRequirements(schema.items, `${location}.items`);
}

test('content response schema is strict at every object and nullable for Bridge-owned fields', async () => {
  const schema = JSON.parse(await fs.readFile(SCHEMA_PATH, 'utf8'));
  assertClosedObjectRequirements(schema);

  assert.equal(schema.required.includes('dnaUsage'), true);
  assert.equal(schema.required.includes('dnaUsages'), true);
  assert.equal(schema.required.includes('workflowReceipt'), true);
  assert.equal(schema.required.includes('reviewAudit'), true);
  assert.equal(schema.properties.diagnostics.required.includes('reviewPasses'), true);
  assert.deepEqual(schema.properties.dnaUsage.type, ['object', 'null']);
  assert.deepEqual(schema.properties.mode.enum, ['initial_generation', 'annotation_regeneration', 'source_rewrite']);
  assert.equal(schema.properties.dnaUsage.required.includes('artifact'), true);
  assert.deepEqual(schema.properties.dnaUsage.properties.artifact.type, ['string', 'null']);
  assert.deepEqual(schema.properties.skillUsage.type, ['object', 'null']);
  assert.equal(schema.properties.skillUsage.properties.chain.items.required.includes('artifact'), true);
  assert.deepEqual(schema.properties.skillUsage.properties.chain.items.properties.artifact.type, ['string', 'null']);
  assert.deepEqual(schema.properties.memoryPromotion.type, ['object', 'null']);
  const workflowNode = schema.properties.workflowReceipt.properties.nodes.items;
  assert.equal(workflowNode.required.includes('outcome'), true);
  assert.deepEqual(workflowNode.properties.outcome.type, ['string', 'null']);
});

test('long-form review schema is standalone, closed, and has no external refs', async () => {
  const schema = JSON.parse(await fs.readFile(REVIEW_SCHEMA_PATH, 'utf8'));
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    'schemaVersion', 'status', 'mode', 'draftHash', 'receipts', 'diagnostics',
    'editorialMemo', 'qualityReview', 'warnings',
  ]);
  const refs = [];
  const walk = (value, location = '$') => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string') {
      refs.push({ location, ref: value.$ref });
      return;
    }
    if (value.type === 'object' && value.properties) {
      assert.equal(value.additionalProperties, false, `${location} must be closed`);
      const required = new Set(value.required ?? []);
      for (const key of Object.keys(value.properties)) {
        assert.equal(required.has(key), true, `${location}.${key} must be required`);
      }
      for (const [key, child] of Object.entries(value.properties)) walk(child, `${location}.${key}`);
    }
    if (value.items) walk(value.items, `${location}.items`);
    if (value.$defs) {
      for (const [key, child] of Object.entries(value.$defs)) walk(child, `${location}.$defs.${key}`);
    }
  };
  walk(schema);
  assert.ok(refs.length > 0, 'local $defs should be used for repeated score dimensions');
  assert.equal(refs.every(({ ref }) => ref.startsWith('#/$defs/')), true, 'review schema must not depend on a second file');
  assert.deepEqual(Object.keys(schema.$defs).sort(), [
    'editorialDimension10', 'editorialDimension20', 'editorialDimension25', 'editorialReasons',
  ]);
});

test('response normalization supplies null for omitted Bridge-owned fields', () => {
  const normalized = normalizeCodexResponse({ schemaVersion: 'codex.bridge.response.v1' });
  assert.deepEqual(normalized, {
    schemaVersion: 'codex.bridge.response.v1',
    dnaUsage: null,
    dnaUsages: null,
    skillUsage: null,
    memoryPromotion: null,
    reviewAudit: null,
    evidencePacketId: null,
    evidencePacketHash: null,
  });
});

test('review-required candidates keep a truthful workflow receipt', () => {
  const payload = {
    mode: 'initial_generation',
    task: '跨站点过程异常的共因分析',
    skillChain: ['industrial-ai-wechat-research-writing'],
  };
  const result = {
    status: 'review_required',
    draft: '先按事件主键合并，再核对跨站点证据。',
    qualityReview: {
      passed: false,
      issues: ['需要人工复核一项指标'],
      editorialScore: { total: 90, threshold: 99 },
    },
  };
  const receipt = buildWorkflowReceipt(payload, result, []);
  assert.ok(receipt);
  const gate = receipt.nodes.find((node) => node.nodeId === 'quality-gate');
  assert.deepEqual(gate, {
    nodeId: 'quality-gate',
    verb: 'evaluated',
    status: 'succeeded',
    outcome: 'review_required',
    artifactHash: gate.artifactHash,
  });
  assert.equal(receipt.nodes.find((node) => node.nodeId === 'final-output').verb, 'committed');
  assert.equal(receipt.nodes.find((node) => node.nodeId === 'final-output').outcome, null);
  assert.equal(receipt.nodes.some((node) => node.verb === 'passed'), false);
});
