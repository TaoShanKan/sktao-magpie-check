import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { milk } from '../src/tests/milk.js';

const stores = []; const dirs = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function store(file) { const s = new Store(file); stores.push(s); return s; }
const snapshot = { model: 'test/model', name: 'Test', prompt: milk.prompt, testId: 'milk' };
function finished(s, answer = '48 inches', now = Date.now()) {
  const r = s.create(snapshot, 'manual', now); s.start(r.id, now); s.finish(r.id, { answer, automatic: milk.grade(answer) }, now + 100); return s.detail(r.id);
}
test('corrections keep evidence and recalculate heatmap; restoring keeps audit trail', () => {
  const s = store(); const now = Date.parse('2026-11-13T02:00:00Z');
  const r = finished(s, '48 inches', now);
  const cell = () => s.heatmap(snapshot.model, 'Asia/Shanghai', now + 1000).cells.find(c => c.day === '2026-11-13' && c.slot === 1);
  expect(cell().result).toBe('failed');
  const corrected = s.correct(r.id, 'passed', '人工复核', now + 200);
  expect(corrected.automatic.result).toBe('failed'); expect(corrected.answer).toBe('48 inches');
  expect(corrected.result).toBe('passed'); expect(cell().result).toBe('passed');
  s.correct(r.id, null, '', now + 300);
  expect(s.detail(r.id).result).toBe('failed'); expect(s.detail(r.id).corrections).toHaveLength(2);
  expect(cell().result).toBe('failed');
});
test('red takes priority over unknown and call errors; no data remains empty', () => {
  const s = store(), now = Date.now();
  finished(s, '48 inches', now); const r = s.create(snapshot, 'manual', now); s.finish(r.id, { state: 'error', error: 'timeout' }, now);
  const heatmap = s.heatmap(snapshot.model, 'Asia/Shanghai', now);
  expect(heatmap.cells.filter(c => c.result === 'failed')).toHaveLength(1);
  expect(heatmap.cells.filter(c => c.result === 'empty')).toHaveLength(119);
});
test('history paginates without long answers and keeps in-flight rows when clearing', () => {
  const s = store(); s.saveConfig({ ...snapshot, enabled: false });
  for (let i = 0; i < 23; i++) finished(s, '46.24 inches', Date.now() + i);
  const running = s.create(snapshot, 'manual'); s.start(running.id);
  expect(s.list(snapshot.model).items).toHaveLength(20);
  expect(s.list(snapshot.model, 2).items).toHaveLength(4);
  expect(s.list(snapshot.model).items[0]).not.toHaveProperty('answer');
  expect(s.clear(snapshot.model)).toBe(23);
  expect(s.list(snapshot.model).total).toBe(1); expect(s.config(snapshot.model)).not.toBeNull();
  s.finish(running.id, { answer: '46.24', automatic: milk.grade('46.24') });
  expect(s.list(snapshot.model).items[0].result).toBe('passed');
});
test('restart retains corrections and repairs unfinished jobs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-store-')); dirs.push(dir);
  const path = join(dir, 'db.sqlite'); let s = new Store(path);
  const r = finished(s); s.correct(r.id, 'passed', 'verified');
  const interrupted = s.create(snapshot, 'scheduled'); s.start(interrupted.id); s.close();
  s = store(path); s.repair();
  expect(s.detail(r.id).manualNote).toBe('verified');
  expect(s.detail(interrupted.id).state).toBe('interrupted');
});
test('clearing cascades audit rows and deleting config keeps old model history', () => {
  const s = store(); s.saveConfig(snapshot); const r = finished(s); s.correct(r.id, 'unknown');
  s.deleteConfig(snapshot.model); expect(s.historyModels()[0].removed).toBe(true);
  s.clear(snapshot.model); expect(s.db.query('SELECT COUNT(*) AS n FROM corrections').get().n).toBe(0);
});
test('incomplete record cannot be corrected and invalid corrections do not partially write', () => {
  const s = store(); const r = s.create(snapshot, 'manual');
  expect(() => s.correct(r.id, 'passed')).toThrow('完成');
  expect(() => s.correct(r.id, 'bad')).toThrow('无效');
  expect(s.detail(r.id).corrections).toHaveLength(0);
});

