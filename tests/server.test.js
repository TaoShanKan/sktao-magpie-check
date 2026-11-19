import { test, expect, afterEach } from 'bun:test';
import { fixture, waitForRecord } from './helpers.js';
import { startServer } from '../src/server.js';
import { startManagedService } from '../src/managed.js';

const fixtures = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
async function setup() { const f = await fixture(); fixtures.push(f); return f; }

test('gateway catalog, request parameters, grading, correction and restart work end-to-end', async () => {
  const f = await setup(); const models = await f.api('api/models');
  expect(models.map(m => m.id)).toEqual(['mock/logic-a', 'mock/logic-b', 'mock/logic-c']);
  await f.api('api/configs', 'POST', { model: 'mock/logic-a', effort: 'high', intervalMinutes: 15, timeoutSeconds: 120 });
  const run = await f.api('api/run', 'POST', { model: 'mock/logic-a' });
  const record = await waitForRecord(f, run.id);
  expect(record.result).toBe('passed'); expect(record.automatic.extracted).toBe('46.24');
  expect(f.requests[0].payload.reasoning_effort).toBe('high');
  expect(f.requests[0].payload).not.toHaveProperty('tools'); expect(f.requests[0].payload.messages[0].content).not.toContain('46.24');
  expect(f.requests[0].authorization).toBe(`Bearer ${f.settings.apiKey}`);
  await f.api(`api/records/${run.id}/correction`, 'POST', { result: 'failed', note: '复核' });
  let heatmap = await f.api('api/heatmap?model=mock%2Flogic-a'); expect(heatmap.cells.some(c => c.result === 'failed')).toBe(true);
  await f.restart(); const restored = await f.api(`api/records/${run.id}`);
  expect(restored.manualNote).toBe('复核'); expect(restored.automatic.result).toBe('passed');
  await f.api(`api/records/${run.id}/correction`, 'POST', { result: null });
  heatmap = await f.api('api/heatmap?model=mock%2Flogic-a'); expect(heatmap.cells.some(c => c.result === 'passed')).toBe(true);
  await f.api('api/history', 'DELETE', { model: 'mock/logic-a' });
  expect((await f.api('api/history?model=mock%2Flogic-a')).total).toBe(0);
  expect((await f.api('api/state')).configs).toHaveLength(2);
});
test('truncated and empty answers or HTTP errors are call errors, with no retries', async () => {
  const f = await setup(); await f.api('api/configs', 'POST', { model: 'mock/logic-a' });
  for (const reply of [
    () => ({ choices: [{ message: { content: '46.24 inches' }, finish_reason: 'length' }] }),
    () => ({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }),
    () => new Response('error', { status: 503 }),
  ]) {
    f.setReply(reply); const run = await f.api('api/run', 'POST', { model: 'mock/logic-a' });
    const record = await waitForRecord(f, run.id); expect(record.result).toBe('error'); expect(record.automatic.result).toBe('unknown');
    expect(record.callError).toBeTruthy();
  }
  expect(f.requests).toHaveLength(3); expect(f.requests[0].payload).not.toHaveProperty('reasoning_effort');
});
test('history slot filters use configured timezone and do not return full output', async () => {
  const f = await setup(); await f.api('api/configs', 'POST', { model: 'mock/logic-a' });
  const snapshot = { ...f.service.store.config('mock/logic-a'), expected: '46.24' };
  f.service.store.create(snapshot, 'manual', Date.parse('2026-11-12T23:59:00Z'));
  f.service.store.create(snapshot, 'manual', Date.parse('2026-11-13T04:00:00Z'));
  const data = await f.api('api/history?model=mock%2Flogic-a&day=2026-11-13&slot=1');
  expect(data.total).toBe(1); expect(data.items[0]).not.toHaveProperty('answer');
  expect((await f.response('api/history?model=x&day=garbage&slot=1')).status).toBe(400);
});
test('API rejects unauthorized/foreign origins; HTML does not grant cross-origin token access', async () => {
  const f = await setup();
  expect((await fetch(`${f.origin}/api/state`)).status).toBe(401);
  expect((await fetch(`${f.origin}/api/state`, { headers: { origin: 'https://foreign.example', authorization: `Bearer ${f.service.token}` } })).status).toBe(403);
  const html = await fetch(f.origin, { headers: { origin: 'null' } });
  expect(html.headers.get('access-control-allow-origin')).toBeNull();
  expect(html.headers.get('content-security-policy')).toContain("base-uri 'none'");
  const text = await html.text(); expect(text).not.toContain(f.settings.apiKey); expect(text).toContain(f.service.token);
  expect((await f.api('api/state'))).not.toHaveProperty('apiKey');
});
test('two services cannot schedule against the same database and managed hosts share one owner', async () => {
  const f = await setup();
  await expect(startServer({ ...f.settings, port: 0 })).rejects.toThrow('另一个');
  f.settings.port = f.service.port;
  await f.restart();
  const attached = await startManagedService({ ...f.settings, port: f.service.port }, 20);
  try {
    await f.service.close();
    let response;
    for (let i = 0; i < 30; i++) {
      try { response = await fetch(`${f.origin}/_check/health`); if (response.ok) break; } catch {}
      await Bun.sleep(20);
    }
    expect((await response.json()).app).toBe('sktao-magpie-check');
  } finally { await attached.close(); }
});

test('UI history capabilities expose bounded summaries and apply change filters server-side', async () => {
  const f = await setup();
  expect((await f.api('api/state')).uiVersion).toBe(3);
  let previous;
  for (let i = 0; i < 25; i++) {
    const prediction = i === 0 ? 'A' : 'B';
    const r = f.service.store.create({ model: 'mock/logic-a', name: 'A', testId: 'fingerprint' }, 'manual', Date.now() - (25 - i) * 1000);
    f.service.store.evidence(r.id, { sdk: 'test', bank: { id: 'test' }, analysis: { decision: 'scored', prediction, prediction_name: prediction } });
    f.service.store.finish(r.id, {});
    if (i === 1) previous = r.id;
  }
  const history = await f.api('api/history?model=mock%2Flogic-a&testId=fingerprint&changes=1');
  expect(history.total).toBe(1); expect(history.items[0].id).toBe(previous); expect(history.items[0].previousPrediction).toBe('A');
  const summary = await f.api('api/fingerprint-summary?model=mock%2Flogic-a');
  expect(summary.total).toBe(25); expect(summary.changes).toBe(1);
  expect((await f.api('api/fingerprint-summary?model=missing')).total).toBe(0);
});

test('fingerprint overview validates supported windows and exposes only summary points', async () => {
  const f = await setup();
  const r = f.service.store.create({ model: 'mock/logic-a', name: 'A', testId: 'fingerprint' }, 'manual', Date.now() - 1000);
  f.service.store.evidence(r.id, { sdk: 'test', bank: { id: 'test' }, samples: [{ raw_text: 'private raw evidence' }], analysis: { prediction: 'A', prediction_name: 'A', decision: 'scored', probability: .5 } });
  f.service.store.finish(r.id, {});
  for (const days of [1, 7, 30]) {
    const data = await f.api(`api/fingerprint-overview?model=mock%2Flogic-a&days=${days}`);
    expect(data.days).toBe(days); expect(data.total).toBe(1); expect(data.items[0].id).toBe(r.id);
    expect(JSON.stringify(data)).not.toContain('private raw evidence');
  }
  expect((await f.response('api/fingerprint-overview?days=2')).status).toBe(400);
  expect((await f.response('api/fingerprint-overview?days=no')).status).toBe(400);
});
