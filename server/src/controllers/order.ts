import { Context } from 'koa';
import { query, withTransaction } from '../db';
import { requireValue, positiveId } from '../domain/errors';
import { fen, normalizeItems, priceOrder, yuan } from '../domain/pricing';
import { batchSlots, chinaDate } from '../domain/batches';
import { getConfigs } from '../services/config';
import { WechatPay } from '../services/wechat-pay';
import * as orders from '../services/orders';
import { readCapacity } from '../services/capacity';
import { activitySnapshot } from '../services/activity';

export async function getBatches(ctx: Context) {
  const config = await getConfigs();
  const available=[],full=[];
  for (const slot of batchSlots(config)) {
    const capacity=await readCapacity(slot.date,slot.time,config);
    if(capacity.full)full.push(slot.label);else available.push(slot);
  }
  ctx.body = { code:0, data:{ slots:available,full_batch_labels:full, delivery_areas:config.DELIVERY_AREAS.split(/[,，\n]/).map(s=>s.trim()).filter(Boolean), config } };
}
export async function calculateOrder(ctx: Context) {
  const body = ctx.request.body as any, items = normalizeItems(body.items), products: any[] = [];
  const config = await getConfigs();
  requireValue(batchSlots(config).some(s=>s.date === body.batch_date && s.time === body.batch_time), '请选择有效预约批次', 409);
  requireValue(!(await readCapacity(body.batch_date,body.batch_time,config)).full,'该批次已接满，请选择其他批次',409);
  for (const item of items) {
    const rows: any = await query('SELECT * FROM t_product WHERE id=?', [item.product_id]);
    if (rows.length) {
      const stocks: any = await query('SELECT available_qty FROM t_batch_stock WHERE batch_date=? AND batch_time=? AND product_id=?', [body.batch_date,body.batch_time,item.product_id]);
      products.push({...rows[0],stock_qty:stocks.length ? stocks[0].available_qty : rows[0].stock_qty});
    }
  }
  const users: any = await query('SELECT * FROM t_user WHERE id=?', [ctx.state.user.id]);
  ctx.body = { code:0, data:priceOrder(products,items,users[0],config,body) };
}
export async function createOrder(ctx: Context) { ctx.body = { code:0, data:await orders.create(ctx.state.user.id,ctx.request.body) }; }
export async function payOrderSuccess(ctx: Context) { ctx.status=410;ctx.body={code:410,msg:'客户端不能声明支付成功，请使用微信支付'}; }
export async function payment(ctx: Context) { ctx.body={code:0,data:await orders.createPayment(positiveId((ctx.request.body as any).order_id),ctx.state.user)}; }
function actor(ctx: Context) {
  // Administrator overrides are available only on the audited management routes.
  return {...ctx.state.user, is_admin:ctx.path.startsWith('/api/admin/') ? ctx.state.user.is_admin : 0};
}
export async function syncPayment(ctx: Context) {
  const id=positiveId((ctx.request.body as any).order_id);
  await orders.syncPayment(id,actor(ctx));
  ctx.body={code:0,data:await orderDetail(id,ctx.state.user)};
}
export async function cancelOrder(ctx: Context) {
  const id=positiveId((ctx.request.body as any).order_id);
  await orders.cancel(id,actor(ctx));
  ctx.body={code:0,msg:'取消请求已处理',data:await orderDetail(id,ctx.state.user,true)};
}
export async function afterSalesRefund(ctx: Context) {
  const body=ctx.request.body as any, id=positiveId(body.order_id);
  await orders.afterSalesRefund(id,actor(ctx),body.reason);
  ctx.body={code:0,msg:'退款申请已处理，请核对退款状态',data:await orderDetail(id,ctx.state.user,true)};
}
export async function completeOrder(ctx: Context) {
  const body=ctx.request.body as any;
  await orders.complete(positiveId(body.order_id),actor(ctx),body.pickup_code,{confirmed:body.delivery_confirmed,note:body.confirmation_note});
  ctx.body={code:0,msg:'订单已完成'};
}
export async function dispatchDelivery(ctx: Context) {
  const body=ctx.request.body as any, config=await getConfigs();
  const date=body.batch_date || chinaDate(), time=body.batch_time || config.BATCH_SCHEDULE_TIME;
  requireValue(date===chinaDate() && /^\d{2}:\d{2}$/.test(time), '只能处理今日指定批次',409);
  const params: any[]=[config.DELIVERY_PERSON_NAME,config.DELIVERY_PERSON_PHONE,date,time];
  let sql="UPDATE t_order SET order_status=30,dispatched_time=NOW(),delivery_person_name=?,delivery_person_phone=? WHERE payment_state='PAID' AND order_status=20 AND delivery_type=1 AND batch_date=? AND batch_time=?";
  if(body.order_id) {sql+=' AND id=?';params.push(positiveId(body.order_id));}
  const result: any=await query(sql,params);
  requireValue(result.affectedRows,'没有可发车的今日自送订单',409);
  ctx.body={code:0,msg:`已发车${result.affectedRows}笔自送订单`};
}
export async function readyPickup(ctx: Context) {
  const result: any=await query("UPDATE t_order SET order_status=25 WHERE id=? AND payment_state='PAID' AND order_status=20 AND delivery_type=2 AND batch_date=?",[positiveId((ctx.request.body as any).order_id),chinaDate()]);
  requireValue(result.affectedRows,'订单尚未付款、不是今日自提或已经处理',409);
  ctx.body={code:0,msg:'已标记可取餐'};
}
async function attachDetails(list: any[]) {
  if(!list.length) return list;
  const items: any=await query(`SELECT * FROM t_order_item WHERE order_id IN (${list.map(()=>'?').join(',')}) ORDER BY id`,list.map(o=>o.id));
  return list.map(o=>({...o,items:items.filter((i:any)=>i.order_id===o.id),
    goods_origin_total:yuan(fen(o.goods_total_amount)),member_discount:yuan(fen(o.member_discount_amount)),normal_deduct:yuan(fen(o.normal_points_deduct)),red_deduct:yuan(fen(o.red_packet_deduct)),
    final_pay_amount:yuan(fen(o.pay_amount)),receiver_address:o.delivery_address,create_time_formatted:o.create_time,
    pickup_code:o.payment_state==='PAID' ? o.pickup_code : '',
    summary_text:items.filter((i:any)=>i.order_id===o.id).map((i:any)=>`${i.product_title} ×${i.quantity}`).join('、')}));
}
async function orderDetail(id: number,user: any,admin=false) {
  const rows: any=await query('SELECT * FROM t_order WHERE id=?',[id]);
  requireValue(rows.length,'订单不存在',404);orders.ownOrder(rows[0],user,admin);
  return (await attachDetails(rows))[0];
}
export async function getOrderDetail(ctx: Context) { ctx.body={code:0,data:await orderDetail(positiveId(ctx.query.id),ctx.state.user)}; }
async function listOrders(ctx: Context,admin: boolean) {
  let sql='SELECT * FROM t_order WHERE 1=1';const params: any[]=[];
  if(!admin) {sql+=' AND user_id=?';params.push(ctx.state.user.id);}
  if(ctx.query.status) {
    const statuses=String(ctx.query.status).split(',').map(Number);
    requireValue(statuses.length<=8 && statuses.every(n=>[10,20,25,30,40,50,60,70].includes(n)),'订单状态无效');
    sql+=` AND order_status IN (${statuses.map(()=>'?').join(',')})`;params.push(...statuses);
  }
  if(ctx.query.batch_date) {requireValue(/^\d{4}-\d{2}-\d{2}$/.test(String(ctx.query.batch_date)),'日期无效');sql+=' AND batch_date=?';params.push(ctx.query.batch_date);}
  if(ctx.query.delivery_type) {requireValue(['1','2'].includes(String(ctx.query.delivery_type)),'配送方式无效');sql+=' AND delivery_type=?';params.push(Number(ctx.query.delivery_type));}
  if(ctx.query.overdue_pickup!==undefined) {
    requireValue(admin && ctx.query.overdue_pickup==='1','未取餐筛选无效');
    sql+=" AND order_status=25 AND payment_state='PAID' AND delivery_type=2 AND batch_date<?";params.push(chinaDate());
  }
  if(ctx.query.before_id) {sql+=' AND id<?';params.push(positiveId(ctx.query.before_id));}
  if(admin && ctx.query.keyword) {
    requireValue(typeof ctx.query.keyword==='string' && ctx.query.keyword.length<=64,'搜索内容过长');
    sql+=' AND (order_sn LIKE ? OR receiver_phone LIKE ?)';params.push(`%${ctx.query.keyword}%`,`%${ctx.query.keyword}%`);
  }
  sql+=' ORDER BY id DESC LIMIT 30';
  const rows: any=await query(sql,params);
  ctx.set('Cache-Control','no-store');
  ctx.body={code:0,data:await attachDetails(rows),next_cursor:rows.length===30 ? rows[rows.length-1].id : null,server_time:Date.now()};
}
export async function getOrderList(ctx: Context) { await listOrders(ctx,false); }
export async function getAdminOrderList(ctx: Context) { await listOrders(ctx,true); }
export async function batchCapacity(ctx: Context) {
  const config=await getConfigs(),date=String(ctx.query.batch_date || chinaDate()),time=String(ctx.query.batch_time || config.BATCH_SCHEDULE_TIME);
  requireValue(/^\d{4}-\d{2}-\d{2}$/.test(date) && /^([01]\d|2[0-3]):[0-5]\d$/.test(time),'批次无效');
  ctx.body={code:0,data:await readCapacity(date,time,config)};
}
export async function adminActivity(ctx: Context) {
  ctx.body={code:0,data:await activitySnapshot(ctx.query.after_revision===undefined ? undefined : Number(ctx.query.after_revision))};
}
export async function paymentNotify(ctx: Context) {
  const provider=new WechatPay(), notification=provider.notification((ctx.request as any).rawBody,ctx.headers);
  requireValue(notification.event==='TRANSACTION.SUCCESS','通知类型无效');
  await withTransaction(async conn=>{
    const [rows]: any=await conn.execute('SELECT * FROM t_order WHERE order_sn=? FOR UPDATE',[notification.data.out_trade_no]);
    requireValue(rows.length,'订单不存在',404);
    await orders.recordPaid(conn,rows[0],notification.data,provider);
  });
  ctx.status=204;
}
export async function refundNotify(ctx: Context) {
  const provider=new WechatPay(), notification=provider.notification((ctx.request as any).rawBody,ctx.headers);
  requireValue(['REFUND.SUCCESS','REFUND.ABNORMAL','REFUND.CLOSED'].includes(notification.event),'通知类型无效');
  requireValue(notification.data.refund_status===notification.event.split('.')[1],'退款通知状态不一致');
  await withTransaction(async conn=>{
    const [rows]: any=await conn.execute('SELECT * FROM t_order WHERE refund_sn=? FOR UPDATE',[notification.data.out_refund_no]);
    requireValue(rows.length,'退款订单不存在',404);
    await orders.recordRefund(conn,rows[0],notification.data,provider);
  });
  ctx.status=204;
}
export async function preparation(ctx: Context) {
  const date=String(ctx.query.batch_date || chinaDate()), config=await getConfigs();
  requireValue(/^\d{4}-\d{2}-\d{2}$/.test(date),'日期无效');
  const rows=await query(`SELECT i.product_id,i.product_title,SUM(i.quantity) AS quantity FROM t_order o
    JOIN t_order_item i ON i.order_id=o.id WHERE o.batch_date=? AND o.batch_time=? AND o.order_status=20 AND o.payment_state='PAID'
    GROUP BY i.product_id,i.product_title ORDER BY i.product_id`,[date,ctx.query.batch_time || config.BATCH_SCHEDULE_TIME]);
  ctx.body={code:0,data:rows};
}
