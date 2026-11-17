import { Context } from 'koa';
import { query } from '../db';

// 辅助方法：读取系统配置项
async function getConfigValue(key: string, defaultVal: string): Promise<string> {
  const rows: any = await query('SELECT config_value FROM t_system_config WHERE config_key = ? LIMIT 1', [key]);
  if (rows && rows.length > 0) {
    return rows[0].config_value;
  }
  return defaultVal;
}

/**
 * 结算试算核心方法 (用于预估与下单防篡改双重校验)
 */
async function computeOrderFinancials(params: {
  userId: number;
  isMember: boolean;
  userNormalPoints: number;
  userRedPoints: number;
  items: Array<{ product_id: number; quantity: number }>;
  deliveryType: number; // 1: 自送, 2: 自提
  useNormalPoints?: boolean;
  useRedPacketPoints?: boolean;
  customRedAmount?: number;
}) {
  let goodsOriginTotal = 0;
  let goodsMemberTotal = 0;
  const verifiedItems: Array<{
    product_id: number;
    title: string;
    cover_img: string;
    price: number;
    quantity: number;
    subtotal: number;
  }> = [];

  for (const item of params.items) {
    const products: any = await query('SELECT * FROM t_product WHERE id = ?', [item.product_id]);
    if (products.length > 0) {
      const p = products[0];
      const originP = Number(p.origin_price);
      const memberP = Number(p.member_price);
      const qty = Math.max(1, parseInt(item.quantity.toString(), 10));

      goodsOriginTotal += originP * qty;
      goodsMemberTotal += memberP * qty;

      const effectivePrice = params.isMember ? memberP : originP;
      verifiedItems.push({
        product_id: p.id,
        title: p.title,
        cover_img: p.cover_img,
        price: effectivePrice,
        quantity: qty,
        subtotal: Number((effectivePrice * qty).toFixed(2))
      });
    }
  }

  // 会员打折减免
  const baseGoodsPrice = params.isMember ? goodsMemberTotal : goodsOriginTotal;
  const memberDiscount = params.isMember ? Number((goodsOriginTotal - goodsMemberTotal).toFixed(2)) : 0.00;

  // 普通积分满减计算 (满100积分减5元)
  let normalDeduct = 0.00;
  let usedNormalPoints = 0;
  if (params.useNormalPoints && params.userNormalPoints >= 100) {
    normalDeduct = 5.00;
    usedNormalPoints = 100;
  }

  // 红包积分抵扣限制 (读取后台动态上限，默认50%)
  const maxDeductRatio = parseFloat(await getConfigValue('RED_PACKET_MAX_DEDUCT_RATIO', '0.50'));
  let redDeduct = 0.00;

  if (params.useRedPacketPoints && params.isMember && params.userRedPoints > 0) {
    const maxAllowedByRatio = Number((baseGoodsPrice * maxDeductRatio).toFixed(2));
    const maxAvailable = Math.min(params.userRedPoints, maxAllowedByRatio);
    const inputVal = typeof params.customRedAmount === 'number' ? params.customRedAmount : maxAvailable;
    redDeduct = Math.max(0, Math.min(inputVal, maxAvailable));
  }

  // 配送费计算
  const baseDeliveryFee = parseFloat(await getConfigValue('DELIVERY_BASE_FEE', '3.00'));
  const freeThreshold = parseFloat(await getConfigValue('DELIVERY_FREE_THRESHOLD', '38.00'));

  let deliveryFee = 0.00;
  if (params.deliveryType === 1) { // 作坊自送
    deliveryFee = baseGoodsPrice >= freeThreshold ? 0.00 : baseDeliveryFee;
  }

  // 最终微信应收现金
  const actualGoodsPay = Math.max(0, Number((baseGoodsPrice - normalDeduct - redDeduct).toFixed(2)));
  const finalPayAmount = Number((actualGoodsPay + deliveryFee).toFixed(2));

  // 核心防刷算法：为推荐人核算返佣现金基数 (严格排除红包抵扣与运费)
  const commissionRate = parseFloat(await getConfigValue('COMMISSION_RATE', '0.03'));
  const commissionCashBase = actualGoodsPay;
  const predictCommission = Number((commissionCashBase * commissionRate).toFixed(2));

  return {
    goods_origin_total: goodsOriginTotal.toFixed(2),
    goods_member_total: goodsMemberTotal.toFixed(2),
    member_discount: memberDiscount.toFixed(2),
    normal_deduct: normalDeduct.toFixed(2),
    used_normal_points: usedNormalPoints,
    red_deduct: redDeduct.toFixed(2),
    used_red_points: redDeduct.toFixed(2),
    delivery_fee: deliveryFee.toFixed(2),
    final_pay_amount: finalPayAmount.toFixed(2),
    commission_cash_base: commissionCashBase.toFixed(2),
    predict_commission: predictCommission.toFixed(2),
    verified_items: verifiedItems
  };
}

