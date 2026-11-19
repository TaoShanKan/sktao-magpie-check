export class CallError extends Error {
  constructor(message, answer = '') { super(message); this.answer = answer; }
}
async function bounded(response, limit) {
  if (!response.body) return '';
  const reader = response.body.getReader(); const parts = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new CallError('回复超过大小限制'); }
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts).toString('utf8');
  } finally { reader.releaseLock(); }
}

export class Gateway {
  constructor({ gateway, apiKey }) { this.url = gateway; this.key = apiKey; }
  headers() { return { 'content-type': 'application/json', ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) }; }
  redact(error) { return String(error?.message || error).replaceAll(this.key || '\u0000', '[redacted]').slice(0, 500); }
  async models() {
    const r = await fetch(`${this.url}/v1/models`, { headers: this.headers(), signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!r.ok) throw new Error(`读取模型目录失败：HTTP ${r.status}`);
    const data = JSON.parse(await bounded(r, 4 * 1024 * 1024));
    if (!Array.isArray(data.data)) throw new Error('网关模型目录格式无效');
    return data.data.filter(m => typeof m.id === 'string' && /^[^/\s]+\/.+/.test(m.id) && !m.id.startsWith('group/')
      && !/^(embedding|image|audio)(_|$)/.test(m.type || '')
      && (!m.modalities?.output || m.modalities.output.includes('text'))
      && (!m.native_endpoints?.length || !m.native_endpoints.every(p => /\/(?:images|audio|embeddings)\b/.test(p))))
      .map(m => ({ id: m.id, name: String(m.display_name || m.name || m.id), provider: m.id.split('/')[0],
        efforts: [...new Set((m.reasoning_levels || m.supported_reasoning_levels || []).map(e => typeof e === 'string' ? e : e.effort).filter(e => typeof e === 'string' && e.length <= 64))] }));
  }
  async sample(payload, signal) {
    const session = `quality-fp-${crypto.randomUUID()}`, startedAt = Date.now();
    const r = await fetch(`${this.url}/v1/chat/completions`, { method: 'POST', headers: { ...this.headers(), 'X-Magpie-Session': session }, body: JSON.stringify(payload), signal, redirect: 'error' });
    const provenance = { session, requestedModel: payload.model, provider: r.headers.get('X-Magpie-Provider'), model: r.headers.get('X-Magpie-Model'), route: null, routeError: null };
    if (!r.ok) { await r.body?.cancel(); throw new CallError(`模型调用失败：HTTP ${r.status}`); }
    const data = JSON.parse(await bounded(r, 4 * 1024 * 1024));
    const receivedAt = Date.now();
    try {
      const route = await fetch(`${this.url}/v1/magpie/route?session=${encodeURIComponent(session)}`, { headers: this.headers(), signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]), redirect: 'error' });
      if (!route.ok) { await route.body?.cancel(); throw new Error(`HTTP ${route.status}`); }
      const body = JSON.parse(await bounded(route, 256 * 1024)); provenance.route = body.route || body;
      provenance.model ||= provenance.route.model;
      provenance.provider ||= provenance.route.provider;
    } catch { provenance.routeError = '未取得完整路由证据'; }
    provenance.mismatch = !!((provenance.model && provenance.model !== payload.model) || (provenance.provider && provenance.provider !== payload.model.split('/')[0]));
    const choice = data.choices?.length === 1 ? data.choices[0] : null;
    return { raw_text: typeof choice?.message?.content === 'string' ? choice.message.content : '', finishReason: choice?.finish_reason || '', response_model: data.model || null, response_id: data.id || null, first_byte_ms: receivedAt - startedAt, provenance };
  }
  async call(snapshot, signal) {
    const payload = { model: snapshot.model, stream: false, max_tokens: snapshot.maxTokens, messages: [{ role: 'user', content: snapshot.prompt }] };
    if (snapshot.effort) payload.reasoning_effort = snapshot.effort;
    const r = await fetch(`${this.url}/v1/chat/completions`, { method: 'POST', headers: this.headers(), body: JSON.stringify(payload), signal, redirect: 'error' });
    if (!r.ok) { await r.body?.cancel(); throw new CallError(`模型调用失败：HTTP ${r.status}`); }
    let data;
    try { data = JSON.parse(await bounded(r, 4 * 1024 * 1024)); }
    catch (e) { if (signal.aborted || e instanceof CallError) throw e; throw new CallError('无法解析网关回复'); }
    const choice = data.choices?.length === 1 ? data.choices[0] : null;
    const answer = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    if (!choice) throw new CallError('网关未返回唯一回答');
    if (choice.finish_reason !== 'stop') throw new CallError('回答被截断或未正常结束', answer);
    if (!answer.trim()) throw new CallError('模型返回空回答');
    return answer;
  }
}
