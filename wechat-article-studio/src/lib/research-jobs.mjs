import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ContractError, sha256 } from './primitives.mjs';

const labels = {
  queued: '正在研究', research: '正在研究', research_retrieval: '正在检索和读取公开资料',
  research_audit: '正在核对来源与论点', research_repair: '正在修正未通过核验的资料',
  research_audit_retry: '正在重新核对修正后的资料', research_recovery: '正在核对已审来源的原文摘录', research_freeze: '正在整理核验结果',
  parsing: '正在检查资料完整性', cancelling: '正在停止资料搜集',
  completed: '资料已搜集并通过核验', failed: '资料搜集未完成', cancelled: '已停止资料搜集',
};
const active = j => ['queued', 'running', 'cancelling'].includes(j.status);

/** A background job survives page reloads; never invents source-audit progress. */
export class ResearchJobStore {
  constructor({ run, dataDir }) {
    this.run = run;
    this.dir = join(dataDir, 'research-jobs');
    this.jobs = new Map();
    mkdirSync(this.dir, { recursive: true });
    try {
      const saved = JSON.parse(readFileSync(join(this.dir, 'jobs.json'), 'utf8'));
      for (const job of saved) {
        if (active(job)) {
          job.status = 'failed'; job.stage = 'failed';
          job.error = { code: 'research_interrupted' };
          job.finishedAt = new Date().toISOString();
        }
        this.jobs.set(job.jobId, job);
      }
    } catch (e) { if (e.code !== 'ENOENT') console.error('Research job history load failed', e); }
  }
  persist() {
    const file = join(this.dir, 'jobs.json');
    writeFileSync(`${file}.tmp`, JSON.stringify([...this.jobs.values()].map(({ controller, promise, ...j }) => j)));
    renameSync(`${file}.tmp`, file);
  }
  trace(job, event) {
    appendFileSync(join(this.dir, `${job.jobId}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), jobId: job.jobId, ...event })}\n`);
  }
  view(job) {
    if (!job) throw new ContractError('research_job_not_found', 'Research job not found');
    return { jobId: job.jobId, workspaceId: job.workspaceId, status: job.status, stage: job.stage,
      message: labels[job.stage] ?? '正在研究', startedAt: job.startedAt,
      updatedAt: job.updatedAt, finishedAt: job.finishedAt, record: job.record ?? null, error: job.error ?? null };
  }
  get(id) { return this.view(this.jobs.get(id)); }
  start(input) {
    const duplicate = [...this.jobs.values()].find(j => active(j));
    if (duplicate) {
      if (duplicate.workspaceId === input.workspaceId && duplicate.requestFingerprint === sha256(input.brief)) return this.view(duplicate);
      throw new ContractError('busy', 'Another research request is active');
    }
    const job = { jobId: randomUUID(), workspaceId: input.workspaceId, requestFingerprint: sha256(input.brief), status: 'queued', stage: 'queued',
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), controller: new AbortController() };
    this.jobs.set(job.jobId, job);
    this.trace(job, { event: 'request_received', brief: input.brief, clientRunId: job.jobId });
    this.persist();
    job.promise = this.execute(job, input);
    return this.view(job);
  }
  async execute(job, input) {
    job.status = 'running';
    try {
      const record = await this.run({ ...input, clientRunId: job.jobId }, {
        signal: job.controller.signal,
        onTrace: event => this.trace(job, event),
        onProgress: progress => {
          if (job.status === 'cancelling') return;
          const stage = typeof progress === 'string' ? progress : progress.stage;
          // Only observed stages are displayed; unknown events don't imply completion.
          if (stage && labels[stage]) job.stage = stage;
          job.updatedAt = new Date().toISOString();
          this.persist();
        },
      });
      if (job.controller.signal.aborted) {
        job.status = 'cancelled'; job.stage = 'cancelled';
        this.trace(job, { event: 'late_result_ignored' });
      } else {
        job.record = record; job.status = 'completed'; job.stage = 'completed';
        this.trace(job, { event: 'source_audited_record_saved', sessionId: record.researchSession?.sessionId });
      }
    } catch (e) {
      job.status = job.controller.signal.aborted ? 'cancelled' : 'failed'; job.stage = job.status;
      job.error = { code: e.code ?? 'research_failed' };
      this.trace(job, { event: 'failed', code: e.code, message: e.message, details: e.details });
    } finally {
      job.finishedAt = new Date().toISOString(); job.updatedAt = job.finishedAt;
      this.persist();
    }
  }
  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return this.get(id);
    if (active(job)) {
      job.status = 'cancelling'; job.stage = 'cancelling';
      this.trace(job, { event: 'user_cancel_requested' });
      job.controller.abort(); this.persist();
    }
    return this.view(job);
  }
}