test('fingerprint change filtering precedes pagination and summary uses the full range', () => {
  const s = store(), now = Date.parse('2026-11-16T02:00:00Z');
  function add(i, prediction, bank = 'one', decision = 'scored', sdk = 'sdk-1') {
    const r = s.create({ model: 'test/fp', name: 'FP', testId: 'fingerprint' }, 'manual', now - (60 - i) * 60000);
    s.evidence(r.id, { sdk, bank: { id: bank }, samples: [{ state: 'complete' }, { state: 'failed' }, { state: 'waiting' }], analysis: { prediction, prediction_name: prediction, decision, probability: .8, used_outputs: 1 } });
    s.finish(r.id, {}, now - (60 - i) * 60000 + 1); return r;
  }
  add(0, 'A'); const firstChange = add(1, 'B');
  for (let i = 2; i < 30; i++) add(i, 'B');
  add(30, 'C', 'two'); // reference change, no identity change
  add(31, 'D', 'two', 'partial');
  add(32, 'C', 'two');
  const secondChange = add(33, 'D', 'two');
  add(34, 'E', 'two', 'scored', 'sdk-2'); // detector change is not candidate change
  const list = s.list('test/fp', 1, null, null, 'fingerprint', true);
  expect(list.total).toBe(3); expect(list.items.map(r => r.id)).toContain(firstChange.id);
  expect(list.items[0].id).toBe(secondChange.id); expect(list.items[0].previousPrediction).toBe('C');
  expect(list.items[0]).not.toHaveProperty('fingerprint'); expect(list.items[0]).not.toHaveProperty('answer');
  expect(list.items[0].samplesFinished).toBe(2); expect(list.items[0].samplingIndex).toBe(3);
  expect(s.list('test/fp', 2, null, null, 'fingerprint', true).items).toHaveLength(0);
  const summary = s.fingerprintSummary('test/fp', now);
  expect(summary.total).toBe(35); expect(summary.scored).toBe(34); expect(summary.partial).toBe(1);
  expect(summary.changes).toBe(2); expect(summary.bankChanges).toBe(1);
  add(-50000, 'old'); expect(s.fingerprintSummary('test/fp', now).total).toBe(35);
});

test('fingerprint overview includes the whole interval, marks version boundaries and excludes milk/future', () => {
  const s = store(), now = Date.parse('2026-11-16T02:00:00Z');
  const add = (at, type = 'fingerprint', bank = 'one', sdk = 'sdk-1', decision = 'scored') => {
    const r = s.create({ model: 'test/overview', name: 'Test', testId: type }, 'manual', at);
    if (type === 'fingerprint') s.evidence(r.id, { sdk, bank: { id: bank, builtAt: bank }, analysis: { prediction: 'A', prediction_name: 'Candidate A', decision, probability: decision === 'partial' ? null : .8, used_outputs: 2 } });
    s.finish(r.id, {}, at + 1); return r;
  };
  add(now - 8 * 86400000);
  for (let i = 0; i < 25; i++) add(now - 100000 + i);
  add(now - 50000, 'fingerprint', 'two', 'sdk-2', 'partial');
  add(now + 1); add(now - 40000, 'milk');
  const data = s.fingerprintOverview('test/overview', 7, now);
  expect(data.total).toBe(26); expect(data.items).toHaveLength(26); expect(data.omitted).toBe(0);
  expect(data.items.at(-1).bankChanged).toBe(1); expect(data.items.at(-1).sdkChanged).toBe(1);
  expect(data.items.at(-1).probability).toBeNull(); expect(data.items[0]).not.toHaveProperty('answer');
  expect(data.items[0]).not.toHaveProperty('fingerprint');
  expect(s.fingerprintOverview('test/overview', 30, now).total).toBe(27);
  expect(s.fingerprintOverview('absent', 7, now).items).toEqual([]);
});
