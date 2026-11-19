import { createHash, randomBytes, randomInt } from 'crypto';
import { PoolConnection } from 'mysql2/promise';
import { query, withTransaction } from '../db';
import { BusinessError, requireValue } from '../domain/errors';
import { fen, normalizeItems, priceOrder, yuan } from '../domain/pricing';
import { chinaDate, chinaTimestamp, validateFulfillment } from '../domain/batches';
import { getConfigs } from './config';
import { changeBalance, creditReward, recoverReward } from './ledger';
import { WechatPay, WechatPayError } from './wechat-pay';
import { paymentProvider } from './payment-provider';
import { reserveCapacity, releaseCapacity } from './capacity';
import { recordActivity } from './activity';

export async function lockedOrder(conn: PoolConnection, id: number) {
  const [rows]: any = await conn.execute('SELECT * FROM t_order WHERE id = ? FOR UPDATE', [id]);
  requireValue(rows.length, '订单不存在', 404);
  return rows[0];
}
export function ownOrder(order: any, user: any, allowAdmin = false) {
  requireValue(order.user_id === user.id || (allowAdmin && user.is_admin === 1), '无权操作该订单', 403);
}
function newOrder(order: any) { requireValue(order.payment_state !== 'LEGACY', '历史订单需掌柜核对真实付款后处理，请联系掌柜', 409); }
export async function create(userId: number, body: any) {
  const items = normalizeItems(body.items);
  requireValue(typeof body.request_id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(body.request_id), '缺少有效下单请求号，请重新结算');
  requireValue(body.order_remark === undefined || (typeof body.order_remark === 'string' && body.order_remark.length <= 255), '备注最多255字');
  const canonical = { items, delivery_type: body.delivery_type, receiver_name: body.receiver_name, receiver_phone: body.receiver_phone,
    receiver_address: body.receiver_address || '', delivery_area: body.delivery_area || '', batch_date: body.batch_date, batch_time: body.batch_time,
    use_normal_points: body.use_normal_points === true, use_red_packet_points: body.use_red_packet_points === true,
    custom_red_amount: body.custom_red_amount ?? null, order_remark: body.order_remark || '', expected_pay_amount: body.expected_pay_amount };
  const hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return withTransaction(async conn => {
    const [users]: any = await conn.execute('SELECT * FROM t_user WHERE id = ? FOR UPDATE', [userId]);
    const user = users[0];
    requireValue(user, '用户不存在', 401);
    const [existing]: any = await conn.execute('SELECT * FROM t_order WHERE user_id = ? AND request_id = ?', [userId, body.request_id]);
    if (existing.length) {
      requireValue(existing[0].request_hash === hash, '请求号已用于其他结算，请重新确认', 409);
      return { order_id: existing[0].id, order_sn: existing[0].order_sn, pay_amount: yuan(fen(existing[0].pay_amount)) };
    }
    const config = await getConfigs(conn), slot = validateFulfillment(body, config);
    await reserveCapacity(conn,slot.date,slot.time,config);
    const products: any[] = [];
    // Product and stock locks are always acquired in ascending product order.
    for (const item of items) {
      const [rows]: any = await conn.execute('SELECT * FROM t_product WHERE id = ? FOR UPDATE', [item.product_id]);
      requireValue(rows.length && rows[0].is_deleted === 0, '购物车包含已下架菜品', 409);
      const product = rows[0];
      await conn.execute('INSERT IGNORE INTO t_batch_stock (batch_date,batch_time,product_id,available_qty) VALUES (?,?,?,?)', [slot.date, slot.time, product.id, product.stock_qty]);
      const [stocks]: any = await conn.execute('SELECT available_qty FROM t_batch_stock WHERE batch_date=? AND batch_time=? AND product_id=? FOR UPDATE', [slot.date, slot.time, product.id]);
      products.push({ ...product, stock_qty: stocks[0].available_qty });
    }
    const finances = priceOrder(products, items, user, config, body);
    requireValue(body.expected_pay_amount !== undefined && fen(body.expected_pay_amount) === fen(finances.final_pay_amount), '价格或优惠已变化，请重新确认账单', 409);
    if (fen(finances.final_pay_amount) > 0) paymentProvider(); // Missing real configuration never falls back to simulation.
    const now = new Date(), expires = new Date(Math.min(now.getTime() + Number(config.ORDER_EXPIRE_MINUTES) * 60000, Date.parse(`${slot.date}T${slot.cutoff}:00+08:00`)));
    const orderSn = `PXD${Date.now()}${randomBytes(5).toString('hex')}`;
    const [result]: any = await conn.execute(`INSERT INTO t_order (
      order_sn,user_id,delivery_type,delivery_address,receiver_name,receiver_phone,pickup_code,expect_time_slot,order_remark,
      goods_total_amount,member_discount_amount,normal_points_deduct,used_normal_points,red_packet_deduct,used_red_packet_points,delivery_fee,pay_amount,
      order_status,request_id,request_hash,batch_date,batch_time,expires_at,payment_state,stock_reserved,commission_rate,referrer_id,capacity_reserved)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,10,?,?,?,?,?,'UNPAID',1,?,?,1)`,
      [orderSn,userId,body.delivery_type,body.delivery_type === 1 ? body.receiver_address.trim() : config.WORKSHOP_ADDRESS,
        body.receiver_name.trim(),body.receiver_phone,body.delivery_type === 2 ? String(randomInt(1000,10000)) : '',`${slot.date} ${slot.time}`,body.order_remark || '',
        finances.goods_origin_total,finances.member_discount,finances.normal_deduct,finances.used_normal_points,finances.red_deduct,finances.used_red_points,
        finances.delivery_fee,finances.final_pay_amount,body.request_id,hash,slot.date,slot.time,chinaTimestamp(expires),config.COMMISSION_RATE,user.referrer_id || null]);
    const id = result.insertId;
    for (const item of finances.verified_items) {
      const [stock]: any = await conn.execute('UPDATE t_batch_stock SET available_qty=available_qty-? WHERE batch_date=? AND batch_time=? AND product_id=? AND available_qty>=?', [item.quantity,slot.date,slot.time,item.product_id,item.quantity]);
      requireValue(stock.affectedRows, '剩余份数不足，请重新选择', 409);
      await conn.execute('INSERT INTO t_order_item(order_id,product_id,product_title,product_img,price,quantity,subtotal) VALUES(?,?,?,?,?,?,?)', [id,item.product_id,item.title,item.cover_img,item.price,item.quantity,item.subtotal]);
    }
    if (finances.used_normal_points) await changeBalance(conn,userId,'NORMAL_POINT',-finances.used_normal_points,'ORDER_RESERVE',id,'订单预占普通积分');
    if (fen(finances.used_red_points)) await changeBalance(conn,userId,'RED_PACKET',-fen(finances.used_red_points),'ORDER_RESERVE',id,'订单预占红包');
    return { order_id:id, order_sn:orderSn, pay_amount:finances.final_pay_amount };
  });
}
export async function releaseBenefits(conn: PoolConnection, order: any) {
  if (order.benefits_released) return;
  if (order.used_normal_points) await changeBalance(conn,order.user_id,'NORMAL_POINT',Number(order.used_normal_points),'ORDER_RELEASE',order.id,'订单取消或退款返还普通积分');
  if (fen(order.used_red_packet_points)) await changeBalance(conn,order.user_id,'RED_PACKET',fen(order.used_red_packet_points),'ORDER_RELEASE',order.id,'订单取消或退款返还红包');
  if (order.stock_reserved && (order.refund_origin_status == null || order.refund_origin_status <= 20)) {
    const [items]: any = await conn.execute('SELECT product_id,quantity FROM t_order_item WHERE order_id=? ORDER BY product_id', [order.id]);
    for (const item of items) await conn.execute('UPDATE t_batch_stock SET available_qty=available_qty+? WHERE batch_date=? AND batch_time=? AND product_id=?', [item.quantity,order.batch_date,order.batch_time,item.product_id]);
  }
  await conn.execute('UPDATE t_order SET benefits_released=1,stock_reserved=0 WHERE id=?', [order.id]);
  await releaseCapacity(conn,order);
}
export function validatePayment(order: any, buyerOpenid: string, data: any, config: {appid:string;mchid:string}) {
  requireValue(data?.trade_state === 'SUCCESS' && data.trade_type === 'JSAPI', '交易尚未支付成功', 409);
  requireValue(data.appid === config.appid && data.mchid === config.mchid && data.out_trade_no === order.order_sn && data.payer?.openid === buyerOpenid, '支付交易身份不匹配', 409);
  requireValue(data.amount?.currency === 'CNY' && data.amount.total === fen(order.pay_amount), '支付交易金额不匹配', 409);
  requireValue(typeof data.transaction_id === 'string' && data.transaction_id.length <= 64 && data.transaction_id.length > 0, '支付交易号无效');
  requireValue(Number.isSafeInteger(data.amount.payer_total) && data.amount.payer_total >= 0 && data.amount.payer_total <= data.amount.total, '实际付款金额无效');
}
export async function recordPaid(conn: PoolConnection, order: any, data?: any, provider?: WechatPay) {
  newOrder(order);
  const [users]: any = await conn.execute('SELECT * FROM t_user WHERE id=? FOR UPDATE', [order.user_id]);
  const buyer = users[0];
  if (fen(order.pay_amount) > 0) {
    requireValue(provider && data, '缺少真实支付结果');
    validatePayment(order,buyer.openid,data,provider.config);
  } else requireValue(!data, '零元订单不接受外部支付结果');
  const transactionId = data?.transaction_id || null;
  if (order.payment_state !== 'UNPAID') {
    requireValue(order.transaction_id === transactionId, '订单支付流水不一致', 409);
    return;
  }
  if (order.order_status === 60) {
    // Late notifications for cancelled orders must be refunded, never silently lost or fulfilled.
    await conn.execute("UPDATE t_order SET order_status=70,payment_state='REFUNDING',transaction_id=?,pay_time=NOW(),refund_sn=?,payer_paid_amount=? WHERE id=?", [transactionId,`RF${order.order_sn}`,yuan(data.amount.payer_total),order.id]);
    return;
  }
  requireValue(order.order_status === 10, '订单状态无法入账', 409);
  const goodsCash = Math.max(0,(data ? data.amount.payer_total : 0)-fen(order.delivery_fee));
  await conn.execute("UPDATE t_order SET order_status=20,payment_state='PAID',transaction_id=?,pay_time=NOW(),paid_goods_amount=?,payer_paid_amount=? WHERE id=?", [transactionId,yuan(goodsCash),yuan(data ? data.amount.payer_total : 0),order.id]);
  await conn.execute('UPDATE t_user SET total_consume_amount=total_consume_amount+? WHERE id=?', [yuan(goodsCash),buyer.id]);
  const config = await getConfigs(conn);
  if (config.MEMBER_ENTRY_MODE === 'CONSUME' && buyer.is_member === 0 && !buyer.member_opt_out && fen(buyer.total_consume_amount)+goodsCash >= fen(config.MEMBER_ENTRY_THRESHOLD)) {
    await conn.execute("UPDATE t_user SET is_member=1,member_source='CONSUME' WHERE id=?", [buyer.id]);
  }
  await recordActivity(conn,'ORDER_PAID',order.id);
}
export async function createPayment(id: number, user: any) {
  return withTransaction(async conn => {
    const order = await lockedOrder(conn,id); ownOrder(order,user); newOrder(order);
    requireValue(order.order_status === 10 && order.payment_state === 'UNPAID', '订单已支付或已关闭', 409);
    requireValue(order.expires_at > chinaTimestamp(), '付款已超时，请重新下单', 409);
    if (!fen(order.pay_amount)) { await recordPaid(conn,order); return { paid:true }; }
    const provider = paymentProvider();
    const prepay = order.prepay_id || await provider.prepay(order,user.openid);
    await conn.execute('UPDATE t_order SET prepay_id=? WHERE id=?', [prepay,id]);
    return { paid:false, payment:provider.paymentParams(prepay) };
  });
}
export async function syncPayment(id: number, user?: any) {
  await withTransaction(async conn => {
    const order = await lockedOrder(conn,id); if (user) ownOrder(order,user,true); newOrder(order);
    if (order.payment_state !== 'UNPAID' || !fen(order.pay_amount)) return;
    const provider = paymentProvider();
    try {
      const result = await provider.query(order.order_sn);
      if (result.trade_state === 'SUCCESS') await recordPaid(conn,order,result,provider);
    } catch (err) { if (!(err instanceof WechatPayError && err.providerCode === 'ORDER_NOT_EXIST')) throw err; }
  });
}
export async function cancel(id: number, user?: any, expiredOnly = false) {
  await withTransaction(async conn => {
    let order = await lockedOrder(conn,id); if (user) ownOrder(order,user,true); newOrder(order);
    if ([50,60,70].includes(order.order_status)) return;
    if (expiredOnly && (order.order_status !== 10 || order.expires_at > chinaTimestamp())) return;
    requireValue([10,20].includes(order.order_status), '订单已开始履约，请联系掌柜处理售后', 409);
    if (order.order_status === 10) {
      if (fen(order.pay_amount)) {
        const provider = paymentProvider();
        try { await provider.close(order.order_sn); }
        catch (err) {
          if (err instanceof WechatPayError && err.providerCode === 'ORDERPAID') {
            await recordPaid(conn,order,await provider.query(order.order_sn),provider);
            order = await lockedOrder(conn,id);
            if (expiredOnly) return; // A successful payment wins an expiry race.
          } else if (!(err instanceof WechatPayError && err.providerCode === 'ORDER_NOT_EXIST')) throw err;
        }
      }
      if (order.order_status === 10) {
        await releaseBenefits(conn,order);
        await conn.execute('UPDATE t_order SET order_status=60,closed_time=NOW() WHERE id=?', [id]);
        return;
      }
    }
    await conn.execute("UPDATE t_order SET refund_origin_status=order_status,order_status=70,payment_state='REFUNDING',refund_sn=?,refund_error='' WHERE id=?", [`RF${order.order_sn}`,id]);
  });
  await processRefund(id);
}
export async function afterSalesRefund(id: number, user: any, reason: string) {
  requireValue(user.is_admin === 1, '仅掌柜可处理售后退款', 403);
  requireValue(typeof reason === 'string' && reason.trim().length >= 2 && reason.trim().length <= 255, '请填写2至255字的退款原因');
  await withTransaction(async conn => {
    const order = await lockedOrder(conn,id); newOrder(order);
    if (order.payment_state === 'REFUNDED' || order.payment_state === 'REFUNDING') return;
    requireValue(order.payment_state === 'PAID' && [20,25,30,40].includes(order.order_status), '当前订单不能申请售后退款', 409);
    await conn.execute("UPDATE t_order SET refund_origin_status=order_status,order_status=70,payment_state='REFUNDING',refund_sn=?,refund_reason=?,refund_error='' WHERE id=?",
      [`RF${order.order_sn}`,reason.trim(),id]);
  });
  await processRefund(id);
}
function validateRefund(order: any, data: any, provider: WechatPay) {
  requireValue(data.out_trade_no === order.order_sn && data.out_refund_no === order.refund_sn && data.transaction_id === order.transaction_id, '退款流水不匹配', 409);
  requireValue(data.amount?.total === fen(order.pay_amount) && data.amount?.refund === fen(order.pay_amount), '退款金额不匹配', 409);
  if (data.mchid !== undefined) requireValue(data.mchid === provider.config.mchid, '退款商户不匹配', 409);
}
export async function recordRefund(conn: PoolConnection, order: any, data?: any, provider?: WechatPay) {
  if (fen(order.pay_amount)) { requireValue(provider && data, '缺少退款结果'); validateRefund(order,data,provider); }
  if (order.payment_state === 'REFUNDED') return;
  requireValue(order.order_status === 70 && order.payment_state === 'REFUNDING', '订单未申请退款', 409);
  if (data && (data.status || data.refund_status) !== 'SUCCESS') {
    await conn.execute('UPDATE t_order SET refund_error=? WHERE id=?', [(data.status || data.refund_status) === 'PROCESSING' ? '' : '退款异常，请掌柜核对商户平台',order.id]); return;
  }
  const payerRefund=data?.amount?.payer_refund;
  requireValue(payerRefund===undefined || (Number.isSafeInteger(payerRefund) && payerRefund>=0 && payerRefund<=fen(order.pay_amount)), '顾客实退金额无效',409);
  if(payerRefund!==undefined && order.payer_paid_amount!=null)requireValue(payerRefund<=fen(order.payer_paid_amount),'顾客实退金额超过已记录实付',409);
  await releaseBenefits(conn,order);
  if (order.earned_normal_points) await recoverReward(conn,order.user_id,'NORMAL_POINT',Number(order.earned_normal_points),order.id);
  const [commissions]: any = await conn.execute('SELECT id,referrer_user_id,reward_red_points FROM t_commission_flow WHERE order_id=? AND status=1 FOR UPDATE', [order.id]);
  for (const commission of commissions) {
    await recoverReward(conn,commission.referrer_user_id,'RED_PACKET',fen(commission.reward_red_points),order.id);
    await conn.execute('UPDATE t_commission_flow SET status=2 WHERE id=? AND status=1',[commission.id]);
  }
  await conn.execute('UPDATE t_user SET total_consume_amount=GREATEST(0,total_consume_amount-?) WHERE id=?', [order.paid_goods_amount,order.user_id]);
  const config = await getConfigs(conn);
  await conn.execute("UPDATE t_user SET is_member=0 WHERE id=? AND member_source='CONSUME' AND total_consume_amount<?", [order.user_id,config.MEMBER_ENTRY_THRESHOLD]);
  await conn.execute("UPDATE t_order SET order_status=50,payment_state='REFUNDED',closed_time=NOW(),refund_error='',payer_refund_amount=? WHERE id=?", [fen(order.pay_amount)===0?'0.00':payerRefund===undefined?null:yuan(payerRefund),order.id]);
}
export async function processRefund(id: number) {
  try {
    await withTransaction(async conn => {
      const order = await lockedOrder(conn,id);
      if (order.order_status !== 70) return;
      if (!fen(order.pay_amount)) { await recordRefund(conn,order); return; }
      const provider = paymentProvider();
      let result;
      try { result = await provider.queryRefund(order.refund_sn); }
      catch (err) {
        if (!(err instanceof WechatPayError && err.providerCode === 'RESOURCE_NOT_EXISTS')) throw err;
        result = await provider.refund(order);
      }
      await recordRefund(conn,order,result,provider);
    });
  } catch (err: any) {
    console.error('Refund reconciliation failed', { orderId:id, code:err.providerCode || err.name });
    await query('UPDATE t_order SET refund_error=? WHERE id=? AND order_status=70', ['退款处理中，掌柜正在核对支付渠道',id]);
  }
}
export async function complete(id: number, user: any, pickupCode?: unknown, deliveryConfirmation?: {confirmed?:unknown;note?:unknown}) {
  await withTransaction(async conn => {
    const order = await lockedOrder(conn,id); ownOrder(order,user,true); newOrder(order);
    if (order.order_status === 40) return;
    requireValue(order.payment_state === 'PAID', '订单尚未支付或正在退款', 409);
    if (order.delivery_type === 2) {
      requireValue(user.is_admin === 1 && order.order_status === 25, '自提须由掌柜核销待取餐订单', 403);
      requireValue(typeof pickupCode === 'string' && pickupCode === order.pickup_code, '自提码不正确');
    } else {
      requireValue(order.order_status === 30, '仅配送中的订单可以确认送达', 409);
      if(user.is_admin===1)requireValue(deliveryConfirmation?.confirmed===true && typeof deliveryConfirmation.note==='string' && deliveryConfirmation.note.trim().length>=2 && deliveryConfirmation.note.trim().length<=255,'请确认已与顾客核实送达，并填写2至255字的确认说明');
    }
    const earned = Math.floor(fen(order.paid_goods_amount)/100);
    if (earned) await creditReward(conn,order.user_id,'NORMAL_POINT',earned,'ORDER_EARN',id,'订单完成赠积分');
    if (order.referrer_id) {
      const [refs]: any = await conn.execute('SELECT is_member FROM t_user WHERE id=? FOR UPDATE', [order.referrer_id]);
      const reward = Math.floor((fen(order.paid_goods_amount)*Math.round(Number(order.commission_rate)*100)+50)/100);
      if (refs[0]?.is_member === 1 && reward > 0) {
        await conn.execute('INSERT INTO t_commission_flow (referrer_user_id,buyer_user_id,order_id,order_cash_base,commission_rate,reward_red_points,status) VALUES (?,?,?,?,?,?,1)', [order.referrer_id,order.user_id,id,order.paid_goods_amount,order.commission_rate,yuan(reward)]);
        await creditReward(conn,order.referrer_id,'RED_PACKET',reward,'REFERRAL_EARN',id,'好友订单完成推荐奖励');
      }
    }
    const source=user.is_admin===1 ? (order.delivery_type===2 ? 'ADMIN_PICKUP' : 'ADMIN_DELIVERY') : 'CUSTOMER';
    const note=source==='ADMIN_DELIVERY' ? (deliveryConfirmation!.note as string).trim() : source==='ADMIN_PICKUP' ? '掌柜核验自提码后交付餐品' : '顾客确认收到餐品';
    await conn.execute('UPDATE t_order SET order_status=40,completed_time=NOW(),earned_normal_points=?,completed_by=?,completion_source=?,completion_note=? WHERE id=?', [earned,user.id,source,note,id]);
  });
}
let reconciliationRunning = false;
let expiryCursor=0,refundCursor=0;
async function reconciliationBatch(predicate:string,cursor:number):Promise<any[]> {
  const rows:any=await query(`SELECT id FROM t_order WHERE ${predicate} AND id>? ORDER BY id LIMIT 20`,[cursor]);
  // Failed work stays pending. Wrap only at the end, so a persistent error at
  // the front cannot prevent later orders from being attempted.
  if(rows.length || cursor===0)return rows;
  return query(`SELECT id FROM t_order WHERE ${predicate} ORDER BY id LIMIT 20`);
}
export async function reconcileOrders() {
  if (reconciliationRunning) return;
  reconciliationRunning = true;
  try {
    const expired=await reconciliationBatch("order_status=10 AND payment_state='UNPAID' AND expires_at<=NOW()",expiryCursor);
    for (const order of expired) {
      expiryCursor=order.id;
      try { await cancel(order.id,undefined,true); } catch (err: any) { console.error('Order expiry retry required',{orderId:order.id,code:err.providerCode || err.name}); }
    }
    const refunds=await reconciliationBatch("order_status=70 AND payment_state='REFUNDING'",refundCursor);
    for (const order of refunds){refundCursor=order.id;await processRefund(order.id);}
  } finally { reconciliationRunning = false; }
}
