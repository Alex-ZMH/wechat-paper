/**
 * Small deterministic fixture used by the CLI, tests, and the local demo
 * server. Replacing this object with real research is intentionally a later
 * integration step; no network or model call happens in this slice.
 */
export const sampleInput = {
  brief: {
    topic: '为什么很多 AI 科普文章读起来像重复的宣传稿',
    purpose: '解释车轱辘话是怎样产生的，并给出一套基于证据、论点和人工批注的写作方法。',
    audience: '关注 AI 但不想只看口号的普通读者',
    channel: '微信公众号',
    authorName: '文章工作台编辑部',
    tone: '清楚、具体、克制',
    targetLength: 900,
    materials: [{ materialId: 'brief-note-1', text: '先搭证据与论点，再进入写作和交付。' }],
  },
  styleProfile: {
    name: '清楚、具体、克制',
    principles: ['先说事实，再说判断', '每一节只推进一个新问题', '用具体例子替代空泛形容词'],
    avoid: ['宏大口号', '同义反复', '没有来源的确定性断言'],
    samples: [{ sampleId: 'style-sample-1', title: '样例段落', text: '先把问题拆成可以核对的主张，再决定文章应该怎样推进。' }],
  },
  evidence: {
    sources: [
      {
        sourceId: 'source-1',
        title: '编辑审读记录：重复表达如何稀释信息密度',
        url: 'https://example.test/editorial-review',
        publisher: 'Studio Research Notes',
        sourceOrigin: 'fixture',
        publishedAt: '2026-01-12',
        excerpt: '当相同意思在多个段落反复出现，读者会感觉文章在改写同一句口号。',
      },
      {
        sourceId: 'source-2',
        title: '事实、推断与建议的三层写作卡片',
        url: 'https://example.test/writing-cards',
        publisher: 'Studio Research Notes',
        sourceOrigin: 'fixture',
        publishedAt: '2026-02-03',
        excerpt: '把事实、推断和行动建议拆成不同层次，编辑更容易逐项核对。',
      },
    ],
    claims: [
      {
        claimId: 'claim-1',
        text: '相同意思在多个段落反复出现，会让读者感觉文章只是在改写口号。',
        evidenceIds: ['source-1'],
        confidence: 0.92,
      },
      {
        claimId: 'claim-2',
        text: '把事实、推断和行动建议分层，可以降低编辑逐项核对的成本。',
        evidenceIds: ['source-2'],
        confidence: 0.9,
      },
    ],
  },
  argumentMap: {
    points: [
      {
        pointId: 'point-1',
        order: 1,
        heading: '先识别重复从哪里开始',
        thesis: '重复不是语气问题，而是同一信息没有被压缩成一个明确主张。',
        claimIds: ['claim-1'],
      },
      {
        pointId: 'point-2',
        order: 2,
        heading: '再把文章拆成可核对的层次',
        thesis: '事实、推断和建议分层后，读者和编辑都能知道每一句话承担什么任务。',
        claimIds: ['claim-2'],
      },
    ],
  },
  draft: {
    title: '别再把 AI 科普写成口号：先做两张卡片',
    digest: '一篇文章是否可信，取决于主张能否被找到、被核对、被修改。',
    lead: '很多文章看上去信息很多，读完却只记住一句“未来已来”。问题往往不在文风，而在写作顺序。',
    sections: [
      {
        sectionId: 'section-symptom',
        order: 1,
        heading: '重复感从哪里来',
        paragraphs: [
          {
            paragraphId: 'paragraph-symptom',
            text: '先看症状：相同意思在多个段落反复出现，读者就会感觉文章只是在改写口号。[claim:claim-1] [source:source-1]',
            claimIds: ['claim-1'],
          },
        ],
      },
      {
        sectionId: 'section-method',
        order: 2,
        heading: '用两张卡片重排文章',
        paragraphs: [
          {
            paragraphId: 'paragraph-method',
            text: '写作时把事实、推断和行动建议分层，编辑就能逐项核对，读者也更容易跟上。[claim:claim-2] [source:source-2]',
            claimIds: ['claim-2'],
          },
        ],
      },
    ],
    closingCta: '下一次动笔前，先为每个主张写下证据，再决定它该出现在哪一段。',
    tags: ['写作方法', 'AI 科普'],
    assetSlots: [{ slotId: 'cover', purpose: '一张表现“证据—论点—正文”关系的封面图', alt: '证据与论点的关系示意' }],
  },
  annotationSet: {
    annotations: [
      {
        annotationId: 'annotation-1',
        kind: 'replace_paragraph',
        targetParagraphId: 'paragraph-method',
        instruction: '把建议写得更像可以马上执行的动作。',
        replacementText: '把事实、推断和行动建议分层，再逐项核对，文章就不必靠重复来制造“信息量”。[claim:claim-2] [source:source-2]',
      },
    ],
  },
};
