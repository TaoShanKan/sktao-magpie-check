import { test, expect, afterEach } from 'bun:test';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';

const resources = [];
afterEach(async () => { for (const { engine, store } of resources.splice(0)) { await engine.close(); store.close(); } });
function fixture() {
  let now = 1000000; const pending = [];
  const gateway = { redact: e => String(e.message), call: (snapshot, signal) => new Promise((resolve, reject) => {
    pending.push({ snapshot, resolve, reject }); signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) };
  const store = new Store(); const engine = new Engine(store, gateway, { automatic: false, now: () => now });
  resources.push({ engine, store });
  return { engine, store, pending, advance: ms => { now += ms; }, add: (model, input = {}) => engine.save(model, input, { name: model, efforts: ['high', 'low'] }) };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
test('defaults paused and validates per-model advanced settings', () => {
  const f = fixture(); const c = f.add('a/m');
  expect(c.enabled).toBe(false); expect(c.timeoutSeconds).toBe(300); expect(c.intervalMinutes).toBe(30);
  expect(() => f.add('b/m', { intervalMinutes: 0 })).toThrow();
  expect(() => f.add('b/m', { timeoutSeconds: 9 })).toThrow();
  expect(() => f.add('b/m', { effort: 'max' })).toThrow();
});
test('at most 2 simultaneous requests and one unfinished job per model', async () => {
  const f = fixture(); for (const id of ['a/m', 'b/m', 'c/m']) f.add(id);
  const a = f.engine.enqueue('a/m'); f.engine.enqueue('b/m'); const c = f.engine.enqueue('c/m');
  expect(f.pending).toHaveLength(2); expect(f.store.detail(c.id).state).toBe('queued');
  expect(() => f.engine.enqueue('a/m')).toThrow('已有');
  f.pending[0].resolve('46.24 inches'); await settle();
  expect(f.pending).toHaveLength(3); expect(f.store.detail(a.id).result).toBe('passed');
});
test('each interval is independent; no catch-up flood after sleep', async () => {
  const f = fixture(); f.add('a/m', { enabled: true, intervalMinutes: 1 }); f.add('b/m', { enabled: true, intervalMinutes: 2 });
  f.advance(60000); f.engine.tick(); expect(f.pending).toHaveLength(1);
  f.pending[0].resolve('46.24'); await settle();
  f.advance(30 * 60000); f.engine.tick(); f.engine.tick();
  expect(f.pending).toHaveLength(3); expect(f.engine.jobs.size).toBe(2);
  f.pending[1].resolve('46.24'); f.pending[2].resolve('46.24'); await settle();
  f.engine.tick(); expect(f.pending).toHaveLength(3);
});
test('in-flight snapshot survives config edits and switching off', async () => {
  const f = fixture(); f.add('a/m', { enabled: true, effort: 'high' }); const r = f.engine.enqueue('a/m');
  f.engine.save('a/m', { enabled: false, effort: 'low', timeoutSeconds: 15 });
  expect(f.pending[0].snapshot.effort).toBe('high'); expect(f.engine.jobs.size).toBe(1);
  f.pending[0].resolve('46.24'); await settle();
  expect(f.store.detail(r.id).snapshot.timeoutSeconds).toBe(300); expect(f.store.config('a/m').enabled).toBe(false);
});
test('deleting active/queued config cancels jobs and preserves terminal records', async () => {
  const f = fixture(); for (const id of ['a/m', 'b/m', 'c/m']) f.add(id);
  const a = f.engine.enqueue('a/m'); f.engine.enqueue('b/m'); const c = f.engine.enqueue('c/m');
  f.engine.remove('c/m'); f.engine.remove('a/m'); await settle();
  expect(f.store.detail(a.id).state).toBe('cancelled'); expect(f.store.detail(c.id).state).toBe('cancelled');
  expect(f.store.config('a/m')).toBeNull(); expect(f.pending).toHaveLength(2);
});
test('errors do not retry or become wrong answers', async () => {
  const f = fixture(); f.add('a/m'); const r = f.engine.enqueue('a/m');
  f.pending[0].reject(new Error('HTTP 500')); await settle(); f.engine.tick();
  expect(f.pending).toHaveLength(1); expect(f.store.detail(r.id).result).toBe('error');
  expect(f.store.detail(r.id).automatic.result).toBe('unknown');
});
test('deadline aborts the request and records a call error', async () => {
  const f = fixture(); const config = f.add('a/m');
  // Accelerate the clock at the transport boundary, keeping public validation unchanged.
  f.store.saveConfig({ ...config, timeoutSeconds: 0.01 });
  const record = f.engine.enqueue('a/m');
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(f.store.detail(record.id).result).toBe('error');
  expect(f.store.detail(record.id).callError).toContain('超时');
  expect(f.engine.jobs.size).toBe(0);
});
