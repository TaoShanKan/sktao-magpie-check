(() => {
  const root = document.documentElement;
  const media = matchMedia('(prefers-color-scheme: dark)');
  let hostTheme = new URLSearchParams(location.search).get('theme');
  const apply = theme => {
    if (!theme || typeof theme.dark !== 'boolean') return;
    hostTheme = theme.dark ? 'dark' : 'light';
    root.dataset.theme = hostTheme;
    for (const [key, value] of Object.entries(theme.tokens || {}))
      if (/^[\w-]+$/.test(key) && typeof value === 'string') root.style.setProperty(`--magpie-${key}`, value);
  };
  const paint = () => { root.dataset.theme = hostTheme || (media.matches ? 'dark' : 'light'); };
  paint(); media.addEventListener('change', paint);
  if (parent !== window) {
    const id = 'sktao-theme-' + Math.random().toString(36).slice(2);
    addEventListener('message', event => {
      if (event.source !== parent || event.data?.magpie !== 1) return;
      if (event.data.event === 'theme') apply(event.data.data);
      if (event.data.id === id && !event.data.error) apply(event.data.result);
    });
    parent.postMessage({ magpie: 1, id, method: 'hello' }, '*');
  }
})();