/**
 * 结算试算接口
 */
export async function calculateOrder(ctx: Context) {
  const openid = (ctx.headers['x-wx-openid'] as string) || (ctx.query.openid as string);
  const body = ctx.request.body as {
    items: Array<{ product_id: number; quantity: number }>;
    delivery_type: number;
    use_normal_points?: boolean;
    use_red_packet_points?: boolean;
    custom_red_amount?: number;
  };

  const users: any = await query('SELECT * FROM t_user WHERE openid = ? LIMIT 1', [openid]);
  const user = users[0] || { id: 0, is_member: 0, normal_points: 0, red_packet_points: 0 };

  const result = await computeOrderFinancials({
    userId: user.id,
    isMember: user.is_member === 1,
    userNormalPoints: user.normal_points || 0,
    userRedPoints: Number(user.red_packet_points || 0),
    items: body.items || [],
    deliveryType: body.delivery_type || 1,
    useNormalPoints: body.use_normal_points,
    useRedPacketPoints: body.use_red_packet_points,
    customRedAmount: body.custom_red_amount
  });

  ctx.body = { code: 0, msg: 'ok', data: result };
}

/**
 * 提交并创建订单 (服务端强制重算，防篡改)
 */
export async function createOrder(ctx: Context) {
  const openid = (ctx.headers['x-wx-openid'] as string) || (ctx.query.openid as string);
  const body = ctx.request.body as any;

  const users: any = await query('SELECT * FROM t_user WHERE openid = ? LIMIT 1', [openid]);
  if (users.length === 0) {
    ctx.status = 401;
    ctx.body = { code: 401, msg: '未识别用户身份' };
    return;
  }
  const user = users[0];

  if (!body.items || body.items.length === 0) {
    ctx.status = 400;
    ctx.body = { code: 400, msg: '购物车无商品' };
    return;
  }

  // 服务端重新严格算价，确保不会被客户端篡改
  const financials = await computeOrderFinancials({
    userId: user.id,
    isMember: user.is_member === 1,
    userNormalPoints: user.normal_points || 0,
    userRedPoints: Number(user.red_packet_points || 0),
    items: body.items,
    deliveryType: body.delivery_type || 1,
    useNormalPoints: body.use_normal_points,
    useRedPacketPoints: body.use_red_packet_points,
    customRedAmount: body.custom_red_amount
  });

  const orderSn = `PXD${Date.now()}${Math.floor(100 + Math.random() * 900)}`;
  const pickupCode = Math.floor(1000 + Math.random() * 9000).toString(); // 4位自提码
  const address = body.receiver_address || body.delivery_address || '';

  // 插入主表 (初始状态 10: 待付款)
  const res: any = await query(
    `INSERT INTO t_order (
      order_sn, user_id, delivery_type, delivery_address, pickup_code, expect_time_slot, order_remark,
      goods_total_amount, member_discount_amount, normal_points_deduct, used_normal_points,
      red_packet_deduct, used_red_packet_points, delivery_fee, pay_amount, order_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 10)`,
    [
      orderSn, user.id, body.delivery_type || 1, address, pickupCode,
      body.expect_time_slot || '今日 16:30 傍晚批次', body.order_remark || '',
      financials.goods_origin_total, financials.member_discount,
      financials.normal_deduct, financials.used_normal_points,
      financials.red_deduct, financials.used_red_points,
      financials.delivery_fee, financials.final_pay_amount
    ]
  );

  const orderId = res.insertId;

  // 插入商品子项
  for (const item of financials.verified_items) {
    await query(
      `INSERT INTO t_order_item (order_id, product_id, product_title, product_img, price, quantity, subtotal)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [orderId, item.product_id, item.title, item.cover_img, item.price, item.quantity, item.subtotal]
    );
  }

  // 扣减已消耗的积分与红包钱包
  if (financials.used_normal_points > 0) {
    await query('UPDATE t_user SET normal_points = GREATEST(0, normal_points - ?) WHERE id = ?', [financials.used_normal_points, user.id]);
  }
  if (Number(financials.used_red_points) > 0) {
    await query('UPDATE t_user SET red_packet_points = GREATEST(0.00, red_packet_points - ?) WHERE id = ?', [financials.used_red_points, user.id]);
  }

  ctx.body = {
    code: 0,
    msg: '订单创建成功',
    data: {
      order_id: orderId,
      order_sn: orderSn,
      pay_amount: financials.final_pay_amount,
      pickup_code: pickupCode
    }
  };
}

/**
 * 微信支付成功回调/模拟支付处理 (核心闭环：触发返佣与会员升级判定)
 */
export async function payOrderSuccess(ctx: Context) {
  const { order_id } = ctx.request.body as { order_id: number };

  const orders: any = await query('SELECT * FROM t_order WHERE id = ? AND order_status = 10', [order_id]);
  if (orders.length === 0) {
    ctx.body = { code: 400, msg: '订单不存在或已完成支付' };
    return;
  }
  const order = orders[0];

  // 1. 更新订单为待备餐/已付款 (20)
  await query('UPDATE t_order SET order_status = 20, pay_time = NOW() WHERE id = ?', [order_id]);

  // 2. 累加买家的消费金额和普通消费积分 (1元=1分)
  const users: any = await query('SELECT * FROM t_user WHERE id = ?', [order.user_id]);
  const buyer = users[0];
  const cashPay = Number(order.pay_amount);

  await query(
    'UPDATE t_user SET total_consume_amount = total_consume_amount + ?, normal_points = normal_points + ? WHERE id = ?',
    [cashPay, Math.floor(cashPay), buyer.id]
  );

  // 3. 检查买家是否达到满额升级会员条件 (例如满68元自动晋级)
  const gateMode = await getConfigValue('MEMBER_ENTRY_MODE', 'CONSUME');
  const gateThreshold = parseFloat(await getConfigValue('MEMBER_ENTRY_THRESHOLD', '68.00'));

  if (gateMode === 'CONSUME' && buyer.is_member === 0) {
    const updatedUser: any = await query('SELECT total_consume_amount FROM t_user WHERE id = ?', [buyer.id]);
    if (Number(updatedUser[0].total_consume_amount) >= gateThreshold) {
      await query('UPDATE t_user SET is_member = 1 WHERE id = ?', [buyer.id]);
    }
  }

  // 4. 核心风控返佣：核发推荐人 3% 裂变返利红包
  // 规则：新会员自身用红包抵扣部分绝不计入！仅扣除运费后的纯现金参与核算
  if (buyer.referrer_id) {
    const commissionRate = parseFloat(await getConfigValue('COMMISSION_RATE', '0.03'));
    const commissionCashBase = Math.max(0, Number((cashPay - Number(order.delivery_fee)).toFixed(2)));

    if (commissionCashBase > 0) {
      const rewardPoints = Number((commissionCashBase * commissionRate).toFixed(2));

      // 记入返佣流水表
      await query(
        `INSERT INTO t_commission_flow (referrer_user_id, buyer_user_id, order_id, order_cash_base, commission_rate, reward_red_points, status)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [buyer.referrer_id, buyer.id, order_id, commissionCashBase, commissionRate, rewardPoints]
      );

      // 实时注入推荐人的红包积分钱包
      await query(
        'UPDATE t_user SET red_packet_points = red_packet_points + ? WHERE id = ?',
        [rewardPoints, buyer.referrer_id]
      );
    }
  }

  ctx.body = { code: 0, msg: '支付成功，已进入潘小兜作坊备餐队列' };
}

