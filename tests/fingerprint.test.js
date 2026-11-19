import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { ReferenceBank, Fingerprint, SDK_VERSION } from '../src/fingerprint.js';
import { loadDetector } from '../vendor/lmfpd-sdk/index.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { fixture, waitForRecord } from './helpers.js';

// Minimal internally consistent SDK fixture. Rankings are injected separately,
// since an empty reference bank must never be represented as a real model bank.
function cacheFixture(build = 'fixture') {
  const header = Buffer.from(JSON.stringify({ schema: 'shared-detector-v2', bank_built_at: build, model_ids: [], response_counts: [] }));
  const detector = Buffer.alloc(Math.ceil((header.length + 4) / 4) * 4); detector.writeUInt32LE(header.length); header.copy(detector, 4);
  const bank = Buffer.from(JSON.stringify({ schema: 'lmfpd-data-v1', detector_schema: 'shared-detector-v2', built_at: build, models: [], files: { 'shared_detector.bin': { sha256: createHash('sha256').update(detector).digest('hex'), parts: ['fixture.zst'] } } }));
  const length = Buffer.alloc(4); length.writeUInt32LE(bank.length); return Buffer.concat([length, bank, detector]);
}
const numbers = Array.from({ length: 355 }, (_, i) => ((i * 137) % 355) + 1).join(', ');
function analysis(outputs) { return { decision: outputs.length === 3 ? 'scored' : 'partial', prediction: 'fixture/a', prediction_name: 'Fixture A', probability: outputs.length === 3 ? .8123 : null, used_outputs: outputs.length, results: [{ model: 'fixture/a', display_name: 'Fixture A', probability: outputs.length === 3 ? .8123 : null }] }; }
function runner(sample) {
  const detector = { analyze: outputs => analysis(outputs) };
  const gateway = { url: 'http://127.0.0.1:1', redact: e => String(e.message), sample };
  return new Fingerprint({ ensure: async () => ({ detector, bank: { id: 'fixture-id', builtAt: 'fixture' } }) }, gateway);
}
const goodSample = () => ({ raw_text: numbers, finishReason: 'stop', provenance: { routeError: '未取得完整路由证据' } });

