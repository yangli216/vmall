export class BusinessError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function requireValue(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new BusinessError(message, status);
}
export function positiveId(value: unknown, label = 'ID'): number {
  const n = Number(value);
  requireValue(Number.isSafeInteger(n) && n > 0, `${label}无效`);
  return n;
}
export function text(value: unknown, label: string, max: number, required = true): string {
  requireValue(value === undefined || value === null || typeof value === 'string', `${label}格式无效`);
  const result = typeof value === 'string' ? value.trim() : '';
  requireValue(!required || result.length > 0, `请填写${label}`);
  requireValue(result.length <= max, `${label}最多${max}字`);
  return result;
}