/**
 * 店主派单自送：潘师傅出发配送 (状态变更为 30)
 */
export async function dispatchDelivery(ctx: Context) {
  const { order_id, delivery_person_name, delivery_person_phone } = ctx.request.body as any;

  const defaultName = await getConfigValue('DELIVERY_PERSON_NAME', '潘坚 (潘师傅)');
  const defaultPhone = await getConfigValue('DELIVERY_PERSON_PHONE', '13735518290');

  let updateSql = 'UPDATE t_order SET order_status = 30, delivery_person_name = ?, delivery_person_phone = ?';
  const params: any[] = [delivery_person_name || defaultName, delivery_person_phone || defaultPhone];

  if (order_id) {
    updateSql += ' WHERE id = ?';
    params.push(order_id);
  } else {
    // 若未指定单一 order_id，则将所有已支付待备餐订单 (status=20) 批量置为发车配送
    updateSql += ' WHERE order_status = 20';
  }

  await query(updateSql, params);
  ctx.body = { code: 0, msg: '已派单！潘师傅正在电瓶车送餐路上' };
}

/**
 * 确认送达/完成订单 (状态变更为 40)
 */
export async function completeOrder(ctx: Context) {
  const { order_id } = ctx.request.body as { order_id: number };
  if (!order_id) {
    ctx.status = 400;
    ctx.body = { code: 400, msg: '缺少 order_id' };
    return;
  }

  await query('UPDATE t_order SET order_status = 40 WHERE id = ?', [order_id]);
  ctx.body = { code: 0, msg: '订单已完成' };
}

