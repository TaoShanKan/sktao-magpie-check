export const testTypes = ['milk', 'fingerprint'];

export function modelConfig(configs) {
  if (!configs.length) return null;
  const first = configs.find(c => c.testId === 'milk') || configs[0];
  if (configs.every(c => c.shared)) return { model: first.model, name: first.name, efforts: first.efforts,
    shared: true, selectedTests: configs.filter(c => c.selected).map(c => c.testId), enabled: first.automaticEnabled,
    intervalMinutes: first.intervalMinutes, timeoutSeconds: first.timeoutSeconds, effort: first.effort,
    nextAt: configs.find(c => c.enabled)?.nextAt ?? null };
  return { model: first.model, name: first.name, efforts: first.efforts, shared: false, legacy: configs };
}

export function automaticMergeSource(configs) {
  const enabled = configs.filter(c => c.enabled);
  return enabled.length === 1 ? enabled[0] : configs.find(c => c.testId === 'milk') || configs[0];
}
