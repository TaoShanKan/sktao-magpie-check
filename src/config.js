import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { HTTPError } from './errors.js';

export function options(input = {}, env = process.env) {
  const configHome = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  let port = 3425;
  try { port = JSON.parse(readFileSync(join(configHome, 'magpie/settings.json'), 'utf8')).port || port; } catch {}
  const addr = (env.MAGPIE_ADDR || `127.0.0.1:${port}`)
    .replace(/^0\.0\.0\.0:/, '127.0.0.1:').replace(/^\[::\]:/, '[::1]:').replace(/^:/, '127.0.0.1:');
  const gateway = (input.gateway || env.SKTAO_CHECK_GATEWAY || `http://${addr}`).replace(/\/+$/, '').replace(/\/v1$/, '');
  const url = new URL(gateway);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new HTTPError(400, '网关地址须为不含路径、认证信息及查询参数的 HTTP(S) 地址');
  const apiKey = input.apiKey || env.SKTAO_CHECK_API_KEY || '';
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    if (url.protocol !== 'https:') throw new HTTPError(400, '远程网关须使用 HTTPS');
    if (!apiKey) throw new HTTPError(400, '远程网关须显式配置 apiKey');
  }
  const servicePort = Number(input.port ?? env.SKTAO_CHECK_PORT ?? 4397);
  if (!Number.isInteger(servicePort) || servicePort < 0 || servicePort > 65535)
    throw new HTTPError(400, '插件服务端口无效');
  return {
    port: servicePort, gateway, apiKey,
    bankSource: input.bankSource || env.SKTAO_CHECK_BANK_SOURCE || null,
    dataDir: resolve(input.dataDir || env.SKTAO_CHECK_DATA_DIR || join(configHome, 'magpie/sktao-check')),
    timeZone: input.timeZone || env.SKTAO_CHECK_TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
