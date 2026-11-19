import { PoolConnection } from 'mysql2/promise';
import { query } from '../db';
import { requireValue } from '../domain/errors';

export function capacityLimit(config: Record<string,string>) {
  const max = Number(config.BATCH_MAX_ORDERS);
  requireValue(Number.isSafeInteger(max) && max >= 0 && max <= 9999, '批次接单上限配置异常，请联系掌柜',503);
  return max;
}
export async function readCapacity(date: string, time: string, config: Record<string,string>) {
  const max = capacityLimit(config);
  const rows: any = await query('SELECT reserved_orders FROM t_batch_capacity WHERE batch_date=? AND batch_time=?',[date,time]);
  const used = Number(rows[0]?.reserved_orders || 0);
  requireValue(Number.isSafeInteger(used) && used>=0,'批次接单计数异常，请联系掌柜核对',503);
  return {max_orders:max,used_orders:used,remaining_orders:max ? Math.max(0,max-used) : null,full:max>0 && used>=max};
}
export async function reserveCapacity(conn: PoolConnection, date: string, time: string, config: Record<string,string>) {
  const max=capacityLimit(config);
  // Track unlimited batches too, so a later limit includes existing reservations.
  await conn.execute('INSERT IGNORE INTO t_batch_capacity(batch_date,batch_time,reserved_orders) VALUES(?,?,0)',[date,time]);
  const [rows]: any = await conn.execute('SELECT reserved_orders FROM t_batch_capacity WHERE batch_date=? AND batch_time=? FOR UPDATE',[date,time]);
  requireValue(rows.length===1 && Number.isSafeInteger(rows[0].reserved_orders) && rows[0].reserved_orders>=0,'批次接单计数异常，请联系掌柜核对',503);
  requireValue(!max || rows[0].reserved_orders<max,'该批次已接满，请选择其他批次',409);
  await conn.execute('UPDATE t_batch_capacity SET reserved_orders=reserved_orders+1 WHERE batch_date=? AND batch_time=?',[date,time]);
}
export async function releaseCapacity(conn: PoolConnection, order: any) {
  if (!order.capacity_reserved || (order.refund_origin_status != null && order.refund_origin_status>20)) return;
  const [result]: any = await conn.execute('UPDATE t_batch_capacity SET reserved_orders=reserved_orders-1 WHERE batch_date=? AND batch_time=? AND reserved_orders>0',[order.batch_date,order.batch_time]);
  requireValue(result.affectedRows===1,'批次接单计数异常，请联系掌柜核对',503);
  await conn.execute('UPDATE t_order SET capacity_reserved=0 WHERE id=?',[order.id]);
}
