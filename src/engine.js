import { HTTPError, integer } from './errors.js';
import { tests } from './tests/index.js';
import { testId, jobKey } from './test-id.js';
import { modelConfig, automaticMergeSource, testTypes } from './model-config.js';

export class Engine {
  constructor(store, gateway, { now = Date.now, automatic = true, fingerprint } = {}) {
    this.fingerprint = fingerprint; this.store = store; this.gateway = gateway; this.now = now;
    this.jobs = new Map(); this.queue = []; this.running = 0; this.closed = false;
    store.repair(now());
    for (const model of new Set(store.configs().map(c => c.model))) {
      const configs = store.configs().filter(c => c.model === model);
      if (configs.every(c => c.shared)) continue;
      const source = automaticMergeSource(configs);
      if (source) this.merge(model, source.testId);
    }
    if (automatic) this.timer = setInterval(() => this.tick(), 1000);
  }
  save(model, input, catalogEntry) {
    const type = testId(input.testId);
    const old = this.store.config(model, type);
    if (old?.shared) throw new HTTPError(409, '该模型已使用共享配置，请重新加载页面');
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
  modelConfigs(configs = this.store.configs()) {
    return [...new Set(configs.map(c => c.model))].map(model => modelConfig(configs.filter(c => c.model === model)));
  }
  merge(model, sourceType) {
    const configs = this.store.configs().filter(c => c.model === model);
    const source = configs.find(c => c.testId === testId(sourceType));
    if (!source) throw new HTTPError(404, '旧配置不存在');
    const selectedTests = configs.filter(c => c.enabled).map(c => c.testId);
    return this.saveModel(model, { intervalMinutes: source.intervalMinutes ?? 30, timeoutSeconds: source.timeoutSeconds,
      effort: source.effort, enabled: selectedTests.length > 0, selectedTests: selectedTests.length ? selectedTests : ['milk'] },
      null, true, Math.min(...configs.filter(c => c.enabled).map(c => c.nextAt ?? this.now())));
  }
  saveModel(model, input, catalogEntry, merging = false, nextAt) {
    const old = this.modelConfigs().find(c => c.model === model);
    if (old && !old.shared && !merging) {
      return this.store.db.transaction(() => {
        const configs = this.store.configs().filter(c => c.model === model);
        this.merge(model, automaticMergeSource(configs).testId);
        return this.saveModel(model, input, catalogEntry);
      })();
    }
    if (!catalogEntry && !old) throw new HTTPError(400, '请从模型目录选择有效模型');
    const intervalMinutes = integer(input.intervalMinutes ?? (old?.shared ? old.intervalMinutes : 30), 1, 43200, '间隔');
    const timeoutSeconds = integer(input.timeoutSeconds ?? (old?.shared ? old.timeoutSeconds : 300), 10, 3600, '超时');
    const effort = input.effort ?? (old?.shared ? old.effort : '');
    const efforts = catalogEntry?.efforts || old?.efforts || [];
    if (typeof effort !== 'string' || (effort && !efforts.includes(effort))) throw new HTTPError(400, '该模型不支持所选推理强度');
    let selectedTests = input.selectedTests ?? (old?.shared ? old.selectedTests : ['milk']);
    if (Object.hasOwn(input, 'testSelection')) {
      const selection = input.testSelection;
      if (Object.hasOwn(input, 'selectedTests') || !selection || typeof selection !== 'object' || Array.isArray(selection) || Object.entries(selection).some(([type, selected]) => !testTypes.includes(type) || typeof selected !== 'boolean')) throw new HTTPError(400, '检测项目修改无效');
      selectedTests = testTypes.filter(type => selection[type] ?? selectedTests.includes(type));
    }
    if (!Array.isArray(selectedTests) || selectedTests.some(t => !testTypes.includes(t)) || new Set(selectedTests).size !== selectedTests.length)
      throw new HTTPError(400, '检测项目无效');
    let enabled = input.enabled ?? (old?.shared ? old.enabled : false);
    if (typeof enabled !== 'boolean') throw new HTTPError(400, '自动测试开关无效');
    if (!selectedTests.length) enabled = false;
    nextAt = enabled ? Number.isFinite(nextAt) ? nextAt : old?.shared && old.enabled && old.intervalMinutes === intervalMinutes
      ? old.nextAt : this.now() + intervalMinutes * 60000 : null;
    const configs = testTypes.map(type => ({ model, name: catalogEntry?.name || old?.name || model, efforts, testId: type,
      shared: true, selected: selectedTests.includes(type), automaticEnabled: enabled,
      enabled: enabled && selectedTests.includes(type), intervalMinutes, timeoutSeconds, effort,
      nextAt: enabled && selectedTests.includes(type) ? nextAt : null }));
    this.store.saveModelConfigs(configs);
    return modelConfig(configs);
  }
  advanceModel(model) {
    const configs = this.store.configs().filter(c => c.model === model);
    this.store.saveModelConfigs(configs.map(c => ({ ...c, nextAt: c.enabled ? this.now() + c.intervalMinutes * 60000 : null })));
  }
  createJob(model, source, type) {
    const config = this.store.config(model, type);
    if (!config) throw new HTTPError(404, '模型配置不存在');
    const test = type === 'milk' ? tests.get('milk') : { id: 'fingerprint', name: '模型指纹', promptVersion: 'number-challenge-v1', ruleVersion: 'lmfpd-sdk-0.2.0' };
    const snapshot = { ...config, testId: test.id, testName: test.name, prompt: test.prompt, promptVersion: test.promptVersion, ruleVersion: test.ruleVersion, expected: test.expected, ...(type === 'milk' ? { maxTokens: 8192 } : {}) };
    const record = this.store.create(snapshot, source, this.now());
    return { id: record.id, key: jobKey(model, type), testId: type, model, snapshot, test, controller: new AbortController() };
  }
  enqueueSelected(model, source = 'manual') {
    if (this.closed) throw new HTTPError(503, '检测服务正在停止');
    const config = this.modelConfigs().find(c => c.model === model);
    if (!config) throw new HTTPError(404, '模型配置不存在');
    if (!config.shared) throw new HTTPError(409, '请先合并旧配置');
    if (!config.selectedTests.length) throw new HTTPError(400, '请至少选择一个检测项目');
    if ([...this.jobs.values()].some(j => j.model === model)) throw new HTTPError(409, '该模型已有排队或执行中的测试');
    const jobs = this.store.db.transaction(() => {
      const jobs = testTypes.filter(t => config.selectedTests.includes(t)).map(t => this.createJob(model, source, t));
      if (config.enabled) this.advanceModel(model);
      return jobs;
    })();
    for (const job of jobs) { this.jobs.set(job.key, job); this.queue.push(job); }
    this.pump();
    return jobs.map(j => this.store.detail(j.id));
  }
  enqueue(model, source = 'manual', type = 'milk') {
    if (this.closed) throw new HTTPError(503, '检测服务正在停止');
    type = testId(type);
    const key = jobKey(model, type);
    if (this.jobs.has(key)) throw new HTTPError(409, '该模型已有排队或执行中的测试');
    const job = this.createJob(model, source, type), config = job.snapshot;
    this.jobs.set(key, job); this.queue.push(job);
    if (config.enabled) {
      if (config.shared) this.advanceModel(model);
      else this.store.saveConfig({ ...this.store.config(model, type), nextAt: this.now() + config.intervalMinutes * 60000 });
    }
    this.pump();
    return this.store.detail(job.id);
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
      if (config?.shared) {
        if (![...this.jobs.values()].some(j => j.model === job.model)) {
          const plan = this.store.configs().find(c => c.model === job.model && c.enabled);
          if (plan && plan.nextAt <= this.now()) this.advanceModel(job.model);
        }
      } else if (config?.enabled && config.nextAt <= this.now()) this.store.saveConfig({ ...config, nextAt: this.now() + config.intervalMinutes * 60000 });
      this.pump();
    }
  }
  tick() {
    if (this.closed) return;
    for (const config of this.modelConfigs().filter(c => c.shared && c.enabled && c.nextAt <= this.now())) {
      if ([...this.jobs.values()].some(j => j.model === config.model)) continue;
      try { this.enqueueSelected(config.model, 'scheduled'); }
      catch (e) { console.error('调度失败：', this.gateway.redact(e)); }
    }
    for (const config of this.store.configs().filter(c => !c.shared)) {
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
