import { query } from '../db';
import { requireValue } from '../domain/errors';
import { fen } from '../domain/pricing';
import { createHash } from 'crypto';
export const DEFAULT_CONFIG: Record<string, string> = {
  MEMBER_ENTRY_MODE: 'CONSUME', MEMBER_ENTRY_THRESHOLD: '68.00',
  RED_PACKET_MAX_DEDUCT_RATIO: '0.50', COMMISSION_RATE: '0.03',
  DELIVERY_BASE_FEE: '3.00', DELIVERY_FREE_THRESHOLD: '38.00',
  DELIVERY_AREAS: '', WORKSHOP_ADDRESS: '浙江省杭州市临安区锦城街道临天八弄36号',
  WORKSHOP_LAT: '30.2339', WORKSHOP_LNG: '119.7247', DELIVERY_MAX_KM: '5',
  DELIVERY_PERSON_NAME: '潘师傅', DELIVERY_PERSON_PHONE: '13735518290',
  WORKSHOP_ANNOUNCEMENT: '', BATCH_SCHEDULE_TIME: '16:30', BATCH_CUTOFF_TIME: '16:00',
  BOOKING_DAYS: '1', SHOP_OPEN: '1', ORDER_EXPIRE_MINUTES: '15', BATCH_MAX_ORDERS:'0'
};
export function publicConfigs(rows: any[]): Record<string, string> {
  const result = { ...DEFAULT_CONFIG };
  for (const row of rows) if (Object.hasOwnProperty.call(DEFAULT_CONFIG, row.config_key)) result[row.config_key] = String(row.config_value);
  return result;
}
export function configRevision(config:Record<string,string>):string {
  return createHash('sha256').update(JSON.stringify(Object.keys(config).sort().map(key=>[key,config[key]]))).digest('hex');
}
export async function getConfigs(conn?: any): Promise<Record<string, string>> {
  const rows = conn ? (await conn.execute('SELECT config_key, config_value FROM t_system_config'))[0] : await query('SELECT config_key, config_value FROM t_system_config');
  return publicConfigs(rows);
}
export function validateConfigs(input: unknown): Record<string, string> {
  requireValue(input && typeof input === 'object' && !Array.isArray(input), '配置格式无效');
  const result: Record<string, string> = {};
  const entries = Object.entries(input);
  requireValue(entries.length > 0 && entries.length <= Object.keys(DEFAULT_CONFIG).length, '配置项数量无效');
  for (const [key, raw] of entries) {
    requireValue(Object.hasOwnProperty.call(DEFAULT_CONFIG, key), `不允许修改配置：${key}`);
    requireValue(typeof raw === 'string' || typeof raw === 'number', '配置值格式无效');
    const value = String(raw).trim();
    requireValue(value.length <= 255, '配置值过长');
    if (key === 'MEMBER_ENTRY_MODE') requireValue(['FREE', 'CONSUME', 'MANUAL'].includes(value), '入会方式无效');
    if (['MEMBER_ENTRY_THRESHOLD', 'DELIVERY_BASE_FEE', 'DELIVERY_FREE_THRESHOLD'].includes(key)) fen(value);
    if (key === 'COMMISSION_RATE' || key === 'RED_PACKET_MAX_DEDUCT_RATIO') {
      requireValue(/^0(\.\d{1,2})?$|^1(\.0{1,2})?$/.test(value), '比例须在0至1之间且最多两位小数');
      requireValue(Number(value) <= (key === 'COMMISSION_RATE' ? 0.1 : 1), '返利率不能超过10%');
    }
    if (key.endsWith('_TIME')) requireValue(/^([01]\d|2[0-3]):[0-5]\d$/.test(value), '时间须为HH:mm格式');
    if (key === 'BOOKING_DAYS') requireValue(/^[0-7]$/.test(value), '预约天数须为0至7');
    if (key === 'BATCH_MAX_ORDERS') requireValue(/^\d{1,4}$/.test(value) && Number(value)<=9999,'每批接单上限须为0至9999，0表示不限');
    if (key === 'ORDER_EXPIRE_MINUTES') requireValue(/^\d+$/.test(value) && Number(value) >= 5 && Number(value) <= 30, '付款时限须为5至30分钟');
    if (key === 'SHOP_OPEN') requireValue(['0', '1'].includes(value), '营业状态无效');
    if (key === 'DELIVERY_PERSON_PHONE') requireValue(/^1[3-9]\d{9}$/.test(value), '联系电话格式无效');
    if (['WORKSHOP_ADDRESS', 'DELIVERY_PERSON_NAME'].includes(key)) requireValue(value.length > 0, '门店信息不能为空');
    if (key === 'DELIVERY_MAX_KM') {
      requireValue(/^\d{1,2}(\.\d)?$/.test(value) && Number(value) >= 0 && Number(value) <= 50, '自送半径须为0至50公里（最多一位小数，0表示不限距离）');
    }
    if (key === 'WORKSHOP_LAT') {
      requireValue(value === '' || (/^-?\d{1,2}(\.\d{1,6})?$/.test(value) && Math.abs(Number(value)) <= 90), '作坊纬度格式无效');
    }
    if (key === 'WORKSHOP_LNG') {
      requireValue(value === '' || (/^-?\d{1,3}(\.\d{1,6})?$/.test(value) && Math.abs(Number(value)) <= 180), '作坊经度格式无效');
    }
    result[key] = value;
  }
  return result;
}
