import { PoolConnection } from 'mysql2/promise';
import { withTransaction } from '../db';
import { requireValue } from '../domain/errors';
import { chinaDate } from '../domain/batches';

export async function recordActivity(conn: PoolConnection, kind: 'ORDER_PAID' | 'SUPPORT_OPENED', orderId: number, supportId: number | null = null) {
  // Serialize revisions until commit: AUTO_INCREMENT alone can skip an earlier
  // uncommitted event when a later transaction commits first.
  const [rows]: any = await conn.execute('SELECT revision FROM t_activity_cursor WHERE id=1 FOR UPDATE');
  requireValue(rows.length===1,'工作台动态记录尚未就绪',503);
  const revision=Number(rows[0].revision)+1;
  requireValue(Number.isSafeInteger(revision),'工作台动态记录超出范围',503);
  await conn.execute('UPDATE t_activity_cursor SET revision=? WHERE id=1',[revision]);
  await conn.execute('INSERT INTO t_admin_activity(revision,kind,order_id,support_id) VALUES(?,?,?,?)',[revision,kind,orderId,supportId]);
}

export async function activitySnapshot(after?: number) {
  requireValue(after===undefined || (Number.isSafeInteger(after) && after>=0),'动态分页参数无效');
  return withTransaction(async conn=>{
    const [clock]: any=await conn.execute('SELECT revision FROM t_activity_cursor WHERE id=1');
    requireValue(clock.length===1,'工作台动态记录尚未就绪',503);
    const revision=Number(clock[0].revision),reset=after!==undefined && after>revision;
    const baseline=after===undefined || reset ? revision : after;
    const [events]: any=await conn.execute('SELECT revision,kind,order_id,support_id FROM t_admin_activity WHERE revision>? AND revision<=? ORDER BY revision LIMIT 51',[baseline,revision]);
    const [queues]: any=await conn.execute(`SELECT
      (SELECT COUNT(*) FROM t_order WHERE payment_state='PAID' AND order_status=20) AS to_prepare,
      (SELECT COUNT(*) FROM t_order WHERE payment_state='PAID' AND order_status=25) AS ready_pickup,
      (SELECT COUNT(*) FROM t_order WHERE payment_state='PAID' AND order_status=30) AS in_delivery,
      (SELECT COUNT(*) FROM t_order WHERE payment_state='PAID' AND order_status=25 AND batch_date<?) AS overdue_pickup,
      (SELECT COUNT(*) FROM t_order WHERE payment_state='REFUNDING' AND order_status=70) AS refund_pending,
      (SELECT COUNT(*) FROM t_support_ticket WHERE status='OPEN') AS support_open,
      (SELECT COUNT(*) FROM t_privacy_request WHERE status='OPEN') AS privacy_open`,[chinaDate()]);
    const more=events.length>50,list=events.slice(0,50);
    return {cursor:more ? Number(list[list.length-1].revision) : revision,has_more:more,reset,
      events:list,queues:queues[0],checked_at:new Date().toISOString()};
  });
}
