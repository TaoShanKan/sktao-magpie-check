(async () => {
  const theme = await magpie.ready;
  const settings = await magpie.options.get();
  const port = Number(settings.port ?? 4397);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('插件服务端口无效');
  let service = magpie.service;
  if (!service) {
    const host = location.hostname;
    if (host && host !== 'localhost' && !host.endsWith('.localhost') && host !== '[::1]' && !/^127\./.test(host))
      throw new Error('当前 Magpie 不支持远程插件服务，请升级 Magpie');
    service = `http://127.0.0.1:${port}/`;
  }
  const url = new URL(service, location.href);
  url.searchParams.set('uiOrigin', url.origin);
  url.searchParams.set('theme', theme.dark ? 'dark' : 'light');
  location.replace(url.href);
})().catch(error => {
  document.getElementById('status').textContent = `连接失败：${error.message}。请检查插件状态及服务端口。`;
  const retry = document.getElementById('retry'); retry.hidden = false; retry.onclick = () => location.reload();
});
