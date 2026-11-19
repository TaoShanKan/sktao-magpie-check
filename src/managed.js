import { options } from './config.js';
import { identity, startServer } from './server.js';

export async function startManagedService(input = {}, pollMs = 3000) {
  const opt = options(input), mine = identity(opt);
  let owned, pending, closed = false;
  async function peerIdentity() {
    try {
      const r = await fetch(`http://127.0.0.1:${opt.port}/_check/health`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
      return await r.json();
    } catch { return null; }
  }
  const matches = peer => peer?.app === mine.app && peer.version === mine.version && peer.configuration === mine.configuration;
  async function acquire() {
    if (closed || owned) return;
    const peer = await peerIdentity();
    if (matches(peer)) return;
    if (peer) throw new Error(`端口 ${opt.port} 被其他服务占用，请在插件选项中修改 port`);
    try { owned = await startServer(opt); }
    catch (e) {
      // A second host may acquire the listener after our first probe.
      if (matches(await peerIdentity())) return;
      throw new Error(`无法启动模型质量服务（端口 ${opt.port}）：${e.message}`);
    }
  }
  const reconcile = () => pending ||= acquire().finally(() => { pending = null; });
  await reconcile();
  const timer = setInterval(() => { reconcile().catch(e => console.warn(e.message)); }, pollMs); timer.unref();
  return { async close() { closed = true; clearInterval(timer); await pending; await owned?.close(); } };
}
