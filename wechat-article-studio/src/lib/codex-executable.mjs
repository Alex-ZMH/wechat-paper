import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

import { ContractError } from './primitives.mjs';

// The desktop host may expose the authenticated Codex binary through one of
// these variables. An explicit value always wins; a missing explicit binary
// is an actionable error and must not silently fall back to another command.
const EXPLICIT_ENV_KEYS = ['CODEX_BIN', 'SINGLE_AGENT_TESTER_CODEX_BIN'];

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function pathApi(platform) {
  return platform === 'win32' ? win32 : posix;
}

function hasPathPart(command, platform) {
  return pathApi(platform).isAbsolute(command) || command.includes('\\') || command.includes('/');
}

function candidatesFor(command, platform) {
  const trimmed = command.trim();
  if (hasPathPart(trimmed, platform) || /\.[A-Za-z0-9]+$/.test(trimmed)) return [trimmed];
  if (platform === 'win32') return [`${trimmed}.exe`, `${trimmed}.cmd`, `${trimmed}.bat`, trimmed];
  return [trimmed];
}

function pathEntries(env, platform) {
  const value = env?.Path ?? env?.PATH ?? '';
  const separator = platform === 'win32' ? ';' : ':';
  return String(value)
    .split(separator)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    // An empty PATH entry means the current directory for command lookup.
    .map((entry) => entry || process.cwd());
}

function findOnPath(command, { env, platform, existsImpl }) {
  const joinPath = pathApi(platform).join;
  for (const directory of pathEntries(env, platform)) {
    for (const candidate of candidatesFor(command, platform)) {
      const fullPath = joinPath(directory, candidate);
      try {
        if (existsImpl(fullPath)) return fullPath;
      } catch {
        // A malformed PATH entry should not make resolution itself crash.
      }
    }
  }
  return null;
}

function unavailable(message, details = {}) {
  return new ContractError('writer_unavailable', message, details);
}

/**
 * Resolve a real Codex executable without invoking a shell.
 *
 * On Windows the default search uses codex.exe. A `codex.cmd` value is only
 * honored when explicitly configured; callers still receive the exact path
 * and source in diagnostics.
 */
export function resolveCodexExecutable({
  env = process.env,
  platform = process.platform,
  existsImpl = existsSync,
} = {}) {
  for (const key of EXPLICIT_ENV_KEYS) {
    const configured = env?.[key];
    if (!nonEmpty(configured)) continue;
    const command = configured.trim();
    const found = hasPathPart(command, platform)
      ? (() => {
        try { return existsImpl(command) ? command : null; } catch { return null; }
      })()
      : findOnPath(command, { env, platform, existsImpl });
    if (!found) {
      throw unavailable(`Configured Codex executable was not found: ${command}`, {
        executable: command,
        source: `env:${key}`,
      });
    }
    return { command: found, source: `env:${key}` };
  }

  // A normal PowerShell install exposes codex.exe on PATH. Do not default to
  // codex.cmd: Node's shell-free spawn can reject command shims with EINVAL.
  const commandName = platform === 'win32' ? 'codex.exe' : 'codex';
  const found = findOnPath(commandName, { env, platform, existsImpl });
  if (found) return { command: found, source: `PATH:${commandName}` };

  // Let spawn produce the platform's standard ENOENT when PATH is modified
  // after resolution. This keeps the error honest while retaining a stable
  // command for environments whose executable is provided by the OS lookup.
  return { command: commandName, source: 'default-command' };
}

export const CODEX_EXECUTABLE_ENV_KEYS = Object.freeze([...EXPLICIT_ENV_KEYS]);
