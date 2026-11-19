import { test, expect } from 'bun:test';
import { options } from '../src/config.js';

const env = { XDG_CONFIG_HOME: '/dev/null' };

test('remote gateway requires HTTPS even when credentials are provided', () => {
  expect(() => options({ gateway: 'http://gateway.example', apiKey: 'test-key' }, env)).toThrow('远程网关须使用 HTTPS');
  expect(() => options({}, { ...env, SKTAO_CHECK_GATEWAY: 'http://192.0.2.1' })).toThrow('远程网关须使用 HTTPS');
});

test('remote HTTPS still requires credentials and accepts a trailing /v1', () => {
  expect(() => options({ gateway: 'https://gateway.example' }, env)).toThrow('远程网关须显式配置 apiKey');
  expect(options({ gateway: 'https://gateway.example/v1/' }, { ...env, SKTAO_CHECK_API_KEY: 'test-key' }).gateway).toBe('https://gateway.example');
});

test('HTTP remains available on the supported loopback addresses', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const gateway = `http://${host}:3425`;
    expect(options({ gateway }, env).gateway).toBe(gateway);
  }
  expect(options({}, env).gateway).toBe('http://127.0.0.1:3425');
});
