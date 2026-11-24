(() => {
  const $ = selector => document.querySelector(selector);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const labels = { passed: '通过', failed: '未通过', unknown: '无法判定', error: '调用异常', queued: '排队中', running: '执行中' };
  const callLabels = { completed: '正常完成', error: '调用异常', interrupted: '服务中断', cancelled: '已取消', queued: '排队中', running: '执行中' };
  const testNames = { milk: '奶牛推理', fingerprint: '模型指纹' };
  const probability = value => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
  const dayOf = timestamp => new Intl.DateTimeFormat('en-CA', { timeZone: state.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(timestamp);
  const resultIcons = { passed: '✓', failed: '×', unknown: '?', error: '!', queued: '◷', running: '◷' };
  const badge = result => `<span class="badge ${escape(result)}">${resultIcons[result] ? `<span aria-hidden="true">${resultIcons[result]}</span> ` : ''}${escape(labels[result] || result)}</span>`;
  let state = { modelConfigs: [], configs: [], models: [], active: [], timeZone: 'Asia/Shanghai' }, catalog = [], catalogError = '';
  let testId = 'milk', tab = 'history', selectedModel = '', page = 1, filter = null, detail = null, pollBusy = false, historyVersion = 0;
  let toastTimer, settingsRendered = false, needsAuthReload = false;
  const saves = new Map(), saveTimers = new Map(), heatScroll = new Map();
  const drafts = new WeakMap(), editing = new WeakSet(), submitting = new Set();
  let configEpoch = 0;
  let timelineItems = [], groupCandidates = false, changesOnly = false, heatModel = null, heatMarkup = '', timelineMarkup = '', overviewDays = 7, overviewMarkup = '', overviewPoints = new Map();
  let overviewTooltipAnchor = null;
  const historyParts = new Map();
  let historyContext = '', displayedQuery = '', displayedKeys = '', chartContext = '', latestChartPoint = '';
  const time = timestamp => timestamp == null ? '—' : new Intl.DateTimeFormat('zh-CN', { timeZone: state.timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(timestamp);
  const duration = value => value == null ? '—' : `${(value / 1000).toFixed(1)} 秒`;
  async function api(path, method = 'GET', data) {
    const response = await fetch(new URL(path, document.baseURI), { method,
      headers: { authorization: `Bearer ${$('meta[name=api-token]').content}`, ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(path === 'api/bank/update' ? 120000 : 15000),
    });
    if (response.status === 401) needsAuthReload = true;
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `请求失败：${response.status}`);
    return value;
  }
  function notify(message) {
    $('#notice').hidden = false; $('#notice').textContent = message;
    const retry = document.createElement('button'); retry.textContent = needsAuthReload ? '重新加载' : '重试';
    retry.onclick = () => needsAuthReload ? location.reload() : refresh(); $('#notice').append(retry);
  }
  function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3500); }
  function action(fn) { return async (...args) => { try { await fn(...args); } catch (e) { notify(e.message); } }; }
  function switchTab(next) {
    tab = next;
    for (const name of ['history', 'settings']) {
      $(`#${name}-panel`).hidden = name !== tab;
      $(`#tab-${name}`).setAttribute('aria-selected', String(name === tab));
      $(`#tab-${name}`).tabIndex = name === tab ? 0 : -1;
    }
    if (tab === 'settings' && !settingsRendered) renderSettings();
    if (tab === 'history') void loadHistory().catch(e => notify(e.message));
  }
  async function refresh() {
    if (pollBusy) return;
    pollBusy = true;
    try {
      const epoch = configEpoch, incoming = await api('api/state');
      if (incoming.apiVersion !== 2 || incoming.uiVersion !== 4 || !Array.isArray(incoming.historyRevisions) || !Array.isArray(incoming.modelConfigs) || !incoming.bank || incoming.configs.some(c => !testNames[c.testId])) {
        historyVersion++; historyContext = ''; historyParts.clear(); displayedKeys = ''; $('#history-error').hidden = true;
        settingsRendered = false; $('#settings-list').replaceChildren(); $('#history-content').hidden = true; $('#history-summary').hidden = true;
        $('#history-run').disabled = true; $('#history-more').disabled = true; $('#add-model').disabled = true; $('#update-bank').disabled = true;
        $('#bank-status').textContent = '当前仍连接旧版服务，参考库功能尚未启动。';
        throw new Error('页面已更新，后台仍是旧版。请在 Magpie 插件页关闭再开启「模型质量」，然后重新加载页面。');
      }
      if (epoch !== configEpoch) incoming.modelConfigs = state.modelConfigs;
      state = incoming;
      $('#add-model').disabled = false; $('#history-more').disabled = false;
      $('#notice').hidden = true;
      renderModelPicker(); renderSettings(); renderBank();
      if (tab === 'history') await loadHistory();
      if (detail && ['queued', 'running'].includes(detail.state)) {
        const id = detail.id, updated = await api(`api/records/${id}`);
        if (detail?.id === id) { detail = updated; renderDetail(); }
      }
    } catch (e) { notify(`连接检测后台失败：${e.message}`); }
    finally { pollBusy = false; }
  }
  function renderModelPicker() {
    if (!state.models.some(m => m.model === selectedModel)) { selectedModel = state.models[0]?.model || ''; page = 1; filter = null; }
    const picker = $('#history-model');
    const current = state.models.find(m => m.model === selectedModel);
    $('#selected-model-id').textContent = current?.model || '';
    $('#selected-model-label').textContent = current ? `${current.name || current.model}${current.removed ? '（已移除）' : ''}` : '暂无模型';
    const markup = state.models.map(m => `<button class="model-option" role="option" aria-selected="${m.model === selectedModel}" data-select-model="${escape(m.model)}" tabindex="-1"><span><strong>${escape(m.name || m.model)}</strong><small>${escape(m.model)}${m.removed ? ' · 已移除' : ''}</small></span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg></button>`).join('');
    if ($('#model-options').innerHTML !== markup) $('#model-options').innerHTML = markup;
    picker.disabled = !state.models.length;
    picker.title = current ? `${current.name || current.model}\n${current.model}` : '';
    const config = state.modelConfigs.find(c => c.model === selectedModel);
    const busy = submitting.has(selectedModel) || state.active.some(j => j.model === selectedModel && j.testId === testId);
    $('#history-run').disabled = !config || busy;
    $('#history-run').textContent = busy ? '测试进行中…' : `测试${testNames[testId]}`;
    $('#plan-summary').textContent = !current ? '' : !config ? '仅保留历史' : !config.selectedTests?.includes(testId) ? '此项未加入定期检测' : config.enabled ? `每 ${config.intervalMinutes} 分钟 · 下次 ${time(config.nextAt)}` : '定期检测已暂停';
    $('#clear-history').disabled = !selectedModel;
    $('#history-empty').hidden = !!selectedModel;
    const context = JSON.stringify([selectedModel, testId]);
    if (historyContext !== context) {
      historyContext = context; historyVersion++; displayedKeys = ''; displayedQuery = ''; chartContext = ''; historyParts.clear();
      $('#history-summary').hidden = $('#history-content').hidden = $('#history-error').hidden = true;
      hideHeatTooltip(); hideOverviewTooltip();
    }
  }
  function historyPart(slot, key, path) {
    if (historyParts.get(slot)?.key === key) return historyParts.get(slot).promise;
    const promise = api(path).catch(error => {
      if (historyParts.get(slot)?.promise === promise) historyParts.delete(slot);
      throw error;
    });
    historyParts.set(slot, { key, promise }); return promise;
  }
  async function loadHistory() {
    if (!selectedModel) { $('#history-summary').hidden = true; return; }
    const version = ++historyVersion, model = selectedModel, type = testId;
    const params = new URLSearchParams({ model, testId: type, page: String(page) });
    if (type === 'fingerprint' && changesOnly) params.set('changes', '1');
    if (filter && type === 'milk') { params.set('day', filter.day); params.set('slot', filter.slot); }
    const days = overviewDays;
    const revision = state.historyRevisions?.find(item => item.model === model && item.testId === type)?.revision ?? 0;
    const query = `${params}`, listKey = `${revision}:${query}`;
    const windowKey = `${revision}:${type === 'milk' ? dayOf(Date.now()) : Math.floor(Date.now() / 60000)}`;
    const chartKey = `${windowKey}:${days}`, keys = JSON.stringify([listKey, windowKey, type === 'milk' ? null : chartKey]);
    if (keys === displayedKeys && $('#history-error').hidden) return;
    let history, overview, distribution;
    try {
      [history, overview, distribution] = await Promise.all([historyPart('list', listKey, `api/history?${params}`), historyPart('summary', windowKey, `api/${type === 'milk' ? 'heatmap' : 'fingerprint-summary'}?model=${encodeURIComponent(model)}`), type === 'fingerprint' ? historyPart('chart', chartKey, `api/fingerprint-overview?model=${encodeURIComponent(model)}&days=${days}`) : null]);
    } catch (error) {
      if (version !== historyVersion) return;
      if (query !== displayedQuery || chartContext !== JSON.stringify([model, days]) && type === 'fingerprint') $('#history-summary').hidden = $('#history-content').hidden = true;
      $('#history-error span').textContent = `${model} · ${testNames[type]}：${error.message}`;
      $('#history-error').hidden = false; $('#history-retry').textContent = needsAuthReload ? '重新加载' : '重试'; return;
    }
    if (version !== historyVersion || selectedModel !== model || testId !== type || overviewDays !== days) return;
    if (page > 1 && (page - 1) * 20 >= history.total) { page = Math.max(1, Math.ceil(history.total / 20)); return loadHistory(); }
    $('#history-error').hidden = true; $('#history-content').hidden = false;
    $('#milk-history').hidden = type !== 'milk'; $('#fingerprint-history').hidden = type !== 'fingerprint';
    $('#history-summary').hidden = false;
    const stat = (label, value, cls = '') => `<div class="summary-stat ${cls}"><span>${label}</span><strong>${value}</strong></div>`;
    if (type === 'fingerprint') {
      $('#history-summary').innerHTML = `<div class="summary-range">最近 30 天<span>${time(overview.from)} — ${time(overview.to)}</span></div>${stat('测试轮数', overview.total)}${stat('完整评分', overview.scored)}${stat('部分排名', overview.partial)}${stat('候选变化', overview.changes)}${stat('参考库更新', overview.bankChanges)}`;
      if (displayedChart !== distribution || chartContext !== JSON.stringify([model, days])) renderFingerprintOverview(distribution);
      displayedChart = distribution;
      timelineItems = history.items; renderTimeline(timelineItems);
    } else {
      const heatmap = overview;
      const counts = heatmap.cells.reduce((a, c) => { for (const k of Object.keys(a)) a[k] += c[k]; return a; }, { count: 0, passed: 0, failed: 0, unknown: 0, error: 0, pending: 0 });
      $('#history-summary').innerHTML = `<div class="summary-range">最近 30 天<span>${heatmap.dates[0]} — ${heatmap.dates.at(-1)}</span></div>${stat('已结束', counts.count)}${stat('通过', counts.passed, 'stat-passed')}${stat('未通过', counts.failed, 'stat-failed')}${stat('无法判定', counts.unknown)}${stat('调用异常', counts.error, 'stat-error')}${stat('进行中', counts.pending)}`;
      $('#timezone').textContent = heatmap.timeZone;
      const heat = $('#heatmap');
      if (heatModel) heatScroll.set(heatModel, heat.scrollLeft);
      const markup = `<div class="heatmap-grid">${[0, 1, 2, 3].map(slot => `<span class="heat-label">${String(slot * 6).padStart(2, '0')}–${String(slot * 6 + 6).padStart(2, '0')}</span>${heatmap.dates.map(day => {
        const cell = heatmap.cells.find(c => c.day === day && c.slot === slot);
        const title = `${day} ${slot * 6}–${slot * 6 + 6} 时：通过 ${cell.passed}，未通过 ${cell.failed}，无法判定 ${cell.unknown}，调用异常 ${cell.error}，进行中 ${cell.pending}${cell.count === 0 && !cell.pending ? '，无记录' : ''}`;
        const symbol = cell.result === 'failed' ? '×' : cell.result === 'error' ? '!' : cell.result === 'passed' ? '✓' : cell.pending ? '◷' : '';
        return `<button class="heat-cell ${cell.result === 'empty' ? 'empty-cell' : cell.result}${cell.pending ? ' pending' : ''}${filter?.day === day && filter.slot === slot ? ' selected' : ''}" data-day="${day}" data-slot="${slot}" aria-label="${escape(title)}"><span aria-hidden="true">${symbol}</span></button>`;
      }).join('')}`).join('')}<span class="heat-label"></span>${heatmap.dates.map((d, i) => `<span class="date-tick">${(i % 7 === 0 && i < 28) || i === 29 ? d.slice(5).replace('-', '/') : ''}</span>`).join('')}</div>`;
      if (heatMarkup !== markup) { hideHeatTooltip(); heat.innerHTML = markup; heatMarkup = markup; }
      if (heatModel !== model) { heat.scrollLeft = heatScroll.get(model) ?? heat.scrollWidth; heatModel = model; }
      $('#filter-day').max = heatmap.dates.at(-1);
      if (!$('#filter-day').value) $('#filter-day').value = heatmap.dates.at(-1);
      $('#reset-filter').hidden = !filter;
      $('#filter-description').hidden = !filter;
      $('#filter-description').textContent = filter ? `${filter.day} · ${filter.slot * 6}:00–${filter.slot * 6 + 6}:00` : '';
      const records = history.items.length ? history.items.map(r => `<tr data-record="${escape(r.id)}"><td data-label="时间">${time(r.startedAt)}</td><td data-label="结果">${badge(r.result)}${r.corrected ? '<span class="manual-label">人工矫正</span>' : ''}</td><td data-label="耗时">${duration(r.duration)}</td><td data-label="来源" class="muted">${r.source === 'scheduled' ? '定时' : '手动'}</td><td><button class="plain" data-record="${escape(r.id)}" aria-label="查看 ${escape(time(r.startedAt))} 的测试详情">详情 →</button></td></tr>`).join('') : '<tr><td colspan="5" class="muted">该范围内暂无记录。</td></tr>';
      if ($('#records').innerHTML !== records) $('#records').innerHTML = records;
    }
    $('#page-info').textContent = `${type === 'fingerprint' && changesOnly ? '变化记录 ' : ''}共 ${history.total} 条 · 第 ${page} / ${Math.max(1, Math.ceil(history.total / 20))} 页`;
    $('#previous').disabled = page <= 1; $('#next').disabled = page * 20 >= history.total;
    displayedKeys = keys; displayedQuery = query;
  }
  let displayedChart = null;
  function revealLatestPoint() {
    const host = $('#overview-chart'), point = host.querySelector(`[data-overview-point="${CSS.escape(latestChartPoint)}"]`);
    if (!point || host.scrollWidth <= host.clientWidth) return;
    const box = host.getBoundingClientRect(), labelWidth = host.querySelector('.overview-label').offsetWidth;
    host.scrollLeft += point.getBoundingClientRect().left + point.offsetWidth / 2 - (box.left + (host.clientWidth + labelWidth) / 2);
  }
  let chartWidth = 0;
  new ResizeObserver(() => {
    const host = $('#overview-chart');
    if (host.clientWidth && chartWidth >= host.scrollWidth && host.clientWidth < host.scrollWidth) revealLatestPoint();
    if (host.clientWidth) chartWidth = host.clientWidth;
  }).observe($('#overview-chart'));
  function renderFingerprintOverview(data) {
    const host = $('#overview-chart');
    const candidateKey = r => r.state === 'completed' && ['scored', 'partial'].includes(r.decision) && r.predictionId ? `candidate:${r.predictionId}` : ['queued', 'running'].includes(r.state) ? 'pending' : 'unavailable';
    const rows = new Map();
    const color = id => { let hash = 0; for (const ch of id) hash = ((hash * 31) + ch.charCodeAt(0)) >>> 0; return hash % 8; };
    for (const r of data.items) {
      const key = candidateKey(r);
      if (!rows.has(key)) rows.set(key, { label: key.startsWith('candidate:') ? r.prediction || r.predictionId : key === 'pending' ? '排队／执行中' : '异常／无候选', color: key.startsWith('candidate:') ? color(r.predictionId) : 8 });
    }
    const groups = new Map(), points = new Map();
    // Fixed absolute buckets avoid moving/re-grouping unchanged records on every poll.
    const bucketMs = data.days === 1 ? 15 * 60000 : data.days === 7 ? 2 * 3600000 : 8 * 3600000;
    for (const r of data.items) {
      const row = candidateKey(r), shape = row === 'pending' ? 'pending' : row === 'unavailable' ? 'unavailable' : r.decision === 'partial' ? 'partial' : 'scored';
      const key = `${row}/${shape}/${Math.floor(r.startedAt / bucketMs)}`;
      if (!groups.has(key)) groups.set(key, { row, shape, items: [] });
      groups.get(key).items.push(r);
    }
    const rangeLabel = data.days === 1 ? '最近 24 小时' : `最近 ${data.days} 天`;
    $('#overview-description').textContent = `${data.total} 轮观测 · ${state.timeZone}`;
    $('#overview-chart').setAttribute('aria-label', `${rangeLabel}候选分布，${data.total}轮观测；Tab 聚焦检测点查看摘要，Enter 打开详情或组内记录`);
    $('#overview-limit').hidden = !data.omitted;
    $('#overview-limit').textContent = data.omitted ? `范围内共 ${data.total} 轮，仅绘制最新 ${data.items.length} 轮，省略 ${data.omitted} 轮；请缩短范围查看。` : '';
    const ticks = Array.from({ length: 5 }, (_, i) => {
      const at = data.from + (data.to - data.from) * i / 4;
      return { x: i * 25, label: new Intl.DateTimeFormat('zh-CN', { timeZone: state.timeZone, month: '2-digit', day: '2-digit', ...(data.days === 1 ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}) }).format(at) };
    });
    const position = at => Math.max(0, Math.min(100, (at - data.from) / (data.to - data.from) * 100));
    const describe = r => `${time(r.startedAt)} · ${r.prediction || callLabels[r.state] || '无候选'} · ${r.decision === 'partial' ? '部分排名，概率不可用' : `参考库内概率 ${probability(r.probability)}`} · 有效样本 ${r.usedOutputs ?? 0}/3 · 参考版本 ${r.bankBuiltAt || r.bankId || '—'} · SDK ${r.sdk || '—'}${r.callError ? ` · ${r.callError}` : ''}`;
    // Adjacent buckets can still overlap at their boundary. Merge nearby buckets
    // only while their total time span fits the same compact display footprint.
    const lastGroup = new Map();
    for (const [key, group] of groups) {
      const lane = `${group.row}/${group.shape}`, previous = lastGroup.get(lane);
      if (previous && group.items.at(-1).startedAt - previous.group.items[0].startedAt <= 2 * bucketMs) {
        previous.group.items.push(...group.items); groups.delete(key);
      } else lastGroup.set(lane, { key, group });
    }
    const rowMarkup = [...rows].map(([key, row]) => {
      const buttons = [...groups.entries()].filter(([, g]) => g.row === key).map(([id, g]) => {
        const item = g.items.at(-1), x = position(item.startedAt), count = g.items.length;
        const text = count > 1 ? `${time(g.items[0].startedAt)} — ${time(item.startedAt)} · ${row.label} · ${count} 轮${g.shape === 'partial' ? '部分排名，概率不可用' : '观测'}，点击展开逐条结果` : describe(item);
        points.set(id, { items: g.items, label: text });
        return `<button class="overview-point color-${row.color} ${g.shape}${count > 1 ? ' clustered' : ''}" style="left:${x.toFixed(3)}%" data-overview-point="${escape(id)}" aria-label="${escape(text)}"><span aria-hidden="true">${count > 1 ? count : g.shape === 'unavailable' ? '×' : g.shape === 'pending' ? '·' : ''}</span></button>`;
      }).join('');
      return `<div class="overview-row"><div class="overview-label color-${row.color}" title="${escape(row.label)}"><i aria-hidden="true"></i><span>${escape(row.label)}</span></div><div class="overview-track">${buttons}</div></div>`;
    }).join('');
    const events = [];
    for (const r of data.items) {
      if (!r.bankChanged && !r.sdkChanged) continue;
      // Same visual bucket shares one event control while retaining all individual records.
      const key = `event:${Math.floor(r.startedAt / bucketMs)}`;
      let group = events.find(g => g.key === key);
      if (!group) { group = { key, items: [] }; events.push(group); }
      group.items.push(r);
    }
    const eventMarkup = events.map(g => {
      const r = g.items.at(-1), labels = [...new Set(g.items.flatMap(i => [i.bankChanged ? '参考库更新' : '', i.sdkChanged ? 'SDK 更新' : ''].filter(Boolean)))].join('／');
      const label = `${time(r.startedAt)} · ${labels} · ${g.items.length} 轮相关观测`;
      points.set(g.key, { items: g.items, label });
      return `<button class="overview-event" style="left:${position(r.startedAt).toFixed(3)}%" data-overview-point="${escape(g.key)}" aria-label="${escape(label)}"><span aria-hidden="true">${g.items.some(i => i.bankChanged) ? '↻' : '◇'}</span></button>`;
    }).join('');
    // Cache the latest endpoint so time labels do not churn the entire chart every 3 seconds.
    const signature = JSON.stringify([selectedModel, data.days, Math.floor(data.to / 60000), data.items]);
    const context = JSON.stringify([selectedModel, overviewDays]), positionLatest = context !== chartContext || !latestChartPoint;
    if (overviewMarkup === signature && !positionLatest) return;
    chartContext = context;
    overviewPoints = points;
    overviewMarkup = signature;
    const scroll = host.scrollLeft, active = document.activeElement?.dataset.overviewPoint;
    const focusedTooltip = overviewTooltipAnchor === document.activeElement;
    hideOverviewTooltip();
    host.innerHTML = data.items.length ? `<div class="overview-grid"><div class="overview-axis"><span class="overview-label">候选模型</span><div class="overview-ticks">${ticks.map(t => `<span style="left:${t.x}%">${escape(t.label)}</span>`).join('')}</div></div>${rowMarkup}<div class="overview-row event-row"><div class="overview-label">版本事件</div><div class="overview-track">${eventMarkup || '<span class="no-version-event muted small">范围内无版本变更</span>'}</div></div></div>` : '<div class="empty"><h3>该范围内暂无指纹观测</h3></div>';
    latestChartPoint = [...points].find(([key, group]) => !key.startsWith('event:') && group.items.at(-1) === data.items.at(-1))?.[0] || '';
    if (positionLatest) revealLatestPoint(); else host.scrollLeft = scroll;
    if (active) {
      [...host.querySelectorAll('[data-overview-point]')].find(button => button.dataset.overviewPoint === active)?.focus({ preventScroll: true });
      if (!focusedTooltip) hideOverviewTooltip();
    }
  }
  function hideOverviewTooltip() {
    $('#overview-tooltip').hidden = true;
    overviewTooltipAnchor?.removeAttribute('aria-describedby');
    overviewTooltipAnchor = null;
  }
  function showOverviewTooltip(button) {
    if (!button) return;
    hideOverviewTooltip();
    const group = overviewPoints.get(button.dataset.overviewPoint); if (!group) return;
    overviewTooltipAnchor = button;
    const tip = $('#overview-tooltip'); tip.textContent = group.label; tip.hidden = false;
    button.setAttribute('aria-describedby', 'overview-tooltip');
    positionOverviewTooltip();
  }
  function positionOverviewTooltip() {
    if (!overviewTooltipAnchor) return;
    const tip = $('#overview-tooltip');
    const rect = overviewTooltipAnchor.getBoundingClientRect(), box = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - box.width - 8))}px`;
    tip.style.top = `${rect.top > box.height + 12 ? rect.top - box.height - 8 : Math.min(rect.bottom + 8, innerHeight - box.height - 8)}px`;
  }
  function moveOverviewTooltip() {
    if (!overviewTooltipAnchor) return;
    if (overviewTooltipAnchor === document.activeElement) positionOverviewTooltip();
    else hideOverviewTooltip();
  }
  async function openOverviewPoint(id) {
    const group = overviewPoints.get(id); if (!group) return;
    hideOverviewTooltip();
    if (group.items.length === 1) return openDetail(group.items[0].id);
    $('#overview-group-content').innerHTML = `<p class="muted small">${escape(group.label)}</p>${group.items.slice().reverse().map(r => `<button class="overview-record" data-overview-record="${escape(r.id)}"><span>${time(r.startedAt)} · ${escape(r.prediction || callLabels[r.state] || '无候选')}</span><small class="muted">${r.decision === 'partial' ? '部分排名 · 概率不可用' : `参考库内概率 ${probability(r.probability)}`} · 有效样本 ${r.usedOutputs ?? 0}/3${r.bankChanged ? ' · 参考库更新' : ''}${r.sdkChanged ? ' · SDK 更新' : ''}<br>参考版本 ${escape(r.bankBuiltAt || r.bankId || '—')} · SDK ${escape(r.sdk || '—')}</small></button>`).join('')}`;
    $('#overview-group-dialog').showModal(); $('#overview-group-content').scrollTop = 0;
  }
  function renderTimeline(items) {
    let day = '';
    const entry = r => {
      const pending = ['queued', 'running'].includes(r.state);
      const progress = r.state === 'queued' ? '排队中' : r.samplingIndex ? `采样 ${r.samplingIndex}/3 · 已结束 ${r.samplesFinished}/3` : r.samplesFinished === 3 ? '采样结束 · 正在分析' : '准备参考库与采样';
      const status = pending ? progress : r.decision === 'partial' ? '样本不足，概率不可用' : r.callError || (r.decision === 'scored' ? '完整评分' : '没有可用候选');
      return `<article class="timeline-entry${r.candidateChanged ? ' has-change' : ''}"><span class="timeline-node ${pending ? 'pending' : ''}" aria-hidden="true"></span><div class="timeline-body"><div class="timeline-top"><span class="muted small">${time(r.startedAt)} · ${r.source === 'scheduled' ? '定时' : '手动'}</span><span class="small muted">${duration(r.duration)}</span></div><button class="timeline-result" data-record="${escape(r.id)}"><span>${escape(r.prediction || (pending ? '正在采样…' : '没有可用候选'))}</span><span class="probability"><strong>${probability(r.probability)}</strong><small>参考库内概率</small></span><span class="sr-only">查看指纹详情</span></button><div class="timeline-meta"><span>${escape(status)}</span><span>有效样本 ${r.usedOutputs ?? 0}/3</span>${r.candidateChanged ? `<span class="badge changed"><span aria-hidden="true">↔</span> 候选变化</span><span class="candidate-change">${escape(r.previousPrediction || '上一候选')} → ${escape(r.prediction)}</span>` : ''}${r.bankChanged ? '<span class="badge bank-changed"><span aria-hidden="true">↻</span> 参考库已更新</span>' : ''}</div></div></article>`;
    };
    const parts = [];
    for (let i = 0; i < items.length;) {
      const r = items[i], date = dayOf(r.startedAt);
      if (date !== day) { parts.push(`<h3 class="timeline-day">${escape(date)}</h3>`); day = date; }
      let end = i + 1;
      if (groupCandidates && !r.candidateChanged && !r.bankChanged && r.state === 'completed' && r.decision === 'scored' && r.predictionId && r.bankId && r.sdk) {
        while (end < items.length) {
          const next = items[end];
          if (next.candidateChanged || next.bankChanged || next.state !== 'completed' || next.decision !== 'scored' || next.predictionId !== r.predictionId || next.bankId !== r.bankId || next.sdk !== r.sdk || dayOf(next.startedAt) !== date) break;
          end++;
        }
      }
      if (end - i > 1) parts.push(`<details class="timeline-group" data-group="${escape(r.id)}"><summary><span>${escape(r.prediction)} <span class="badge">本页 ${end - i} 条</span></span><span class="muted small">${time(items[end - 1].startedAt)} — ${time(r.startedAt)}</span></summary>${items.slice(i, end).map(entry).join('')}</details>`);
      else parts.push(entry(r));
      i = end;
    }
    const markup = items.length ? parts.join('') : `<div class="empty"><h3>${changesOnly ? '暂无变化记录' : '还没有指纹记录'}</h3></div>`;
    if (timelineMarkup !== markup) {
      timelineMarkup = markup;
      const open = new Set([...document.querySelectorAll('.timeline-group[open]')].map(e => e.dataset.group));
      $('#timeline').innerHTML = markup;
      for (const el of document.querySelectorAll('.timeline-group')) el.open = open.has(el.dataset.group);
    }
  }
  function hideHeatTooltip() { $('#heat-tooltip').hidden = true; document.querySelector('.heat-cell[aria-describedby]')?.removeAttribute('aria-describedby'); }
  function showHeatTooltip(cell) {
    if (!cell) return;
    hideHeatTooltip(); cell.setAttribute('aria-describedby', 'heat-tooltip');
    const tip = $('#heat-tooltip'); tip.textContent = cell.getAttribute('aria-label'); tip.hidden = false;
    const rect = cell.getBoundingClientRect(), box = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - box.width - 8))}px`;
    tip.style.top = `${rect.top > box.height + 12 ? rect.top - box.height - 8 : Math.min(rect.bottom + 8, innerHeight - box.height - 8)}px`;
  }
  function renderBank() {
    const b = state.bank; if (!b) { $('#bank-status').textContent = '尚未连接参考库服务'; $('#update-bank').disabled = true; return; }
    $('#bank-status').innerHTML = `<p class="bank-state">${b.state === 'loading' ? '正在更新…' : b.state === 'missing' ? '尚未下载，首次指纹检测时自动下载' : '本地参考库可用'}</p><dl class="bank-meta">${b.bank ? `<dt>构建版本</dt><dd>${escape(b.bank.builtAt)}</dd>` : ''}${b.updatedAt ? `<dt>最近更新</dt><dd>${time(b.updatedAt)}</dd>` : ''}${b.lastAttempt ? `<dt>最近检查</dt><dd>${time(b.lastAttempt)}</dd>` : ''}</dl>${b.error ? `<p class="save-error">更新失败：${escape(b.error)}${b.bank ? ' · 继续使用本地快照' : ''}</p>` : ''}`;
    $('#update-bank').disabled = b.state === 'loading';
  }
  function sharedFields(c) {
    return `<div class="config-fields"><label class="field"><span>检测间隔</span><span class="input-unit"><input name="intervalMinutes" type="number" min="1" max="43200" step="1" required value="${c.intervalMinutes}" aria-label="检测间隔"><span>分钟</span></span></label>
      <label class="switch-label"><input class="switch" type="checkbox" name="enabled" ${c.enabled ? 'checked' : ''}><span>定期检测</span></label><button data-run>立即检测所选项</button></div>
      <div class="config-meta"><span data-next></span><span data-save-status role="status"></span></div>
      <details><summary>高级设置</summary><div class="config-fields"><label class="field"><span>推理强度</span><select name="effort" aria-label="推理强度"><option value="">默认</option>${[...new Set([...c.efforts, ...(c.effort ? [c.effort] : [])])].map(e => `<option value="${escape(e)}" ${e === c.effort ? 'selected' : ''}>${escape(e)}</option>`).join('')}</select></label><label class="field"><span>每项检测超时</span><span class="input-unit"><input type="number" name="timeoutSeconds" min="10" max="3600" step="1" required value="${c.timeoutSeconds}" aria-label="每项检测超时"><span>秒</span></span></label></div><p class="muted small">超时分别计时：奶牛为单次推理，指纹为整轮采样。</p></details>`;
  }
  function renderSettings() {
    settingsRendered = true;
    $('#catalog-status').textContent = catalogError;
    const list = $('#settings-list'), models = new Set(state.modelConfigs.map(config => config.model));
    for (const group of list.querySelectorAll('[data-model]')) if (!models.has(group.dataset.model)) group.remove();
    if (!models.size) { if (!list.querySelector('.empty')) list.innerHTML = '<div class="empty"><h2>暂无监测模型</h2></div>'; return; }
    list.querySelector('.empty')?.remove();
    for (const c of state.modelConfigs) {
      if (!list.querySelector(`[data-model="${CSS.escape(c.model)}"]`)) list.insertAdjacentHTML('beforeend', `<article class="model-group" data-model="${escape(c.model)}"><div class="section-heading"><div><h3>${escape(c.name)}</h3><div class="model-id">${escape(c.model)}</div></div><button class="plain danger" data-remove>移除</button></div>
      <section class="config-card" data-config-model="${escape(c.model)}" aria-label="${escape(c.name)}检测设置"><fieldset class="test-selection"><legend class="sr-only">检测项目</legend>${Object.entries(testNames).map(([type, name]) => `<label class="test-choice"><input type="checkbox" name="selectedTests" value="${type}" ${c.selectedTests.includes(type) ? 'checked' : ''}><span><strong>${name}</strong><small>${type === 'milk' ? '每轮 1 条请求' : '每轮最多 3 条请求'}</small></span></label>`).join('')}</fieldset>${sharedFields(c)}</section></article>`);
    }
    updateConfigStatus();
  }
  function updateConfigStatus() {
    for (const card of document.querySelectorAll('.config-card')) {
      const config = state.modelConfigs.find(c => c.model === card.dataset.configModel);
      if (!config?.shared) continue;
      for (const input of card.querySelectorAll('[name]')) {
        if (editing.has(input) || drafts.get(card)?.has(input)) continue;
        if (input.name === 'selectedTests') input.checked = config.selectedTests.includes(input.value);
        else if (input.type === 'checkbox') input.checked = config[input.name];
        else if (input.value !== String(config[input.name])) input.value = config[input.name];
      }
      const selected = [...card.querySelectorAll('[name=selectedTests]:checked')].map(i => i.value);
      const enabled = card.querySelector('[name=enabled]');
      if (!enabled) continue;
      enabled.disabled = !selected.length;
      if (!selected.length) enabled.checked = false;
      const active = state.active.filter(j => j.model === config.model);
      card.querySelector('[data-next]').textContent = [!selected.length ? '请选择至少一个检测项目' : config.enabled ? `下次检测 ${time(config.nextAt)}` : '定期检测已暂停', ...active.map(j => `${testNames[j.testId]}${j.state === 'queued' ? '排队中' : '执行中'}`)].join(' · ');
      const run = card.querySelector('[data-run]');
      run.disabled = !selected.length || active.length > 0 || submitting.has(config.model);
      run.textContent = active.length ? '检测进行中…' : '立即检测所选项';
    }
  }
  async function saveCard(card, changed) {
    const model = card.dataset.configModel, key = model;
    const status = card.querySelector('[data-save-status]');
    const dirty = drafts.get(card) || new Map(); drafts.set(card, dirty);
    if (changed) { editing.delete(changed); dirty.set(changed, { value: changed.type === 'checkbox' ? changed.checked : changed.type === 'number' ? Number(changed.value) : changed.value }); }
    if (!dirty.size) return;
    clearTimeout(saveTimers.get(key)); status.textContent = '正在保存…'; status.className = '';
    const pending = (saves.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      const entries = [...dirty]; if (!entries.length || !card.isConnected) return;
      try {
        const data = { model };
        for (const [input, draft] of entries) {
          if (!input.reportValidity()) throw new Error('请检查间隔或超时范围');
          if (input.name === 'selectedTests') (data.testSelection ||= {})[input.value] = draft.value;
          else data[input.name] = draft.value;
        }
        const saved = await api('api/model-configs', 'PATCH', data);
        configEpoch++; for (const [input, draft] of entries) if (dirty.get(input) === draft) dirty.delete(input);
        state.modelConfigs = state.modelConfigs.map(c => c.model === model ? saved : c);
        status.textContent = dirty.size ? '正在保存…' : '已自动保存'; status.className = ''; updateConfigStatus(); renderModelPicker();
        clearTimeout(saveTimers.get(key)); saveTimers.set(key, setTimeout(() => { if (status.textContent === '已自动保存') status.textContent = ''; }, 3500));
      } catch (e) {
        status.textContent = `未保存：${e.message}`; status.className = 'save-error';
        const retry = document.createElement('button'); retry.textContent = '重试保存'; retry.className = 'plain';
        retry.onclick = () => saveCard(card).catch(() => {}); status.append(retry); throw e;
      }
    });
    saves.set(key, pending);
    updateConfigStatus();
    try { await pending; } finally { if (saves.get(key) === pending) saves.delete(key); }
  }
  async function loadCatalog() {
    $('#model-choices').textContent = '正在读取 Magpie 模型目录…';
    try { catalog = await api('api/models'); catalogError = ''; }
    catch (e) { catalogError = `模型目录不可用：${e.message}`; }
    $('#catalog-status').textContent = catalogError; renderChoices();
  }
  function renderChoices() {
    const query = $('#model-search').value.trim().toLowerCase();
    const models = catalog.filter(m => !state.configs.some(c => c.model === m.id) && `${m.id} ${m.name} ${m.provider}`.toLowerCase().includes(query));
    $('#model-choices').innerHTML = catalogError ? `<p class="muted">${escape(catalogError)}。可点击刷新目录重试。</p>` : models.length ? models.map(m => `<button class="model-choice" data-add="${escape(m.id)}"><span>${escape(m.name)}</span><small>${escape(m.id)}</small></button>`).join('') : '<p class="muted">没有匹配的可添加模型。</p>';
  }
  async function openDetail(id) {
    const context = historyContext, record = await api(`api/records/${id}`);
    if (context !== historyContext || tab !== 'history') return;
    detail = record; $('#detail-content').replaceChildren(); renderDetail(); $('#detail-dialog').showModal(); $('#detail-content').scrollTop = 0;
  }
  function renderDetail() {
    const r = detail, s = r.snapshot, terminal = !['queued', 'running'].includes(r.state);
    if (r.testId === 'fingerprint') return renderFingerprintDetail(r);
    const correctionOpen = $('#correction-panel')?.open || false;
    $('#detail-content').innerHTML = `<div class="detail-verdict">${badge(r.result)}<span class="muted small">${r.corrected ? '当前采用人工矫正' : '当前采用自动判断'} · ${escape(callLabels[r.state])}</span></div><p class="detail-reason">${escape(r.callError || r.automatic.reason)}</p>
      <p class="muted small">${escape(r.name)} · ${time(r.startedAt)} · ${duration(r.duration)}</p>
      <dl class="answer-comparison"><div><dt>提取答案</dt><dd>${escape(r.automatic.extracted ?? '—')}</dd></div><div><dt>预期答案</dt><dd>${escape(s.expected)}</dd></div></dl>
      <section class="detail-section"><h3>完整回答</h3><pre id="raw-answer">${escape(r.answer || (terminal ? '没有可用回答' : '测试尚未完成…'))}</pre></section>
      <details id="correction-panel" class="detail-section" ${correctionOpen ? 'open' : ''}><summary>人工矫正${r.corrected ? ' · 已有人工结果' : ''}</summary><p class="muted small">先复核回答。保留原始自动判断；人工结果优先用于热力图。</p><label class="field"><span>结果</span><select id="correction-result" ${terminal ? '' : 'disabled'}>${['passed', 'failed', 'unknown'].map(v => `<option value="${v}" ${v === (r.manualResult || r.automatic.result) ? 'selected' : ''}>${labels[v]}</option>`).join('')}</select></label><label class="field correction-note-field"><span>矫正备注（选填）</span><textarea id="correction-note" maxlength="2000" aria-label="矫正备注" ${terminal ? '' : 'disabled'}>${escape(r.manualNote || '')}</textarea></label><div class="correction-actions"><button id="save-correction" class="primary" ${terminal ? '' : 'disabled'}>保存人工结果</button><button id="restore-correction" ${r.corrected ? '' : 'disabled'}>恢复自动判断</button></div><p id="correction-status" role="status" class="muted small"></p></details>
      <details class="detail-section"><summary>请求参数与原始判断</summary><dl class="detail-meta"><dt>模型 ID</dt><dd class="mono small">${escape(r.model)}</dd><dt>时间</dt><dd>${time(r.startedAt)}${r.finishedAt ? ` → ${time(r.finishedAt)}` : ''}</dd><dt>调用状态</dt><dd>${escape(callLabels[r.state])}${r.callError ? ` · ${escape(r.callError)}` : ''}</dd><dt>自动判断</dt><dd>${badge(r.automatic.result)}<br>${escape(r.automatic.reason)}</dd><dt>请求参数</dt><dd>推理强度 ${escape(s.effort || '默认')} · 超时 ${s.timeoutSeconds} 秒 · 上限 ${s.maxTokens} tokens</dd><dt>版本</dt><dd>${escape(s.promptVersion)} / ${escape(s.ruleVersion)}</dd></dl></details>
      <details class="detail-section"><summary>测试题目</summary><pre>${escape(s.prompt)}</pre></details>
      <details class="detail-section"><summary>矫正日志 · ${r.corrections.length} 次</summary>${r.corrections.length ? `<ol class="audit-list">${r.corrections.map(log => `<li>${time(log.at)} · ${log.previous ? labels[log.previous] : '自动判断'} → ${log.next ? labels[log.next] : '恢复自动判断'}${log.note ? `<br>${escape(log.note)}` : ''}</li>`).join('')}</ol>` : '<p class="muted small">尚无人工修改</p>'}</details>`;
  }

  function renderFingerprintDetail(r) {
    const f = r.fingerprint, a = f?.analysis;
    const candidate = c => `<div class="candidate-row"><span>${escape(c.display_name || c.model)}<small class="muted">${escape(c.family_name || '')}</small></span><strong>${probability(c.probability)}</strong></div>`;
    const sampleLabels = { queued: '排队中', waiting: '请求中', complete: '完整', truncated: '已截断（宽松评分）', failed: '失败', cancelled: '已取消' };
    $('#detail-content').innerHTML = `<p class="muted small">${escape(r.model)} · ${time(r.startedAt)} · ${escape(callLabels[r.state])} · ${duration(r.duration)}</p><section class="detail-section"><h3>最相近的参考候选</h3><div class="fingerprint-head"><strong>${escape(a?.prediction_name || '—')}</strong><strong>${probability(a?.probability)}</strong></div><p class="muted small">参考库内概率</p><p class="muted small">${escape(r.callError || f?.error || (a?.decision === 'partial' ? '样本不足，概率不可用' : '概率仅针对参考库候选，不证明模型身份'))}</p></section><section class="detail-section"><h3>Top 3 候选</h3>${a?.results?.slice(0, 3).map(candidate).join('') || '<p class="muted">尚无可用排名</p>'}</section><details class="detail-section"><summary>完整候选排名</summary>${a?.results?.map(candidate).join('') || '—'}</details><dl class="detail-meta detail-section"><dt>参考库</dt><dd>${escape(f?.bank?.builtAt || '—')}<br><span class="mono small">${escape(f?.bank?.id || '')}</span></dd><dt>SDK</dt><dd>${escape(f?.sdk || r.snapshot.ruleVersion)}</dd><dt>请求设置</dt><dd>推理强度 ${escape(r.snapshot.effort || '默认')} · 整轮超时 ${r.snapshot.timeoutSeconds} 秒</dd><dt>有效样本</dt><dd>${a?.used_outputs ?? 0}/3</dd></dl>${(f?.samples || []).map((s, i) => `<details class="detail-section"><summary>采样 ${i + 1} · ${escape(sampleLabels[s.state] || s.state)} · ${s.count}/${s.expected_count}${s.error ? ` · ${escape(s.error)}` : ''}</summary><h4>题目</h4><pre>${escape(f.challenges[i]?.prompt)}</pre><h4>原始回答</h4><pre class="sample-answer">${escape(s.raw_text || '没有可用回答')}</pre><h4>实际请求与路由证据</h4><p class="muted small">${s.provenance?.routeError ? escape(s.provenance.routeError) : s.provenance ? '已取得路由证据' : '未取得路由证据'}</p><pre>${escape(JSON.stringify({ request: s.request, provenance: s.provenance, responseModel: s.response_model, responseId: s.response_id }, null, 2))}</pre></details>`).join('')}<details class="detail-section"><summary>完整分析证据</summary><pre>${escape(JSON.stringify(a, null, 2))}</pre></details>`;
  }
  async function correct(result) {
    const note = $('#correction-note').value, id = detail.id;
    $('#save-correction').disabled = true; $('#restore-correction').disabled = true;
    try {
      detail = await api(`api/records/${id}/correction`, 'POST', { result, note });
      renderDetail(); $('#correction-status').textContent = result === null ? '已恢复自动判断' : '人工结果已保存'; historyParts.clear(); displayedKeys = ''; await loadHistory();
    } catch (e) { $('#save-correction').disabled = false; $('#restore-correction').disabled = !detail.corrected; $('#correction-status').textContent = `保存失败：${e.message}`; }
  }
  function confirm(title, text, label) {
    return new Promise(resolve => {
      const dialog = $('#confirm-dialog'); $('#confirm-title').textContent = title; $('#confirm-text').textContent = text; $('#confirm-yes').textContent = label;
      const done = value => { dialog.close(); resolve(value); };
      $('#confirm-yes').onclick = () => done(true); $('#confirm-cancel').onclick = () => done(false);
      dialog.oncancel = event => { event.preventDefault(); done(false); }; dialog.showModal();
    });
  }
  async function run(model, type = testId) {
    const key = model;
    if (saves.has(key)) await saves.get(key);
    const controls = [...document.querySelectorAll('[data-run],#history-run')].filter(b => b.id === 'history-run' ? selectedModel === model && testId === type : b.closest('.config-card')?.dataset.configModel === model && b.closest('.config-card')?.dataset.testId === type);
    controls.forEach(b => { b.disabled = true; b.textContent = '正在提交…'; });
    try { await api('api/run', 'POST', { model, testId: type }); toast('测试已提交'); }
    finally { await refresh(); }
  }
  document.addEventListener('click', action(async event => {
    const button = event.target.closest('button');
    if (button?.dataset.overviewDays) {
      overviewDays = Number(button.dataset.overviewDays);
      for (const b of document.querySelectorAll('[data-overview-days]')) b.setAttribute('aria-pressed', String(Number(b.dataset.overviewDays) === overviewDays));
      return loadHistory();
    }
    if (button?.dataset.overviewPoint) return openOverviewPoint(button.dataset.overviewPoint);
    if (button?.dataset.overviewRecord) { $('#overview-group-dialog').close(); return openDetail(button.dataset.overviewRecord); }
    if (button?.hasAttribute('data-select-model')) {
      selectedModel = button.dataset.selectModel; page = 1; filter = null;
      $('#model-menu').hidePopover(); $('#history-model').focus(); renderModelPicker(); return loadHistory();
    }
    if (button?.dataset.test) {
      testId = button.dataset.test; page = 1; filter = null; historyVersion++;
      for (const b of document.querySelectorAll('[data-test]')) b.setAttribute('aria-pressed', String(b.dataset.test === testId));
      renderModelPicker(); return loadHistory();
    }
    if (button?.dataset.tab) return switchTab(button.dataset.tab);
    if (button?.dataset.close) return $(`#${button.dataset.close}`).close();
    if (button?.dataset.day) { $('#filter-day').value = button.dataset.day; $('#filter-slot').value = button.dataset.slot; filter = { day: button.dataset.day, slot: Number(button.dataset.slot) }; page = 1; return loadHistory(); }
    const record = event.target.closest('[data-record]'); if (record) return openDetail(record.dataset.record);
    if (button?.dataset.add) {
      await api('api/model-configs', 'POST', { model: button.dataset.add }); $('#add-dialog').close(); await refresh(); renderSettings(); toast('已添加模型，自动测试已暂停'); return;
    }
    const card = button?.closest('.config-card');
    if (card && button.hasAttribute('data-run')) {
      const model = card.dataset.configModel;
      if (submitting.has(model)) return;
      submitting.add(model); button.disabled = true; button.textContent = '正在提交…';
      try {
        if (saves.has(model)) { try { await saves.get(model); } catch { return; } }
        if (drafts.get(card)?.size) { card.querySelector('[data-save-status] button')?.focus(); return; }
        await api('api/run-selected', 'POST', { model }); toast('所选检测已提交');
      } finally { submitting.delete(model); await refresh(); updateConfigStatus(); }
      return;
    }
    const group = button?.closest('.model-group');
    if (group && button.hasAttribute('data-remove')) {
      const model = group.dataset.model;
      if (await confirm('移除模型配置', `${model}\n停止自动测试并取消未完成任务，已有历史将保留。`, '移除')) {
        await Promise.allSettled([saves.get(model)].filter(Boolean));
        await api(`api/configs/${encodeURIComponent(model)}`, 'DELETE'); await refresh(); renderSettings();
      }
    }
  }));
  $('.tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const next = event.key === 'Home' ? 'history' : event.key === 'End' ? 'settings' : tab === 'history' ? 'settings' : 'history';
    switchTab(next); $(`#tab-${next}`).focus();
  });
  $('#settings-list').addEventListener('input', event => { if (event.target.type === 'number') editing.add(event.target); });
  $('#settings-list').addEventListener('focusout', event => editing.delete(event.target));
  $('#settings-list').addEventListener('change', event => { void saveCard(event.target.closest('.config-card'), event.target).catch(() => {}); });
  $('#model-menu').addEventListener('beforetoggle', event => {
    if (event.newState !== 'open') return;
    const rect = $('#history-model').getBoundingClientRect(), menu = $('#model-menu');
    const below = innerHeight - rect.bottom - 12, above = rect.top - 12, useBelow = below >= Math.min(280, above);
    const width = Math.min(Math.max(rect.width, 340), innerWidth - 24);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`;
    menu.style.maxHeight = `${Math.max(0, useBelow ? below : above)}px`;
    menu.style.top = useBelow ? `${rect.bottom + 6}px` : 'auto';
    menu.style.bottom = useBelow ? 'auto' : `${innerHeight - rect.top + 6}px`;
  });
  $('#model-menu').addEventListener('toggle', event => {
    const open = event.newState === 'open'; $('#history-model').setAttribute('aria-expanded', String(open));
    if (!open) return;
    $('#model-options [aria-selected=true]')?.focus({ preventScroll: true });
    const selected = $('#model-options [aria-selected=true]'), list = $('#model-options');
    if (selected) list.scrollTop = Math.max(0, selected.offsetTop - list.offsetTop - list.clientHeight / 2 + selected.clientHeight / 2);
  });
  $('#history-model').addEventListener('keydown', event => {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); $('#model-menu').showPopover(); }
  });
  $('#model-options').addEventListener('keydown', event => {
    const options = [...document.querySelectorAll('.model-option')], index = options.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % options.length;
    if (event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = options.length - 1;
    if (next !== undefined) {
      event.preventDefault(); const option = options[next], list = $('#model-options');
      option?.focus({ preventScroll: true });
      if (option) { const y = option.offsetTop - list.offsetTop; if (y < list.scrollTop) list.scrollTop = y; else if (y + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = y + option.offsetHeight - list.clientHeight; }
    }
  });
  addEventListener('resize', () => $('#model-menu').hidePopover());
  addEventListener('scroll', event => {
    const menu = $('#model-menu');
    if (!(event.target instanceof Node && menu.contains(event.target))) menu.hidePopover();
  }, true);
  $('#history-run').onclick = action(() => run(selectedModel));
  $('#history-retry').onclick = action(() => needsAuthReload ? location.reload() : loadHistory());
  $('#previous').onclick = action(async () => { page--; await loadHistory(); }); $('#next').onclick = action(async () => { page++; await loadHistory(); });
  $('#reset-filter').onclick = action(async () => { filter = null; page = 1; await loadHistory(); });
  $('#clear-history').onclick = action(async () => {
    $('#history-menu').hidePopover();
    const model = selectedModel, type = testId, all = await api(`api/history?model=${encodeURIComponent(model)}&testId=${type}`);
    if (await confirm('清空模型历史', `${model} · ${testNames[type]}\n共 ${all.total} 条记录，删除其中已完成的记录及矫正日志。\n配置保留；进行中的测试完成后仍会出现新记录。此操作无法撤销。`, '清空历史')) {
      await api('api/history', 'DELETE', { model, testId: type }); filter = null; page = 1; await refresh(); toast('已清空历史');
    }
  });
  $('#update-bank').onclick = action(async () => { $('#update-bank').disabled = true; $('#bank-status').textContent = '正在更新…'; try { await api('api/bank/update', 'POST', {}); toast('参考库已更新'); } finally { $('#update-bank').disabled = false; await refresh(); } });
  $('#add-model').onclick = action(async () => { $('#add-dialog').showModal(); $('#add-dialog .dialog-body').scrollTop = 0; $('#model-search').value = ''; $('#model-search').focus(); await loadCatalog(); });
  $('#refresh-models').onclick = action(loadCatalog); $('#model-search').oninput = renderChoices;
  $('#detail-content').addEventListener('click', action(async event => {
    if (event.target.id === 'save-correction') await correct($('#correction-result').value);
    if (event.target.id === 'restore-correction') await correct(null);
  }));
  $('#detail-dialog').addEventListener('close', () => { detail = null; });
  $('#changes-only').onchange = action(async event => { changesOnly = event.target.checked; page = 1; await loadHistory(); });
  $('#group-candidates').onchange = event => { groupCandidates = event.target.checked; renderTimeline(timelineItems); };
  $('#apply-filter').onclick = action(async () => {
    if (!$('#filter-day').value) { $('#filter-day').focus(); return; }
    filter = { day: $('#filter-day').value, slot: Number($('#filter-slot').value) }; page = 1; await loadHistory();
  });
  let heatOverflow = 0;
  new ResizeObserver(() => {
    const el = $('#heatmap');
    if (!el.clientWidth) return;
    const overflow = Math.max(0, el.scrollWidth - el.clientWidth);
    if (!heatOverflow && overflow && el.scrollLeft === 0) el.scrollLeft = overflow;
    heatOverflow = overflow;
  }).observe($('#heatmap'));
  $('#heatmap').addEventListener('pointerover', e => showHeatTooltip(e.target.closest('.heat-cell')));
  $('#heatmap').addEventListener('pointerout', hideHeatTooltip);
  $('#heatmap').addEventListener('focusin', e => { const cell = e.target.closest('.heat-cell'); requestAnimationFrame(() => requestAnimationFrame(() => { if (document.activeElement === cell) showHeatTooltip(cell); })); });
  $('#heatmap').addEventListener('focusout', hideHeatTooltip);
  $('#heatmap').addEventListener('scroll', hideHeatTooltip);
  addEventListener('scroll', hideHeatTooltip, true);
  addEventListener('resize', hideHeatTooltip);
  $('#heatmap').addEventListener('keydown', e => { if (e.key === 'Escape') hideHeatTooltip(); });
  $('#history-menu').addEventListener('beforetoggle', event => {
    if (event.newState !== 'open') return;
    const rect = $('#history-more').getBoundingClientRect(), menu = $('#history-menu');
    menu.style.left = `${Math.max(8, Math.min(rect.right - 160, innerWidth - 168))}px`;
    menu.style.top = `${rect.bottom + 6}px`;
  });
  addEventListener('resize', () => $('#history-menu').hidePopover());
  $('#overview-chart').addEventListener('pointerover', event => {
    const button = event.target.closest('[data-overview-point]');
    if (button && !(event.relatedTarget instanceof Node && button.contains(event.relatedTarget))) showOverviewTooltip(button);
  });
  $('#overview-chart').addEventListener('pointerout', event => {
    const button = event.target.closest('[data-overview-point]');
    if (button && button === overviewTooltipAnchor && button !== document.activeElement && !(event.relatedTarget instanceof Node && button.contains(event.relatedTarget))) {
      const focused = document.activeElement?.closest('[data-overview-point]');
      if (focused) showOverviewTooltip(focused); else hideOverviewTooltip();
    }
  });
  $('#overview-chart').addEventListener('focusin', event => showOverviewTooltip(event.target.closest('[data-overview-point]')));
  $('#overview-chart').addEventListener('focusout', hideOverviewTooltip);
  $('#overview-chart').addEventListener('keydown', e => { if (e.key === 'Escape') hideOverviewTooltip(); });
  addEventListener('scroll', moveOverviewTooltip, true); addEventListener('resize', moveOverviewTooltip);
  void refresh(); setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
})();
