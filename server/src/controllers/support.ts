import { Context } from 'koa';
import { createHash } from 'crypto';
import { query, withTransaction } from '../db';
import { positiveId, requireValue, text } from '../domain/errors';
import { beforeId, pageRows } from '../domain/pagination';
import { lockedOrder, ownOrder } from '../services/orders';
import { recordActivity } from '../services/activity';

const categories = ['QUALITY', 'MISSING', 'PAYMENT', 'OTHER'];

export async function createTicket(ctx: Context) {
  const body = ctx.request.body as any;
  const orderId = positiveId(body.order_id, '订单ID');
  requireValue(categories.includes(body.category), '请选择问题类型');
  const description = text(body.description, '问题说明', 1000);
  requireValue(typeof body.request_id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(body.request_id), '缺少售后请求号，请重新提交');
  const hash = createHash('sha256').update(JSON.stringify({orderId, category:body.category, description})).digest('hex');
  const id = await withTransaction(async conn => {
    const order = await lockedOrder(conn, orderId);
    ownOrder(order, ctx.state.user);
    const [existing]: any = await conn.execute('SELECT id,request_hash FROM t_support_ticket WHERE user_id=? AND request_id=?', [ctx.state.user.id, body.request_id]);
    if (existing.length) {
      requireValue(existing[0].request_hash === hash, '请求号已用于其他问题，请重新确认', 409);
      return existing[0].id;
    }
    const [active]: any = await conn.execute("SELECT id FROM t_support_ticket WHERE active_order_id=?", [orderId]);
    requireValue(!active.length, '该订单已有进行中的售后，请查看处理进度', 409);
    const [result]: any = await conn.execute('INSERT INTO t_support_ticket(order_id,user_id,request_id,request_hash,category,description) VALUES(?,?,?,?,?,?)', [orderId,ctx.state.user.id,body.request_id,hash,body.category,description]);
    await recordActivity(conn,'SUPPORT_OPENED',orderId,result.insertId);
    return result.insertId;
  });
  ctx.body = {code:0, data:{id}, msg:'问题已提交，掌柜将联系订单预留电话处理'};
}

async function listTickets(ctx: Context, admin: boolean) {
  const cursor = beforeId(ctx.query.before_id);
  let sql = `SELECT s.id,s.order_id,s.category,s.description,s.status,s.resolution,s.create_time,s.update_time,
    o.order_sn,o.order_status,o.batch_date,o.receiver_name,o.receiver_phone
    FROM t_support_ticket s JOIN t_order o ON o.id=s.order_id WHERE 1=1`;
  const params: any[] = [];
  if (!admin) { sql += ' AND s.user_id=?'; params.push(ctx.state.user.id); }
  if (ctx.query.order_id) { sql += ' AND s.order_id=?'; params.push(positiveId(ctx.query.order_id)); }
  if (ctx.query.status) {
    requireValue(['OPEN','PROCESSING','RESOLVED'].includes(String(ctx.query.status)), '售后状态无效');
    sql += ' AND s.status=?'; params.push(ctx.query.status);
  }
  if (cursor) { sql += ' AND s.id<?'; params.push(cursor); }
  const rows: any = await query(sql + ' ORDER BY s.id DESC LIMIT 31', params);
  ctx.body = {code:0, data:pageRows<any>(rows)};
}
export async function myTickets(ctx: Context) { await listTickets(ctx, false); }
export async function adminTickets(ctx: Context) { await listTickets(ctx, true); }

export async function handleTicket(ctx: Context) {
  const body = ctx.request.body as any, id = positiveId(body.id);
  requireValue(['PROCESSING','RESOLVED'].includes(body.status), '处理状态无效');
  const resolution = body.status === 'RESOLVED' ? text(body.resolution, '处理结果', 1000) : '';
  await withTransaction(async conn => {
    const [rows]: any = await conn.execute('SELECT * FROM t_support_ticket WHERE id=? FOR UPDATE', [id]);
    requireValue(rows.length, '售后记录不存在', 404);
    const ticket = rows[0];
    if (ticket.status === 'RESOLVED') {
      requireValue(body.status === 'RESOLVED' && ticket.resolution === resolution, '该售后已回复，不能覆盖原处理结果', 409);
      return;
    }
    await conn.execute('UPDATE t_support_ticket SET status=?,resolution=?,operator_id=? WHERE id=?', [body.status,resolution,ctx.state.user.id,id]);
  });
  ctx.body = {code:0, msg:body.status === 'RESOLVED' ? '回复已保存，资金状态请以订单退款结果为准' : '已接单处理'};
}
