export class HTTPError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new HTTPError(400, `${label}须为 ${min}–${max} 的整数`);
  return value;
}
