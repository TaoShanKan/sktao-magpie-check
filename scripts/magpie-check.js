import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixture } from '../tests/helpers.js';
import { Store } from '../src/store.js';

const f = await fixture(), sandbox = mkdtempSync(join(tmpdir(), 'sktao-magpie-integration-'));
function freePort() { const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') }); const port = s.port; s.stop(true); return port; }
const webPort = freePort(), servicePort = freePort();
const key = `sktao-test-${crypto.randomUUID()}`, project = resolve(import.meta.dir, '..');
const env = { ...process.env, HOME: sandbox, XDG_CONFIG_HOME: join(sandbox, '.config'), XDG_CACHE_HOME: join(sandbox, '.cache'),
  MAGPIE_ADDR: `127.0.0.1:${webPort}`, MAGPIE_WEB_KEY: key, MAGPIE_PLUGIN_MARKET: 'off', SKTAO_CHECK_PORT: String(servicePort),
  SKTAO_CHECK_GATEWAY: f.settings.gateway, SKTAO_CHECK_API_KEY: f.settings.apiKey, SKTAO_CHECK_DATA_DIR: join(sandbox, 'quality-data') };
// Reuse a COPY of the installed Bun runtime; daily Magpie data stays untouched.
const cache = join(homedir(), '.cache/magpie/bun');
if (existsSync(join(cache, 'state.json'))) {
  const version = JSON.parse(readFileSync(join(cache, 'state.json'), 'utf8')).current;
  const dest = join(env.XDG_CACHE_HOME, 'magpie/bun'); mkdirSync(join(dest, version), { recursive: true });
  copyFileSync(join(cache, version, 'magpie-bun'), join(dest, version, 'magpie-bun')); chmodSync(join(dest, version, 'magpie-bun'), 0o755);
  copyFileSync(join(cache, 'state.json'), join(dest, 'state.json'));
}
async function cli(args) {
  const child = Bun.spawn(['magpie', ...args], { cwd: project, env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill(), 45000);
  const code = await child.exited; clearTimeout(timer);
  const text = (await output) + (await errors);
  if (code !== 0) throw new Error(`Magpie CLI failed: ${text.replaceAll(f.settings.apiKey, '[redacted]')}`);
}
let web, browser;
try {
  await cli(['plugin', 'add', project]);
  await cli(['plugin', 'options', project, JSON.stringify({ port: servicePort, gateway: f.settings.gateway, apiKey: f.settings.apiKey, dataDir: join(sandbox, 'quality-data') })]);
  web = Bun.spawn(['magpie', 'web', '--addr', `127.0.0.1:${webPort}`, '--no-open'], { env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  // Drain logs without publishing gateway environment or temporary access keys.
  void new Response(web.stdout).text(); void new Response(web.stderr).text();
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${webPort}/`)).status) break; } catch {}
    if (web.exitCode !== null) throw new Error('Magpie exited before web UI became ready');
    await Bun.sleep(200);
  }
  const browserCache = join(homedir(), 'Library/Caches/ms-playwright');
  let executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (!executablePath && existsSync(browserCache)) for (const dir of readdirSync(browserCache).filter(p => /^chromium-/.test(p)).sort().reverse()) {
    const path = join(browserCache, dir, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (existsSync(path)) { executablePath = path; break; }
  }
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await page.goto(`http://127.0.0.1:${webPort}/?k=${key}`);
  const nav = page.locator('#nav button[data-plugin-page]').filter({ hasText: '模型质量' });
  await expect(nav).toBeVisible({ timeout: 30000 }); await nav.click();
  // Resolve the actual page frame by its app content; the host class can change.
  let app;
  for (let i = 0; i < 100; i++) {
    app = page.frames().find(frame => frame.url().includes(`:${servicePort}/`) || frame.url().includes('/_magpie/service/'));
    if (app && await app.locator('#tab-settings').count()) break;
    await Bun.sleep(200);
  }
  if (!app || !await app.locator('#tab-settings').count()) {
    mkdirSync('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/magpie-failure.png' });
    throw new Error('Plugin service frame did not load: ' + page.frames().map(f => f.url()).join(', '));
  }
  await expect(app.locator('#history-empty')).toBeVisible();
  await app.locator('#tab-settings').click(); await app.locator('#add-model').click();
  await app.locator('[data-add="mock/logic-a"]').click(); await app.locator('[data-test-id=milk] [data-run]').click();
  await app.locator('#tab-history').click(); await expect(app.locator('#records .badge')).toHaveText('✓ 通过', { timeout: 10000 });
  await app.locator('#records button').click(); await expect(app.locator('#raw-answer')).toContainText('46.24');
  await app.locator('#correction-panel > summary').click();
  await app.locator('#correction-result').selectOption('failed'); await app.locator('#save-correction').click();
  await expect(app.locator('#correction-status')).toHaveText('人工结果已保存');
  await app.locator('[data-close="detail-dialog"]').click();
  await expect(app.locator('#history-run')).toHaveText('测试奶牛推理', { timeout: 6000 });
  // Seed clearly labelled, offline fingerprint evidence in the isolated data directory.
  const seed = new Store(join(sandbox, 'quality-data/quality.sqlite'));
  try {
    const config = seed.config('mock/logic-a', 'fingerprint');
    expect(config.intervalMinutes).toBeNull(); expect(config.enabled).toBe(false);
    const row = seed.create(config, 'manual');
    seed.evidence(row.id, { sdk: 'lmfpd-sdk-0.2.0', bank: { id: 'integration-fixture', builtAt: 'integration-fixture' }, challenges: [], samples: [], analysis: { decision: 'scored', prediction: 'fixture/model', prediction_name: '示例候选模型', probability: .875, used_outputs: 3, results: [{ model: 'fixture/model', display_name: '示例候选模型', probability: .875 }] } });
    seed.finish(row.id, {});
  } finally { seed.close(); }
  await app.locator('[data-test=fingerprint]').click();
  await expect(app.locator('#timeline')).toContainText('示例候选模型');
  await expect(app.locator('#overview-chart .overview-point')).toHaveCount(1);
  await app.locator('#overview-chart .overview-point').click();
  await expect(app.locator('#detail-dialog')).toBeVisible();
  await app.locator('[data-close="detail-dialog"]').click();
  await expect(app.locator('.timeline-result strong')).toHaveText('87.5%');
  await app.locator('.timeline-result').click();
  await expect(app.locator('#detail-content')).toContainText('Top 3 候选');
  await expect(app.locator('#save-correction')).toHaveCount(0);
  await app.locator('[data-close="detail-dialog"]').click();
  await expect(app.locator('h1')).toHaveCount(0);
  mkdirSync('docs/screenshots', { recursive: true }); await page.screenshot({ path: 'docs/screenshots/magpie-embedded.png', fullPage: true });
  console.log('PASS: isolated Magpie installation, sidebar, service proxy, milk call/correction and fingerprint timeline in sandboxed frame');
} finally {
  await browser?.close();
  if (web) { web.kill('SIGTERM'); await web.exited; }
  await f.close(); rmSync(sandbox, { recursive: true, force: true });
}
