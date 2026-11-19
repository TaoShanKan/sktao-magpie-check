import { HTTPError } from './errors.js';
export function testId(value = 'milk') {
  if (!['milk', 'fingerprint'].includes(value)) throw new HTTPError(400, '检测类型无效');
  return value;
}
export const jobKey = (model, test = 'milk') => JSON.stringify([model, test]);
