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
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseCoord(raw: unknown, maxAbs: number): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && Math.abs(n) <= maxAbs ? n : null;
}

export function validateFulfillment(body: any, config: Record<string, string>, now = new Date()) {
  requireValue(config.SHOP_OPEN === '1', '作坊暂时休息，欢迎营业后再来', 409);
  requireValue(body.delivery_type === 1 || body.delivery_type === 2, '请选择配送方式');
  requireValue(typeof body.receiver_name === 'string' && body.receiver_name.trim().length > 0 && body.receiver_name.trim().length <= 50, '请填写联系人');
  requireValue(typeof body.receiver_phone === 'string' && /^1[3-9]\d{9}$/.test(body.receiver_phone), '请填写有效手机号');
  if (body.delivery_type === 1) {
    requireValue(typeof body.receiver_address === 'string' && body.receiver_address.trim().length >= 5 && body.receiver_address.length <= 255, '请填写完整收货地址');
    const areas = (config.DELIVERY_AREAS || '').split(/[,，\n]/).map(x => x.trim()).filter(Boolean);
    const maxKm = Number(config.DELIVERY_MAX_KM || '0');
    const shopLat = parseCoord(config.WORKSHOP_LAT, 90), shopLng = parseCoord(config.WORKSHOP_LNG, 180);
    const userLat = parseCoord(body.delivery_lat, 90), userLng = parseCoord(body.delivery_lng, 180);
    const hasRadiusRule = maxKm > 0 && shopLat !== null && shopLng !== null;
    const hasUserCoords = userLat !== null && userLng !== null;

    requireValue(areas.length > 0 || hasRadiusRule, '当前尚未开放自送，请选择到店自提', 409);

    if (hasUserCoords && hasRadiusRule) {
      const distKm = haversineKm(shopLat!, shopLng!, userLat!, userLng!);
      requireValue(distKm <= maxKm, `当前定位距作坊约${distKm.toFixed(1)}公里，超出${maxKm}公里自送范围，请选择到店自提`);
    } else {
      requireValue(areas.length > 0, '请使用地图定位确认配送距离，或选择到店自提');
      const addr = body.receiver_address.trim();
      const areaText = typeof body.delivery_area === 'string' ? body.delivery_area.trim() : '';
      const areaConsistent = !areaText || addr.includes(areaText);
      requireValue(areaConsistent && areas.some(a => addr.includes(a)), '地址不在可自送区域范围内，请使用地图定位或选择到店自提');
    }
  }
  const slot = batchSlots(config, now).find(s => s.date === body.batch_date && s.time === body.batch_time);
  requireValue(slot, '该批次已截单或不可预约，请重新选择', 409);
  return slot;
}
