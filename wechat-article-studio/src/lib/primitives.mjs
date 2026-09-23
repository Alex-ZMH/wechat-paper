import { createHash } from 'node:crypto';

/**
 * Error raised when a contract cannot be constructed or consumed safely.
 * The stable `code` is intentionally machine readable so a future UI/API can
 * map failures to actionable repair steps without parsing error strings.
 */
export class ContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
    this.details = details;
  }
}

export function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContractError('invalid_text', `${field} must be a non-empty string`, { field });
  }
  return value.trim();
}

export function optionalText(value, field, fallback = '') {
  if (value == null || value === '') return fallback;
  return requiredText(value, field);
}

export function ensureArray(value, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new ContractError('invalid_array', `${field} must be an array`, { field });
  }
  return value;
}

export function ensureFiniteNumber(value, field, fallback = 0) {
  const candidate = value == null ? fallback : value;
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    throw new ContractError('invalid_number', `${field} must be a finite number`, { field });
  }
  return candidate;
}

export function unique(values) {
  return [...new Set(values)];
}

export function assertUnique(values, field) {
  const duplicate = values.find((value, index) => values.indexOf(value) !== index);
  if (duplicate !== undefined) {
    throw new ContractError('duplicate_id', `${field} contains duplicate value: ${duplicate}`, {
      field,
      duplicate,
    });
  }
}

export function assertOneOf(value, field, choices) {
  if (!choices.includes(value)) {
    throw new ContractError('invalid_enum', `${field} must be one of: ${choices.join(', ')}`, {
      field,
      choices,
      value,
    });
  }
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

/** JSON serialization with sorted object keys for deterministic hashes. */
export function stableStringify(value) {
  const canonical = canonicalize(value);
  const serialized = JSON.stringify(canonical);
  if (serialized === undefined) {
    throw new ContractError('unserializable_value', 'Contract value cannot be serialized deterministically');
  }
  return serialized;
}

export function sha256(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function makeId(prefix, value) {
  return `${prefix}_${sha256(value).slice(0, 12)}`;
}

export function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function freezeContract(value) {
  return deepFreeze(value);
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function normalizeForDuplicate(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('zh-CN');
}

export function assertContractVersion(value, field, expected) {
  if (!value || value.schemaVersion !== expected) {
    throw new ContractError('schema_mismatch', `${field} must use ${expected}`, {
      field,
      expected,
      received: value?.schemaVersion,
    });
  }
}

