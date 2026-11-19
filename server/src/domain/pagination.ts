import { requireValue } from './errors';

export const PAGE_SIZE = 30;

export function beforeId(value: unknown): number {
  if (value === undefined) return 0;
  requireValue(typeof value === 'string' && /^[1-9]\d*$/.test(value), '分页参数无效');
  const id = Number(value);
  requireValue(Number.isSafeInteger(id), '分页参数无效');
  return id;
}

export function pageRows<T extends { id: number }>(rows: T[]) {
  const more = rows.length > PAGE_SIZE;
  const list = rows.slice(0, PAGE_SIZE);
  return { list, next_cursor: more ? list[list.length - 1].id : null };
}
