import { requireValue } from './errors';
export function chinaDate(now = new Date()): string { return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10); }
export function chinaTimestamp(now = new Date()): string { return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' '); }
export function batchSlots(config: Record<string, string>, now = new Date()) {
  if (config.SHOP_OPEN !== '1') return [];
  const today = chinaDate(now), result = [];
  for (let i = 0; i <= Number(config.BOOKING_DAYS); i++) {
    const date = new Date(Date.parse(`${today}T00:00:00+08:00`) + i * 86400000);
    const day = chinaDate(date), cutoff = new Date(`${day}T${config.BATCH_CUTOFF_TIME}:00+08:00`);
    if (cutoff.getTime() <= now.getTime() + 60000) continue;
    result.push({ date: day, time: config.BATCH_SCHEDULE_TIME, cutoff: config.BATCH_CUTOFF_TIME,
      label: `${i === 0 ? '今日' : i === 1 ? '明日' : day} ${config.BATCH_SCHEDULE_TIME} 批次` });
  }
  return result;
}
export function validateFulfillment(body: any, config: Record<string, string>, now = new Date()) {
  requireValue(config.SHOP_OPEN === '1', '作坊暂时休息，欢迎营业后再来', 409);
  requireValue(body.delivery_type === 1 || body.delivery_type === 2, '请选择配送方式');
  requireValue(typeof body.receiver_name === 'string' && body.receiver_name.trim().length > 0 && body.receiver_name.trim().length <= 50, '请填写联系人');
  requireValue(typeof body.receiver_phone === 'string' && /^1[3-9]\d{9}$/.test(body.receiver_phone), '请填写有效手机号');
  if (body.delivery_type === 1) {
    requireValue(typeof body.receiver_address === 'string' && body.receiver_address.trim().length >= 5 && body.receiver_address.length <= 255, '请填写完整收货地址');
    const areas = config.DELIVERY_AREAS.split(/[,，\n]/).map(x => x.trim()).filter(Boolean);
    requireValue(areas.length > 0, '当前尚未开放自送，请选择到店自提', 409);
    requireValue(typeof body.delivery_area === 'string' && areas.includes(body.delivery_area) && body.receiver_address.includes(body.delivery_area), '地址不在可自送小区内，请选择到店自提');
  }
  const slot = batchSlots(config, now).find(s => s.date === body.batch_date && s.time === body.batch_time);
  requireValue(slot, '该批次已截单或不可预约，请重新选择', 409);
  return slot;
}
