import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { options } from './config.js';
import { Store } from './store.js';
import { Gateway } from './gateway.js';
import { Engine } from './engine.js';
import { ReferenceBank, Fingerprint } from './fingerprint.js';
import { testId } from './test-id.js';
import { HTTPError, integer } from './errors.js';

export function identity(opt) {
  mkdirSync(opt.dataDir, { recursive: true, mode: 0o700 });
  const path = join(opt.dataDir, '.service-secret');
  try { writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  return { app: 'sktao-magpie-check', version: '0.4.0', configuration: createHmac('sha256', readFileSync(path)).update(JSON.stringify(opt)).digest('hex') };
}
function equal(a, b) { return Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
async function body(req) {
  if (Number(req.headers.get('content-length')) > 16384) throw new HTTPError(413, '请求过大');
  const reader = req.body?.getReader(); if (!reader) return {};
  const parts = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 16384) { await reader.cancel(); throw new HTTPError(413, '请求过大'); }
      parts.push(Buffer.from(value));
    }
    const input = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    return input;
  } catch (e) { if (e instanceof HTTPError) throw e; throw new HTTPError(400, '请求 JSON 无效'); }
  finally { reader.releaseLock(); }
}

export async function startServer(input = {}, dependencies = {}) {
  const opt = options(input); new Intl.DateTimeFormat('en', { timeZone: opt.timeZone });
  const serviceIdentity = identity(opt), token = randomBytes(32).toString('hex');
  const gateway = dependencies.gateway || new Gateway(opt);
  let store, engine, bank, catalog = [], initialized;
  const json = (value, status = 200, cors = {}) => Response.json(value, { status, headers: { 'cache-control': 'no-store', ...cors } });
  const server = Bun.serve({
    hostname: '127.0.0.1', port: opt.port,
    async fetch(req) {
      const url = new URL(req.url), host = req.headers.get('host');
      if (host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`) return json({ error: 'Invalid host' }, 403);
      const origin = req.headers.get('origin');
      if (origin && origin !== 'null' && origin !== `http://${host}`) return json({ error: 'Invalid origin' }, 403);
      const api = url.pathname.startsWith('/api/');
      const cors = api ? { ...(origin ? { 'access-control-allow-origin': origin } : {}), vary: 'Origin', 'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS' } : {};
      if (api && req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      try {
        await initialized;
        if (url.pathname === '/_check/health' && req.method === 'GET') return json(serviceIdentity);
        if (api) {
          if (!equal(req.headers.get('authorization')?.replace(/^Bearer /, '') || '', token)) return json({ error: '请重新加载页面以连接检测服务' }, 401, cors);
          const method = req.method, path = url.pathname;
          let result, status = 200, match;
          if (path === '/api/state' && method === 'GET') {
            result = { apiVersion: 2, uiVersion: 2, serviceVersion: serviceIdentity.version, configs: store.configs(), models: store.historyModels(), active: [...engine.jobs.values()].map(j => ({ model: j.model, testId: j.testId, id: j.id })), timeZone: opt.timeZone, bank: bank.status() };
          } else if (path === '/api/bank' && method === 'GET') {
            result = bank.status();
          } else if (path === '/api/bank/update' && method === 'POST') {
            await bank.refresh(); result = bank.status();
          } else if (path === '/api/models' && method === 'GET') {
            catalog = await gateway.models(); result = catalog;
          } else if (path === '/api/configs' && method === 'POST') {
            const data = await body(req);
            if (typeof data.model !== 'string' || data.model.length > 500) throw new HTTPError(400, '模型 ID 无效');
            if (!store.config(data.model, testId(data.testId)) && !catalog.some(m => m.id === data.model)) catalog = await gateway.models();
            result = engine.save(data.model, data, catalog.find(m => m.id === data.model));
          } else if ((match = path.match(/^\/api\/configs\/(.+)$/)) && method === 'DELETE') {
            engine.remove(decodeURIComponent(match[1])); result = { ok: true };
          } else if (path === '/api/run' && method === 'POST') {
            const data = await body(req); const record = engine.enqueue(data.model, 'manual', testId(data.testId));
            result = { id: record.id, model: record.model, testId: record.testId, state: record.state }; status = 202;
          } else if (path === '/api/history' && method === 'GET') {
            const model = url.searchParams.get('model') || '';
            const page = integer(Number(url.searchParams.get('page') || 1), 1, 1000000, '页码');
            const day = url.searchParams.get('day'), slot = url.searchParams.get('slot');
            let from = null, to = null;
            if (day || slot) {
              if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new HTTPError(400, '日期筛选无效');
              const s = integer(Number(slot), 0, 3, '时段');
              const parts = new Intl.DateTimeFormat('en-CA', { timeZone: opt.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
              const center = Date.parse(`${day}T12:00:00Z`), hits = [];
              for (let t = center - 36 * 3600000; t <= center + 36 * 3600000; t += 60000) {
                const p = Object.fromEntries(parts.formatToParts(t).map(p => [p.type, p.value]));
                if (`${p.year}-${p.month}-${p.day}` === day && Math.floor(Number(p.hour) / 6) === s) hits.push(t);
              }
              if (!hits.length) throw new HTTPError(400, '无效日期或时段');
              from = hits[0]; to = hits.at(-1) + 60000;
            }
            result = store.list(model, page, from, to, testId(url.searchParams.get('testId') ?? undefined), url.searchParams.get('changes') === '1');
          } else if (path === '/api/fingerprint-overview' && method === 'GET') {
            const days = Number(url.searchParams.get('days') ?? 7);
            if (![1, 7, 30].includes(days)) throw new HTTPError(400, '汇总范围须为 1、7 或 30 天');
            result = store.fingerprintOverview(url.searchParams.get('model') || '', days);
          } else if (path === '/api/fingerprint-summary' && method === 'GET') {
            result = store.fingerprintSummary(url.searchParams.get('model') || '');
          } else if (path === '/api/heatmap' && method === 'GET') {
            result = store.heatmap(url.searchParams.get('model') || '', opt.timeZone);
          } else if (path === '/api/history' && method === 'DELETE') {
            const data = await body(req); if (typeof data.model !== 'string') throw new HTTPError(400, '请选择模型');
            result = { deleted: store.clear(data.model, testId(data.testId)) };
          } else if ((match = path.match(/^\/api\/records\/([\w-]+)(\/correction)?$/))) {
            if (method === 'GET' && !match[2]) result = store.detail(match[1]);
            else if (method === 'POST' && match[2]) {
              const data = await body(req); result = store.correct(match[1], data.result, data.note);
            } else throw new HTTPError(405, '请求方法不支持');
          } else throw new HTTPError(404, '接口不存在');
          return json(result, status, cors);
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HTTPError(405, '请求方法不支持');
        if (url.pathname === '/' || url.pathname === '/index.html') {
          const proxyOrigin = url.searchParams.get('uiOrigin');
          if (proxyOrigin && (!/^https?:\/\//.test(proxyOrigin) || new URL(proxyOrigin).origin !== proxyOrigin || proxyOrigin.includes('*'))) throw new HTTPError(400, '页面来源无效');
          const sources = [...new Set([`http://${host}`, proxyOrigin].filter(Boolean))].join(' ');
          const html = (await Bun.file(new URL('../ui/index.html', import.meta.url)).text()).replace('<!--TOKEN-->', `<meta name="api-token" content="${token}">`);
          return new Response(req.method === 'HEAD' ? null : html, { headers: {
            'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
            'content-security-policy': `default-src 'none'; script-src 'self' ${sources}; style-src 'self' ${sources} 'unsafe-inline'; connect-src 'self' ${sources}; img-src 'self' ${sources} data:; base-uri 'none'; object-src 'none'; form-action 'none'`,
          } });
        }
        if (!['/app.js', '/style.css', '/theme.js'].includes(url.pathname)) throw new HTTPError(404, '文件不存在');
        return new Response(req.method === 'HEAD' ? null : Bun.file(new URL(`../ui${url.pathname}`, import.meta.url)), { headers: {
          'content-type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
          'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache',
        } });
      } catch (e) { return json({ error: gateway.redact(e) }, e.status || 500, cors); }
    },
  });
  initialized = Promise.resolve().then(() => {
    store = new Store(join(opt.dataDir, 'quality.sqlite'));
    chmodSync(join(opt.dataDir, 'quality.sqlite'), 0o600);
    store.acquire(token);
    bank = dependencies.bank || new ReferenceBank(opt.dataDir, { source: opt.bankSource });
    engine = new Engine(store, gateway, { ...dependencies.engine, fingerprint: dependencies.fingerprint || new Fingerprint(bank, gateway) });
  });
  try { await initialized; } catch (e) { server.stop(true); store?.release(token); store?.close(); throw e; }
  let closed = false;
  return { port: server.port, token, store, engine, identity: serviceIdentity,
    async close() {
      if (closed) return; closed = true;
      await engine.close(); await bank.close(); server.stop(true); store.release(token); store.close();
    },
  };
}
