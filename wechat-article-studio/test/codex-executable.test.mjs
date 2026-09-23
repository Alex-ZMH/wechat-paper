import test from 'node:test';
import assert from 'node:assert/strict';

import { ContractError } from '../src/lib/primitives.mjs';
import { resolveCodexExecutable } from '../src/lib/codex-executable.mjs';

test('Windows PATH resolution selects codex.exe without a shell shim', () => {
  const result = resolveCodexExecutable({
    platform: 'win32',
    env: { Path: 'C:\\tools;C:\\other' },
    existsImpl: (value) => value === 'C:\\tools\\codex.exe',
  });
  assert.equal(result.command, 'C:\\tools\\codex.exe');
  assert.equal(result.source, 'PATH:codex.exe');
});

test('an explicit missing executable fails closed instead of falling back', () => {
  assert.throws(
    () => resolveCodexExecutable({
      platform: 'win32',
      env: { CODEX_BIN: 'C:\\missing\\codex.exe', Path: 'C:\\tools' },
      existsImpl: () => false,
    }),
    (error) => error instanceof ContractError
      && error.code === 'writer_unavailable'
      && error.details.source === 'env:CODEX_BIN',
  );
});

test('an explicit bare command resolves through PATH and keeps its source', () => {
  const result = resolveCodexExecutable({
    platform: 'win32',
    env: { CODEX_BIN: 'codex', Path: 'C:\\tools' },
    existsImpl: (value) => value === 'C:\\tools\\codex.exe',
  });
  assert.equal(result.command, 'C:\\tools\\codex.exe');
  assert.equal(result.source, 'env:CODEX_BIN');
});

test('non-Windows resolution uses codex from PATH', () => {
  const result = resolveCodexExecutable({
    platform: 'linux',
    env: { PATH: '/usr/local/bin:/usr/bin' },
    existsImpl: (value) => value === '/usr/local/bin/codex',
  });
  assert.equal(result.command, '/usr/local/bin/codex');
  assert.equal(result.source, 'PATH:codex');
});

