import {
  ensureArray,
  ensureFiniteNumber,
  freezeContract,
  makeId,
  optionalText,
  requiredText,
  sha256,
} from '../lib/primitives.mjs';

export const BRIEF_SCHEMA_VERSION = 'wechat-article-studio.brief.v1';

/**
 * The editorial brief is the single source of intent for the rest of the
 * pipeline. It deliberately contains no provider-specific or AI fields.
 */
export function createBrief(input = {}) {
  const materials = ensureArray(input.materials ?? [], 'brief.materials').map((material, index) => {
    if (typeof material === 'string') {
      return { materialId: `material-${index + 1}`, text: requiredText(material, `brief.materials[${index}]`) };
    }
    return {
      materialId: requiredText(material?.materialId ?? `material-${index + 1}`, `brief.materials[${index}].materialId`),
      text: requiredText(material?.text, `brief.materials[${index}].text`),
    };
  });

  const core = {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    parentIds: [],
    topic: requiredText(input.topic, 'brief.topic'),
    purpose: requiredText(input.purpose, 'brief.purpose'),
    audience: requiredText(input.audience, 'brief.audience'),
    channel: optionalText(input.channel, 'brief.channel', '微信公众号'),
    authorName: optionalText(input.authorName, 'brief.authorName', '公众号编辑部'),
    tone: optionalText(input.tone, 'brief.tone', '清晰、克制、可信'),
    targetLength: Math.round(ensureFiniteNumber(input.targetLength, 'brief.targetLength', 1200)),
    materials,
  };

  return freezeContract({
    ...core,
    briefId: makeId('brief', core),
    briefHash: sha256(core),
  });
}
