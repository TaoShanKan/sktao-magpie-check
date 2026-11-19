import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.js';

export async function fixture() {
  const requests = [];
  let reply = payload => ({ choices: [{ message: { content: payload.model === 'mock/logic-b' ? 'Final answer: 48 inches.' : String.raw`With milk: 54 inches. Without milk: 42 inches. Final answer: \boxed{46.24\text{ inches}}` }, finish_reason: 'stop' }] });
  const mock = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/v1/models') return Response.json({ data: [
      { id: 'mock/logic-a', name: 'Logic A', reasoning_levels: ['low', 'high'] },
      { id: 'mock/logic-b', name: 'Logic B', supported_reasoning_levels: [{ effort: 'medium' }] },
      { id: 'mock/logic-c', name: 'Logic C' }, { id: 'group/routing' },
      { id: 'mock/image', modalities: { output: ['image'] } },
    ] });
    if (url.pathname === '/v1/chat/completions') {
      const payload = await req.json(); requests.push({ payload, authorization: req.headers.get('authorization') });
      const result = await reply(payload);
      return result instanceof Response ? result : Response.json(result);
    }
    return new Response('Not found', { status: 404 });
  } });
  const dir = mkdtempSync(join(tmpdir(), 'sktao-check-'));
  const settings = { port: 0, dataDir: dir, gateway: `http://127.0.0.1:${mock.port}`, apiKey: `fixture-${crypto.randomUUID()}`, timeZone: 'Asia/Shanghai' };
  let service = await startServer(settings, { engine: { automatic: false } });
  const f = {
    requests, dir, settings,
    get service() { return service; }, get origin() { return `http://127.0.0.1:${service.port}`; },
    setReply(fn) { reply = fn; },
    async response(path, method = 'GET', data) {
      return fetch(`${f.origin}/${path}`, { method, headers: { authorization: `Bearer ${service.token}`, 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    },
    async api(path, method = 'GET', data) {
      const r = await f.response(path, method, data); const value = await r.json();
      if (!r.ok) throw new Error(value.error); return value;
    },
    async restart() { await service.close(); service = await startServer(settings, { engine: { automatic: false } }); },
    async close() { await service.close(); mock.stop(true); rmSync(dir, { recursive: true, force: true }); },
  };
  return f;
}
export async function waitForRecord(f, id) {
  for (let i = 0; i < 100; i++) {
    const r = await f.api(`api/records/${id}`);
    if (!['queued', 'running'].includes(r.state)) return r;
    await Bun.sleep(10);
  }
  throw new Error('Record did not finish');
}
