import { HTTPError, integer } from './errors.js';
import { tests } from './tests/index.js';
import { testId, jobKey } from './test-id.js';

export class Engine {
  constructor(store, gateway, { now = Date.now, automatic = true, fingerprint } = {}) {
    this.fingerprint = fingerprint; this.store = store; this.gateway = gateway; this.now = now;
    this.jobs = new Map(); this.queue = []; this.running = 0; this.closed = false;
    store.repair(now());
    if (automatic) this.timer = setInterval(() => this.tick(), 1000);
  }
  save(model, input, catalogEntry) {
    const type = testId(input.testId);
    const old = this.store.config(model, type);
    if (!catalogEntry && !old) throw new HTTPError(400, '请从模型目录选择有效模型');
    const rawInterval = Object.hasOwn(input, 'intervalMinutes') ? input.intervalMinutes : old?.intervalMinutes ?? (type === 'milk' ? 30 : null);
    const intervalMinutes = rawInterval === null && type === 'fingerprint' ? null : integer(rawInterval, 1, 43200, '间隔');
    const timeoutSeconds = integer(input.timeoutSeconds ?? old?.timeoutSeconds ?? 300, 10, 3600, '超时');
    const enabled = input.enabled ?? old?.enabled ?? false;
    if (typeof enabled !== 'boolean') throw new HTTPError(400, '自动测试开关无效');
    if (enabled && intervalMinutes === null) throw new HTTPError(400, '请先设置指纹检测间隔');
    const effort = input.effort ?? old?.effort ?? '';
    const efforts = catalogEntry?.efforts || old?.efforts || [];
    if (typeof effort !== 'string' || (effort && !efforts.includes(effort))) throw new HTTPError(400, '该模型不支持所选推理强度');
    const nextAt = enabled ? old?.enabled && old.intervalMinutes === intervalMinutes ? old.nextAt : this.now() + intervalMinutes * 60000 : null;
    const saved = this.store.saveConfig({ model, testId: type, name: catalogEntry?.name || old?.name || model, efforts, enabled, intervalMinutes, timeoutSeconds, effort, nextAt });
    const other = type === 'milk' ? 'fingerprint' : 'milk';
    if (!this.store.config(model, other)) this.store.saveConfig({ ...saved, testId: other, enabled: false, intervalMinutes: other === 'milk' ? 30 : null, effort: '', timeoutSeconds: 300, nextAt: null });
    return saved;
  }
  enqueue(model, source = 'manual', type = 'milk') {
    if (this.closed) throw new HTTPError(503, '检测服务正在停止');
    type = testId(type);
    const key = jobKey(model, type);
    const config = this.store.config(model, type);
    if (!config) throw new HTTPError(404, '模型配置不存在');
    if (this.jobs.has(key)) throw new HTTPError(409, '该模型已有排队或执行中的测试');
    const test = type === 'milk' ? tests.get('milk') : { id: 'fingerprint', name: '模型指纹', promptVersion: 'number-challenge-v1', ruleVersion: 'lmfpd-sdk-0.2.0' };
    const snapshot = { ...config, testId: test.id, testName: test.name, prompt: test.prompt, promptVersion: test.promptVersion, ruleVersion: test.ruleVersion, expected: test.expected, ...(type === 'milk' ? { maxTokens: 8192 } : {}) };
    const record = this.store.create(snapshot, source, this.now());
    const job = { id: record.id, key, testId: type, model, snapshot, test, controller: new AbortController() };
    this.jobs.set(key, job); this.queue.push(job);
    if (config.enabled) this.store.saveConfig({ ...config, nextAt: this.now() + config.intervalMinutes * 60000 });
    this.pump();
    return this.store.detail(record.id);
  }
  pump() {
    while (!this.closed && this.running < 2 && this.queue.length) {
      const index = this.queue.findIndex(candidate => ![...this.jobs.values()].some(j => j.promise && j.model === candidate.model));
      if (index < 0) break;
      const [job] = this.queue.splice(index, 1);
      if (job.controller.signal.aborted) continue;
      this.running++; job.promise = true; job.promise = this.run(job);
    }
  }
  async run(job) {
    this.store.start(job.id, this.now());
    const timer = setTimeout(() => { job.timedOut = true; job.controller.abort(); }, job.snapshot.timeoutSeconds * 1000);
    try {
      if (job.testId === 'fingerprint') {
        if (!this.fingerprint) throw new Error('指纹检测未就绪');
        const evidence = await this.fingerprint.run(job.snapshot, job.controller.signal, value => this.store.evidence(job.id, value));
        job.controller.signal.throwIfAborted();
        this.store.finish(job.id, { state: evidence.error ? 'error' : 'completed', error: evidence.error, automatic: { result: 'unknown', reason: '指纹候选排名' } }, this.now());
        return;
      }
      const answer = await this.gateway.call(job.snapshot, job.controller.signal);
      if (job.controller.signal.aborted) throw new Error('测试已取消');
      this.store.finish(job.id, { answer, automatic: job.test.grade(answer) }, this.now());
    } catch (error) {
      const message = job.timedOut ? '模型调用超时' : job.controller.signal.aborted ? '测试已取消' : this.gateway.redact(error);
      this.store.finish(job.id, { state: job.timedOut ? 'error' : job.controller.signal.aborted ? 'cancelled' : 'error', error: message, answer: error.answer || '' }, this.now());
    } finally {
      clearTimeout(timer); this.jobs.delete(job.key); this.running--;
      const config = this.store.config(job.model, job.testId);
      if (config?.enabled && config.nextAt <= this.now()) this.store.saveConfig({ ...config, nextAt: this.now() + config.intervalMinutes * 60000 });
      this.pump();
    }
  }
  tick() {
    if (this.closed) return;
    for (const config of this.store.configs()) {
      if (config.enabled && config.nextAt <= this.now() && !this.jobs.has(jobKey(config.model, config.testId))) {
        try { this.enqueue(config.model, 'scheduled', config.testId); }
        catch (e) { console.error('调度失败：', this.gateway.redact(e)); }
      }
    }
  }
  remove(model) {
    for (const job of [...this.jobs.values()].filter(j => j.model === model)) {
      job.controller.abort();
      if (!job.promise) {
        this.queue = this.queue.filter(j => j !== job); this.jobs.delete(job.key);
        this.store.finish(job.id, { state: 'cancelled', error: '模型配置已移除' }, this.now());
      }
    }
    this.store.deleteConfig(model);
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    for (const job of this.jobs.values()) job.controller.abort();
    for (const job of this.queue) this.store.finish(job.id, { state: 'interrupted', error: '检测服务已停止' }, this.now());
    this.queue = [];
    await Promise.allSettled([...this.jobs.values()].map(j => j.promise).filter(Boolean));
    this.jobs.clear();
  }
}
