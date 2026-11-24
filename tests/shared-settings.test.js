import { test, expect, afterEach } from 'bun:test';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { fixture as serverFixture, waitForRecord } from './helpers.js';

const resources = [];
afterEach(async () => { for (const close of resources.splice(0)) await close(); });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture() {
  let now = 1000000;
  const pending = [], store = new Store();
  const call = (snapshot, signal) => new Promise((resolve, reject) => {
    pending.push({ snapshot, resolve, reject });
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const engine = new Engine(store, { call, redact: e => e.message }, { automatic: false, now: () => now,
    fingerprint: { run: call } });
  resources.push(async () => { await engine.close(); store.close(); });
  return { store, engine, pending, advance: ms => { now += ms; },
    save: (model, input = {}) => engine.saveModel(model, input, { name: model, efforts: ['low', 'high'] }) };
}
test('shared defaults, selection and validation save both views atomically', () => {
  const f = fixture();
  expect(f.save('a')).toMatchObject({ shared: true, selectedTests: ['milk'], enabled: false, intervalMinutes: 30, timeoutSeconds: 300, effort: '' });
  const c = f.save('a', { selectedTests: ['milk', 'fingerprint'], enabled: true, intervalMinutes: 45, effort: 'high' });
  expect(f.store.config('a', 'fingerprint')).toMatchObject({ intervalMinutes: 45, effort: 'high', nextAt: c.nextAt, enabled: true });
  expect(() => f.save('a', { effort: 'bad', intervalMinutes: 60 })).toThrow();
  expect(f.store.config('a').intervalMinutes).toBe(45);
  expect(() => f.save('a', { selectedTests: ['bad'] })).toThrow();
  expect(() => f.save('a', { selectedTests: ['milk', 'milk'] })).toThrow();
  expect(() => f.engine.save('a', { effort: 'low' })).toThrow('共享配置');
  expect(f.save('a', { selectedTests: [], enabled: true })).toMatchObject({ enabled: false, selectedTests: [], nextAt: null });
  expect(() => f.engine.enqueueSelected('a')).toThrow('至少');
});
test('selected group serializes same model, keeps two-model concurrency, and continues after failure', async () => {
  const f = fixture(); f.save('a', { selectedTests: ['milk', 'fingerprint'] }); f.save('b');
  const records = f.engine.enqueueSelected('a'); f.engine.enqueueSelected('b');
  expect(records).toHaveLength(2); expect(f.pending).toHaveLength(2);
  expect(f.store.detail(records[1].id).state).toBe('queued');
  expect(() => f.engine.enqueueSelected('a')).toThrow('已有');
  expect(f.store.list('a').total).toBe(1);
  f.pending[0].reject(new Error('milk failed')); await settle();
  expect(f.pending).toHaveLength(3); expect(f.pending[2].snapshot.testId).toBe('fingerprint');
  f.pending[2].resolve({ error: null }); f.pending[1].resolve('46.24'); await settle();
  expect(f.store.detail(records[0].id).state).toBe('error');
  expect(f.store.detail(records[1].id).state).toBe('completed');
});
test('one schedule advances as a group, no catch-up while busy or after a long group', async () => {
  const f = fixture(); f.save('a', { selectedTests: ['milk', 'fingerprint'], enabled: true, intervalMinutes: 1 });
  f.advance(60000); f.engine.tick();
  expect(f.engine.jobs.size).toBe(2); expect(f.pending).toHaveLength(1);
  expect(f.store.config('a').nextAt).toBe(f.store.config('a', 'fingerprint').nextAt);
  f.advance(600000); f.engine.tick(); expect(f.pending).toHaveLength(1);
  f.pending[0].resolve('46.24'); await settle(); f.engine.tick();
  expect(f.engine.jobs.size).toBe(1); expect(f.pending).toHaveLength(2);
  f.pending[1].resolve({}); await settle(); f.engine.tick();
  expect(f.engine.jobs.size).toBe(0); expect(f.pending).toHaveLength(2);
  expect(f.store.config('a').nextAt).toBe(f.store.config('a', 'fingerprint').nextAt);
  f.advance(60000); f.engine.tick(); expect(f.engine.jobs.size).toBe(2);
});
test('group snapshots survive pause and deselection; removal cancels active and queued work', async () => {
  const f = fixture(); f.save('a', { selectedTests: ['milk', 'fingerprint'], effort: 'high', enabled: true });
  const records = f.engine.enqueueSelected('a');
  f.save('a', { selectedTests: [], effort: 'low' });
  f.pending[0].resolve('46.24'); await settle();
  expect(f.pending[1].snapshot.effort).toBe('high'); expect(f.pending[1].snapshot.timeoutSeconds).toBe(300);
  f.engine.remove('a'); await settle();
  expect(f.store.detail(records[0].id).state).toBe('completed'); expect(f.store.detail(records[1].id).state).toBe('cancelled');
  f.save('a', { selectedTests: ['milk', 'fingerprint'] }); const next = f.engine.enqueueSelected('a');
  f.engine.remove('a'); await settle(); expect(next.map(r => f.store.detail(r.id).state)).toEqual(['cancelled', 'cancelled']);
});
test('manual history tests advance shared schedule only for selected types', async () => {
  const f = fixture(); const c = f.save('a', { enabled: true });
  f.advance(1000); f.engine.enqueue('a', 'manual', 'fingerprint');
  expect(f.store.config('a').nextAt).toBe(c.nextAt); f.pending[0].resolve({}); await settle();
  f.engine.enqueue('a'); expect(f.store.config('a').nextAt).toBe(c.nextAt + 1000);
});
test('group admission rolls back all records if a later insert fails', () => {
  const f = fixture(); const c = f.save('a', { enabled: true, selectedTests: ['milk', 'fingerprint'] });
  const create = f.store.create.bind(f.store);
  f.store.create = (...args) => { if (args[0].testId === 'fingerprint') throw new Error('storage failure'); return create(...args); };
  expect(() => f.engine.enqueueSelected('a')).toThrow('storage failure');
  expect(f.store.list('a').total).toBe(0); expect(f.engine.jobs.size).toBe(0); expect(f.pending).toHaveLength(0);
  expect(f.store.config('a').nextAt).toBe(c.nextAt);
});
test('legacy parameters convert directly with active-type priority and preserve history', () => {
  const f = fixture();
  f.engine.save('a', { intervalMinutes: 15 }, { name: 'A', efforts: [] });
  f.engine.save('a', { testId: 'fingerprint', intervalMinutes: 60, enabled: true, timeoutSeconds: 120 });
  const row = f.store.create(f.store.config('a'), 'manual'); f.store.finish(row.id, { answer: 'evidence' });
  expect(() => f.engine.saveModel('a', { timeoutSeconds: 1 })).toThrow();
  expect(f.store.config('a').intervalMinutes).toBe(15); expect(f.store.config('a').shared).toBeUndefined();
  const merged = f.engine.saveModel('a', {});
  expect(merged).toMatchObject({ shared: true, intervalMinutes: 60, timeoutSeconds: 120, selectedTests: ['fingerprint'], enabled: true });
  expect(f.store.detail(row.id).answer).toBe('evidence'); expect(f.store.detail(row.id).snapshot.shared).toBeUndefined();
});
test('restart directly converts all old parameters, preserving enabled selections', async () => {
  const store = new Store(); let engine = new Engine(store, { redact: e => e.message }, { automatic: false });
  engine.save('untouched', { intervalMinutes: 45, effort: 'high', enabled: true }, { efforts: ['high'] });
  engine.save('equal', {}, { efforts: [] }); engine.save('equal', { testId: 'fingerprint', intervalMinutes: 30 });
  engine.save('conflict', { enabled: true }, { efforts: [] }); engine.save('conflict', { testId: 'fingerprint', intervalMinutes: 90, enabled: true });
  await engine.close(); engine = new Engine(store, { redact: e => e.message }, { automatic: false });
  resources.push(async () => { await engine.close(); store.close(); });
  expect(engine.modelConfigs().find(c => c.model === 'untouched')).toMatchObject({ shared: true, intervalMinutes: 45, effort: 'high', enabled: true, selectedTests: ['milk'] });
  expect(engine.modelConfigs().find(c => c.model === 'equal')).toMatchObject({ shared: true, enabled: false, selectedTests: ['milk'] });
  expect(engine.modelConfigs().find(c => c.model === 'conflict')).toMatchObject({ shared: true, selectedTests: ['milk', 'fingerprint'], intervalMinutes: 30 });
  expect(store.config('conflict', 'fingerprint').intervalMinutes).toBe(30);
});
test('model API exposes shared state, validates atomic updates and runs only selected tests', async () => {
  const f = await serverFixture(); resources.push(() => f.close());
  const c = await f.api('api/model-configs', 'POST', { model: 'mock/logic-a' });
  expect(c.selectedTests).toEqual(['milk']);
  await f.api('api/model-configs', 'POST', { model: c.model, selectedTests: ['milk', 'fingerprint'], timeoutSeconds: 90 });
  const bad = await f.response('api/model-configs', 'POST', { model: c.model, selectedTests: ['wrong'], timeoutSeconds: 120 });
  expect(bad.status).toBe(400); expect(f.service.store.config(c.model, 'fingerprint').timeoutSeconds).toBe(90);
  await f.api('api/model-configs', 'POST', { model: c.model, selectedTests: ['milk'] });
  const result = await f.api('api/run-selected', 'POST', { model: c.model });
  expect(result.items).toHaveLength(1); expect((await waitForRecord(f, result.items[0].id)).result).toBe('passed');
  expect((await f.api('api/state')).modelConfigs[0]).toMatchObject({ shared: true, selectedTests: ['milk'] });
  await f.restart(); expect((await f.api('api/state')).modelConfigs[0].selectedTests).toEqual(['milk']);
});

test('independent edits preserve other fields and cannot recreate a removed model', async () => {
  const fixture = await serverFixture(); resources.push(() => fixture.close());
  const model = 'mock/logic-a'; await fixture.api('api/model-configs', 'POST', { model });
  const patch = fields => fixture.api('api/model-configs', 'PATCH', { model, ...fields });
  await patch({ enabled: true }); await patch({ testSelection: { fingerprint: true } });
  expect(await patch({ intervalMinutes: 45 })).toMatchObject({ enabled: true, selectedTests: ['milk', 'fingerprint'] });
  expect(await patch({ testSelection: { milk: false } })).toMatchObject({ enabled: true, selectedTests: ['fingerprint'] });
  expect(await patch({ testSelection: { fingerprint: false } })).toMatchObject({ enabled: false, selectedTests: [] });
  await fixture.api(`api/configs/${encodeURIComponent(model)}`, 'DELETE');
  expect((await fixture.response('api/model-configs', 'PATCH', { model, effort: 'high' })).status).toBe(404);
});
