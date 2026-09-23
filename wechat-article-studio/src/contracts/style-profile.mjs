import {
  assertUnique,
  ensureArray,
  freezeContract,
  makeId,
  optionalText,
  requiredText,
  sha256,
  ContractError,
} from '../lib/primitives.mjs';

export const STYLE_PROFILE_SCHEMA_VERSION = 'wechat-article-studio.style-profile.v1';

function normalizeSample(sample, index) {
  if (!sample || typeof sample !== 'object') {
    throw new ContractError('invalid_sample', `styleProfile.samples[${index}] must be an object`);
  }
  return {
    sampleId: requiredText(sample.sampleId ?? `style-sample-${index + 1}`, `styleProfile.samples[${index}].sampleId`),
    title: optionalText(sample.title, `styleProfile.samples[${index}].title`),
    text: requiredText(sample.text, `styleProfile.samples[${index}].text`),
  };
}

/** A versioned, human-readable style brief. It constrains voice without hiding the source text. */
export function createStyleProfile(input = {}) {
  const principles = ensureArray(input.principles ?? [], 'styleProfile.principles', { allowEmpty: false })
    .map((value, index) => requiredText(value, `styleProfile.principles[${index}]`));
  const avoid = ensureArray(input.avoid ?? [], 'styleProfile.avoid').map((value, index) => requiredText(value, `styleProfile.avoid[${index}]`));
  const samples = ensureArray(input.samples ?? [], 'styleProfile.samples').map(normalizeSample);
  assertUnique(principles, 'styleProfile.principles');
  assertUnique(avoid, 'styleProfile.avoid');
  assertUnique(samples.map((sample) => sample.sampleId), 'styleProfile.samples.sampleId');

  const core = {
    schemaVersion: STYLE_PROFILE_SCHEMA_VERSION,
    parentIds: [],
    name: requiredText(input.name, 'styleProfile.name'),
    principles,
    avoid,
    samples,
  };
  return freezeContract({
    ...core,
    styleProfileId: makeId('style', core),
    styleProfileHash: sha256(core),
  });
}