test('SDK loads and analyzes local data on installed Bun without any network', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-fixture-')); const cache = join(dir, 'cache');
  try {
    writeFileSync(cache, cacheFixture());
    const detector = await loadDetector({ cache, ttl: Infinity });
    expect(detector.builtAt).toBe('fixture');
    const result = detector.analyze([{ text: '1, 2', expected_count: 300 }]);
    expect(result.results).toHaveLength(0); expect(result.probability).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('three samples score, partial output keeps null probability, mismatch never scores', async () => {
  let updates = [], calls = 0;
  let fp = runner(async () => { calls++; return goodSample(); });
  const result = await fp.run({ model: 'mock/a', effort: 'high' }, new AbortController().signal, e => updates.push(e));
  expect(calls).toBe(3); expect(result.analysis.probability).toBe(.8123); expect(result.samples[0].state).toBe('truncated');
  expect(result.samples[0].request.body.reasoning_effort).toBe('high'); expect(updates[0].samples).toHaveLength(3);
  calls = 0; fp = runner(async () => { if (++calls === 1) throw new Error('HTTP 503'); return goodSample(); });
  const partial = await fp.run({ model: 'mock/a' }, new AbortController().signal, () => {});
  expect(partial.analysis.decision).toBe('partial'); expect(partial.analysis.probability).toBeNull(); expect(partial.samples[0].error).toContain('503');
  fp = runner(async () => ({ ...goodSample(), provenance: { mismatch: true } }));
  const mismatch = await fp.run({ model: 'mock/a' }, new AbortController().signal, () => {});
  expect(mismatch.analysis).toBeNull(); expect(mismatch.error).toContain('不匹配');
});
test('empty, nonterminal samples and cancellation retain evidence without ranking', async () => {
  const fp = runner(async () => ({ raw_text: '', finishReason: 'stop' }));
  const empty = await fp.run({ model: 'mock/a' }, new AbortController().signal, () => {});
  expect(empty.analysis).toBeNull(); expect(empty.samples.every(s => s.state === 'failed')).toBe(true);
  const bad = await runner(async () => ({ ...goodSample(), finishReason: 'content_filter' })).run({ model: 'mock/a' }, new AbortController().signal, () => {});
  expect(bad.analysis).toBeNull();
  const controller = new AbortController(); let evidence;
  const cancel = runner(async () => { controller.abort(); return goodSample(); });
  await expect(cancel.run({ model: 'mock/a' }, controller.signal, e => { evidence = e; })).rejects.toThrow();
  expect(evidence.analysis).toBeNull(); expect(evidence.samples[1].state).toBe('cancelled'); expect(evidence.samples[0].raw_text).toBe(numbers);
});
test('reference refresh is atomic, deduplicated, daily, and keeps prior snapshots on failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bank-fixture-')); let now = 1e9, count = 0, fail = false;
  const bank = new ReferenceBank(dir, { now: () => now, load: async ({ cache }) => {
    count++; await Bun.sleep(5); if (fail) throw new Error('offline');
    writeFileSync(cache, cacheFixture(String(count))); return { builtAt: String(count) };
  } });
  try {
    await bank.ready; expect(count).toBe(0); await bank.daily(); expect(count).toBe(0);
    const [a, b] = await Promise.all([bank.refresh(), bank.refresh()]); expect(a).toBe(b); expect(count).toBe(1);
    const bytes = readFileSync(bank.cache); now += 86400000; fail = true; await bank.daily();
    expect(count).toBe(2); expect(bank.status().error).toContain('失败'); expect(readFileSync(bank.cache)).toEqual(bytes);
    await bank.daily(); expect(count).toBe(2); expect(await bank.ensure()).toBe(a);
    fail = false; now += 86400000; await bank.daily(); expect(count).toBe(3); expect(a.bank.builtAt).toBe('1'); expect(bank.current.bank.builtAt).toBe('3');
  } finally { await bank.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('corrupt downloaded detector is not installed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bank-corrupt-'));
  const bank = new ReferenceBank(dir, { load: async ({ cache }) => { const bytes = cacheFixture(); bytes[bytes.length - 1] ^= 1; writeFileSync(cache, bytes); return { builtAt: 'bad' }; } });
  try { await expect(bank.refresh()).rejects.toThrow(); expect(bank.status().state).toBe('missing'); }
  finally { await bank.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('v1 migration preserves records, corrections, config and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-')); const path = join(dir, 'db'); let store;
  try {
    const db = new Database(path); db.exec(`CREATE TABLE configurations(model TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE records(id TEXT PRIMARY KEY, model TEXT NOT NULL,name TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,duration INTEGER,state TEXT NOT NULL,source TEXT NOT NULL,snapshot TEXT NOT NULL,answer TEXT NOT NULL DEFAULT '',automatic TEXT NOT NULL,call_error TEXT,manual_result TEXT,manual_note TEXT,manual_at INTEGER); CREATE TABLE corrections(id INTEGER PRIMARY KEY AUTOINCREMENT,record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,at INTEGER NOT NULL,previous TEXT,next TEXT,note TEXT NOT NULL); PRAGMA user_version=1;`);
    db.query('INSERT INTO configurations VALUES(?,?)').run('mock/a', JSON.stringify({ model: 'mock/a', name: 'A', enabled: true, intervalMinutes: 45, timeoutSeconds: 120, effort: 'high', efforts: ['high'], nextAt: 1234 }));
    db.query("INSERT INTO records(id,model,name,started_at,state,source,snapshot,answer,automatic,manual_result) VALUES('r','mock/a','A',1,'completed','manual','{}','evidence','{\"result\":\"failed\"}','passed')").run();
    db.query("INSERT INTO corrections(record_id,at,next,note) VALUES('r',2,'passed','retained')").run(); db.close();
    store = new Store(path); expect(store.config('mock/a').nextAt).toBe(1234); expect(store.config('mock/a', 'fingerprint').intervalMinutes).toBeNull();
    expect(store.detail('r').answer).toBe('evidence'); expect(store.detail('r').corrections[0].note).toBe('retained');
    store.close(); store = new Store(path); expect(store.configs()).toHaveLength(2); expect(store.db.query('PRAGMA user_version').get().user_version).toBe(2);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
function addFingerprint(store, prediction, at, bankId = 'one', decision = 'scored') {
  const row = store.create({ model: 'mock/a', name: 'A', testId: 'fingerprint' }, 'manual', at);
  store.evidence(row.id, { sdk: SDK_VERSION, bank: { id: bankId }, analysis: { ...analysis([1, 2, 3]), decision, prediction, prediction_name: prediction } });
  store.finish(row.id, {} , at + 1); return row;
}
test('cross-page candidate changes compare scored results and separate bank updates; clear is scoped', () => {
  const s = new Store();
  try {
    addFingerprint(s, 'A', 1); const changed = addFingerprint(s, 'B', 2);
    for (let i = 3; i < 23; i++) addFingerprint(s, 'B', i);
    expect(s.list('mock/a', 2, null, null, 'fingerprint').items[0].id).toBe(changed.id);
    expect(s.list('mock/a', 2, null, null, 'fingerprint').items[0].candidateChanged).toBe(true);
    addFingerprint(s, 'C', 23, 'two'); expect(s.list('mock/a', 1, null, null, 'fingerprint').items[0].bankChanged).toBe(true);
    expect(s.list('mock/a', 1, null, null, 'fingerprint').items[0].candidateChanged).toBe(false);
    const partial = addFingerprint(s, 'D', 24, 'two', 'partial'); expect(s.list('mock/a', 1, null, null, 'fingerprint').items[0].candidateChanged).toBe(false);
    expect(() => s.correct(partial.id, 'passed')).toThrow('不支持');
    const milk = s.create({ model: 'mock/a', name: 'A' }, 'manual', 25); s.finish(milk.id, { automatic: { result: 'passed' } }, 26);
    const pending = s.create({ model: 'mock/a', name: 'A', testId: 'fingerprint' }, 'manual', 27);
    expect(s.heatmap('mock/a', 'UTC', 30).cells.reduce((n, c) => n + c.count, 0)).toBe(1);
    expect(s.clear('mock/a', 'fingerprint')).toBe(24); expect(s.list('mock/a').total).toBe(1); expect(s.detail(pending.id).state).toBe('queued');
  } finally { s.close(); }
});
test('independent plans serialize same model and permit other models; remove cancels both', async () => {
  const store = new Store(); let now = 10000; const running = [];
  const gateway = { redact: e => e.message, call: (s, signal) => new Promise((resolve, reject) => { running.push({ resolve, type: 'milk' }); signal.addEventListener('abort', () => reject(new Error('cancelled'))); }) };
  const fingerprint = { run: (s, signal) => new Promise((resolve, reject) => { running.push({ resolve, type: 'fingerprint' }); signal.addEventListener('abort', () => reject(new Error('cancelled'))); }) };
  const engine = new Engine(store, gateway, { automatic: false, now: () => now, fingerprint });
  try {
    engine.save('mock/a', {}, { name: 'A', efforts: [] }); engine.save('mock/b', {}, { name: 'B', efforts: [] });
    expect(() => engine.save('mock/a', { testId: 'fingerprint', enabled: true })).toThrow('间隔');
    engine.save('mock/a', { testId: 'fingerprint', intervalMinutes: 10, enabled: true });
    const milk = engine.enqueue('mock/a'); const fp = engine.enqueue('mock/a', 'manual', 'fingerprint'); engine.enqueue('mock/b');
    expect(running).toHaveLength(2); expect(store.detail(fp.id).state).toBe('queued'); expect(() => engine.enqueue('mock/a', 'manual', 'fingerprint')).toThrow('已有');
    running[0].resolve('46.24'); await Bun.sleep(1); expect(running[2].type).toBe('fingerprint'); expect(store.detail(milk.id).result).toBe('passed');
    const next = store.config('mock/a', 'fingerprint').nextAt; now += 1000; engine.enqueue('mock/a'); expect(store.config('mock/a', 'fingerprint').nextAt).toBe(next);
    engine.remove('mock/a'); await Bun.sleep(1); expect(store.config('mock/a', 'fingerprint')).toBeNull(); expect(store.detail(fp.id).state).toBe('cancelled');
  } finally { await engine.close(); store.close(); }
});
test('fingerprint API uses gateway, preserves partial evidence and rejects corrections; defaults stay milk', async () => {
  const f = await fixture();
  try {
    f.service.engine.fingerprint = runner(async () => goodSample());
    await f.api('api/configs', 'POST', { model: 'mock/logic-a' });
    const invalid = await f.response('api/configs', 'POST', { model: 'mock/logic-a', testId: 'fingerprint', enabled: true }); expect(invalid.status).toBe(400);
    const run = await f.api('api/run', 'POST', { model: 'mock/logic-a', testId: 'fingerprint' });
    const r = await waitForRecord(f, run.id); expect(r.testId).toBe('fingerprint'); expect(r.fingerprint.analysis.probability).toBe(.8123);
    expect((await f.api('api/history?model=mock%2Flogic-a')).total).toBe(0);
    expect((await f.api('api/history?model=mock%2Flogic-a&testId=fingerprint')).total).toBe(1);
    expect((await f.response(`api/records/${r.id}/correction`, 'POST', { result: 'passed' })).status).toBe(400);
    expect((await f.response('api/run', 'POST', { model: 'mock/logic-a', testId: 'invalid' })).status).toBe(400);
    expect((await f.api('api/bank')).state).toBe('missing');
  } finally { await f.close(); }
});

test('real gateway adapter saves authenticated requests and known route mismatch blocks scoring', async () => {
  const f = await fixture();
  try {
    const detector = { analyze: outputs => analysis(outputs) };
    f.service.engine.fingerprint = new Fingerprint({ ensure: async () => ({ detector, bank: { id: 'test', builtAt: 'test' } }) }, f.service.engine.gateway);
    f.setReply(() => new Response(JSON.stringify({ model: 'vendor-alias', choices: [{ message: { content: numbers }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json', 'X-Magpie-Provider': 'mock', 'X-Magpie-Model': 'mock/other' } }));
    await f.api('api/configs', 'POST', { model: 'mock/logic-a' });
    const run = await f.api('api/run', 'POST', { model: 'mock/logic-a', testId: 'fingerprint' }); const record = await waitForRecord(f, run.id);
    expect(record.state).toBe('error'); expect(record.fingerprint.analysis).toBeNull(); expect(record.fingerprint.samples[0].provenance.mismatch).toBe(true);
    expect(record.fingerprint.samples[0].response_model).toBe('vendor-alias'); expect(record.fingerprint.samples[0].provenance.routeError).toContain('未取得');
    expect(f.requests).toHaveLength(3); expect(f.requests.every(r => r.authorization === `Bearer ${f.settings.apiKey}`)).toBe(true);
    expect(JSON.stringify(record)).not.toContain('mock-secret');
  } finally { await f.close(); }
});
test('round deadline interrupts bank loading promptly and late load never produces a ranking', async () => {
  const store = new Store();
  const gateway = { url: 'http://127.0.0.1:1', redact: e => String(e.message) };
  let resolveBank;
  const fp = new Fingerprint({ ensure: () => new Promise(resolve => { resolveBank = resolve; }) }, gateway);
  const engine = new Engine(store, gateway, { automatic: false, fingerprint: fp });
  try {
    engine.save('mock/a', {}, { name: 'A', efforts: [] });
    store.saveConfig({ ...store.config('mock/a', 'fingerprint'), timeoutSeconds: .01 });
    const row = engine.enqueue('mock/a', 'manual', 'fingerprint'); await Bun.sleep(25);
    expect(store.detail(row.id).state).toBe('error'); expect(store.detail(row.id).callError).toContain('超时'); expect(engine.running).toBe(0);
    resolveBank({ detector: { analyze: () => { throw new Error('must not score'); } }, bank: {} }); await Bun.sleep(1);
    expect(store.detail(row.id).fingerprint.analysis).toBeNull();
  } finally { await engine.close(); store.close(); }
});

test('SDK downloads a local HTTP reference fixture, installs it and reuses cache after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bank-http-')); const bytes = cacheFixture('download-fixture'), bankLength = bytes.readUInt32LE(0), detector = bytes.subarray(4 + bankLength);
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    requests++; expect(req.headers.has('authorization')).toBe(false);
    if (new URL(req.url).pathname.endsWith('/bundle.json')) return new Response(bytes.subarray(4, 4 + bankLength));
    const frame = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, detector.length, 0, 0, 0]); frame.writeUIntLE((detector.length << 3) | 1, 6, 3);
    return new Response(Buffer.concat([frame, detector]));
  } });
  let bank = new ReferenceBank(dir, { source: `http://127.0.0.1:${server.port}/` });
  try {
    await bank.ready; expect(requests).toBe(0); const initial = await bank.ensure();
    expect(initial.bank.builtAt).toBe('download-fixture'); expect(requests).toBe(2);
    await bank.close(); bank = new ReferenceBank(dir, { source: `http://127.0.0.1:${server.port}/` });
    const cached = await bank.ensure(); expect(cached.bank).toEqual(initial.bank); expect(requests).toBe(2); expect(bank.status().updatedAt).not.toBeNull();
  } finally { await bank.close(); server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test('scheduled fingerprint uses its own interval; pause preserves active work and restart clears stale analysis', async () => {
  const s = new Store(); let now = 1000, complete;
  const gateway = { redact: e => e.message };
  const engine = new Engine(s, gateway, { automatic: false, now: () => now, fingerprint: { run: () => new Promise(resolve => { complete = resolve; }) } });
  try {
    engine.save('mock/a', {}, { name: 'A', efforts: [] });
    engine.save('mock/a', { testId: 'fingerprint', intervalMinutes: 1, enabled: true });
    now += 60000; engine.tick(); const active = [...engine.jobs.values()][0]; expect(active.testId).toBe('fingerprint');
    engine.save('mock/a', { testId: 'fingerprint', enabled: false }); expect(engine.jobs.size).toBe(1);
    complete({ error: null }); await Bun.sleep(1); expect(s.detail(active.id).source).toBe('scheduled');
    now += 3600000; engine.tick(); expect(engine.jobs.size).toBe(0); expect(s.config('mock/a').enabled).toBe(false);
    const stale = s.create({ model: 'mock/a', name: 'A', testId: 'fingerprint' }, 'manual');
    s.evidence(stale.id, { samples: [{ raw_text: 'keep this' }], analysis: { decision: 'scored' } }); s.repair();
    expect(s.detail(stale.id).fingerprint.analysis).toBeNull(); expect(s.detail(stale.id).fingerprint.samples[0].raw_text).toBe('keep this');
  } finally { await engine.close(); s.close(); }
});
