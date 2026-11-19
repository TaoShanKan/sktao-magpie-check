import { readFile, writeFile, rename, rm, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadDetector, generateChallenges, buildRequest, parseNumbers } from '../vendor/lmfpd-sdk/index.js';

const DAY = 86400000;
function validateCache(bytes) {
  const length = bytes.readUInt32LE(0), bank = JSON.parse(bytes.subarray(4, 4 + length).toString());
  const digest = createHash('sha256').update(bytes.subarray(4 + length)).digest('hex');
  if (bank.files?.['shared_detector.bin']?.sha256 !== digest) throw new Error('参考库校验失败');
}
function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('已取消'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export const SDK_VERSION = 'lmfpd-sdk-0.2.0';
export class ReferenceBank {
  constructor(dataDir, { source, load = loadDetector, now = Date.now } = {}) {
    this.dir = dataDir; this.cache = join(dataDir, 'reference.bin'); this.meta = join(dataDir, 'reference-state.json');
    this.source = source; this.load = load; this.now = now; this.current = null; this.loading = null; this.closed = false;
    this.lastAttempt = null; this.updatedAt = null; this.error = ''; this.available = false;
    this.ready = this.inspect();
    this.timer = setInterval(() => { void this.daily(); }, 60000); this.timer.unref?.();
  }
  async inspect() {
    this.available = await stat(this.cache).then(() => true, () => false);
    try { const meta = JSON.parse(await readFile(this.meta, 'utf8')); this.lastAttempt = meta.lastAttempt; this.updatedAt = meta.updatedAt; this.error = meta.error || ''; } catch {}
  }
  status() { return { state: this.loading ? 'loading' : this.current || this.available ? 'ready' : 'missing', bank: this.current?.bank || null, lastAttempt: this.lastAttempt, updatedAt: this.updatedAt, error: this.error }; }
  async daily() {
    await this.ready;
    if (!this.closed && (this.available || this.current) && this.now() - (this.lastAttempt || 0) >= DAY) {
      await this.refresh().catch(() => {});
    }
  }
  async ensure() {
    await this.ready;
    if (this.current) return this.current;
    if (this.loading) { await this.loading; if (this.current) return this.current; }
    if (!this.available) return this.refresh();
    this.loading = (async () => {
      try {
        const bytes = await readFile(this.cache); validateCache(bytes);
        const detector = await this.load({ cache: this.cache, ttl: Infinity });
        this.current = { detector, bank: { builtAt: detector.builtAt, id: createHash('sha256').update(bytes).digest('hex') } };
        return this.current;
      } finally { this.loading = null; }
    })();
    try { return await this.loading; }
    catch { return this.refresh(); }
  }

  async refresh() {
    await this.ready;
    if (this.closed) throw new Error('参考库服务已停止');
    if (this.loading) return this.loading;
    this.loading = (async () => {
      this.lastAttempt = this.now();
      const temporary = join(this.dir, `reference-${crypto.randomUUID()}.bin`);
      try {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        const detector = await this.load({ ...(this.source ? { source: this.source } : {}), cache: temporary, ttl: Infinity });
        // SDK validates the bank/detector pair; hashing pins the complete local snapshot.
        let bytes;
        if (this.source && !/^https?:\/\//.test(this.source)) {
          const bankBytes = await readFile(join(this.source, 'unified_bank.json'));
          const header = Buffer.alloc(4); header.writeUInt32LE(bankBytes.length);
          bytes = Buffer.concat([header, bankBytes, await readFile(join(this.source, 'shared_detector.bin'))]);
          await writeFile(temporary, bytes, { mode: 0o600 });
        } else bytes = await readFile(temporary);
        validateCache(bytes);
        const bank = { builtAt: detector.builtAt, id: createHash('sha256').update(bytes).digest('hex') };
        await rename(temporary, this.cache);
        this.current = { detector, bank }; this.available = true; this.updatedAt = this.now(); this.error = '';
        return this.current;
      } catch (e) { this.error = '参考库更新失败，请检查网络或参考数据源'; throw new Error(this.error); }
      finally {
        await rm(temporary, { force: true });
        const temporaryMeta = `${this.meta}.tmp`;
        await writeFile(temporaryMeta, JSON.stringify({ lastAttempt: this.lastAttempt, updatedAt: this.updatedAt, error: this.error }), { mode: 0o600 }).then(() => rename(temporaryMeta, this.meta)).catch(() => {});
        this.loading = null;
      }
    })();
    return this.loading;
  }
  async close() { this.closed = true; clearInterval(this.timer); await this.loading?.catch(() => {}); }
}

export class Fingerprint {
  constructor(bank, gateway) { this.bank = bank; this.gateway = gateway; }
  async run(snapshot, signal, update) {
    const evidence = { sdk: SDK_VERSION, bank: null, challenges: [], samples: [], analysis: null, error: null };
    const publish = () => update(structuredClone(evidence));
    try {
      const reference = await abortable(this.bank.ensure(), signal); signal.throwIfAborted();
      evidence.bank = reference.bank; evidence.challenges = generateChallenges(3);
      evidence.samples = evidence.challenges.map(c => ({ state: 'queued', raw_text: '', text: '', count: 0, expected_count: c.expected_count, request: null, provenance: null, error: null }));
      publish();
      for (let i = 0; i < 3; i++) {
        signal.throwIfAborted();
        const challenge = evidence.challenges[i], sample = evidence.samples[i];
        const request = buildRequest({ baseUrl: `${this.gateway.url}/v1`, apiKey: 'request-builder-placeholder', model: snapshot.model, api: 'chat_completions', effort: snapshot.effort, stream: false, strict: false }, challenge.prompt);
        if (request.error) throw new Error(request.error);
        sample.request = { method: 'POST', path: '/v1/chat/completions', body: request.body };
        sample.state = 'waiting'; publish();
        try {
          const result = await this.gateway.sample(request.body, signal);
          Object.assign(sample, result);
          const numbers = parseNumbers(sample.raw_text);
          sample.count = Math.min(numbers.length, challenge.expected_count);
          sample.text = numbers.length > challenge.expected_count ? numbers.slice(0, challenge.expected_count).join(', ') : sample.raw_text;
          if (sample.count < Math.max(80, Math.ceil(challenge.expected_count * .55))) throw new Error('有效数字样本不足');
          if (!['stop', 'length'].includes(result.finishReason)) throw new Error('回答未正常结束');
          sample.state = result.finishReason === 'length' || numbers.length > challenge.expected_count ? 'truncated' : 'complete';
        } catch (e) {
          sample.state = signal.aborted ? 'cancelled' : 'failed'; sample.error = this.gateway.redact(e);
        }
        publish();
      }
      signal.throwIfAborted();
      if (evidence.samples.some(s => s.provenance?.mismatch)) evidence.error = '实际路由与请求目标不匹配，本轮不评分';
      else {
        const outputs = evidence.samples.filter(s => ['complete', 'truncated'].includes(s.state)).map(s => ({ text: s.text, expected_count: s.expected_count }));
        if (outputs.length) evidence.analysis = reference.detector.analyze(outputs, { strict: false });
        if (!evidence.analysis?.results?.length) evidence.error = evidence.analysis?.evidence?.reason || '没有可用候选，请查看采样证据';
      }
      publish(); return evidence;
    } catch (e) {
      evidence.analysis = null; evidence.error = signal.aborted ? '检测已中断，本轮不评分' : this.gateway.redact(e);
      for (const sample of evidence.samples) if (['queued', 'waiting'].includes(sample.state)) sample.state = 'cancelled';
      publish(); throw e;
    }
  }
}