/**
 * 获取订单列表并挂载订单商品明细
 */
export async function getOrderList(ctx: Context) {
  const openid = (ctx.headers['x-wx-openid'] as string) || (ctx.query.openid as string);
  const users: any = await query('SELECT id FROM t_user WHERE openid = ? LIMIT 1', [openid]);

  let sql = 'SELECT * FROM t_order';
  const params: any[] = [];

  if (ctx.query.status) {
    sql += ' WHERE order_status = ?';
    params.push(ctx.query.status);
  } else if (users.length > 0) {
    sql += ' WHERE user_id = ?';
    params.push(users[0].id);
  }

  sql += ' ORDER BY id DESC LIMIT 50';
  const orders: any = await query(sql, params);

  // 关联查询每个订单的明细项和返利贡献
  for (const o of orders) {
    const items: any = await query('SELECT * FROM t_order_item WHERE order_id = ?', [o.id]);
    o.items = items;

    // 格式化价格字段为标准两位小数
    o.goods_origin_total = Number(o.goods_total_amount).toFixed(2);
    o.member_discount = Number(o.member_discount_amount).toFixed(2);
    o.normal_deduct = Number(o.normal_points_deduct).toFixed(2);
    o.red_deduct = Number(o.red_packet_deduct).toFixed(2);
    o.delivery_fee = Number(o.delivery_fee).toFixed(2);
    o.final_pay_amount = Number(o.pay_amount).toFixed(2);
    o.receiver_address = o.delivery_address;

    // 摘要菜品文字 (用于历史订单列表简明展示)
    o.summary_text = items.map((i: any) => `${i.product_title} x${i.quantity}`).join(', ');

    // 查询为推荐人贡献的返佣
    const flows: any = await query('SELECT reward_red_points FROM t_commission_flow WHERE order_id = ? LIMIT 1', [o.id]);
    o.commission_rebated = flows.length > 0 ? Number(flows[0].reward_red_points).toFixed(2) : '0.00';
  }

  ctx.body = { code: 0, msg: 'ok', data: orders };
}
