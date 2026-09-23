import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './orchestrator.mjs';
import { sampleInput } from './sample-data.mjs';

export * from './orchestrator.mjs';
export * from './sample-data.mjs';
export * from './lib/primitives.mjs';
export * from './contracts/brief.mjs';
export * from './contracts/evidence-packet.mjs';
export * from './contracts/argument-map.mjs';
export * from './contracts/draft.mjs';
export * from './contracts/annotation-set.mjs';
export * from './contracts/review-report.mjs';
export * from './contracts/wechat-package.mjs';
export * from './contracts/style-profile.mjs';
export * from './contracts/writer.mjs';
export * from './contracts/research-session.mjs';
export * from './adapters/bridge-research.mjs';
export * from './adapters/style-profile-loader.mjs';
export * from './adapters/evidence-writer.mjs';
export * from './adapters/bridge-writer.mjs';
export * from './adapters/codex-writer.mjs';
export * from './lib/research-session-store.mjs';
export * from './lib/workspace-store.mjs';
export * from './export/word-exporter.mjs';

// `npm run sample` prints a compact, deterministic smoke result. Importing the
// module remains side-effect free for the HTTP server and test suite.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const result = runPipeline(sampleInput);
  console.log(
    JSON.stringify(
      {
        briefId: result.brief.briefId,
        packetId: result.evidencePacket.packetId,
        mapId: result.argumentMap.mapId,
        draftId: result.draft.draftId,
        revision: result.draft.revision,
        reviewStatus: result.reviewReport.status,
        packageStatus: result.wechatPackage.status,
        packageId: result.wechatPackage.packageId,
        contentHash: result.wechatPackage.contentHash,
      },
      null,
      2,
    ),
  );
}
