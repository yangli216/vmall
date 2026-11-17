import { Context } from 'koa';
import { query, withTransaction } from '../db';
import { PoolConnection } from 'mysql2/promise';

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
 * 提交并创建订单 (工匠精神：全事务+行锁并发保护)
 */
export async function createOrder(ctx: Context) {
  const openid = (ctx.headers['x-wx-openid'] as string) || (ctx.query.openid as string);
  const body = ctx.request.body as any;

  if (!openid) {
    ctx.status = 401;
    ctx.body = { code: 401, msg: '未识别用户身份' };
    return;
  }

  if (!body.items || body.items.length === 0) {
    ctx.status = 400;
    ctx.body = { code: 400, msg: '购物车无商品' };
    return;
  }

  try {
    const orderData = await withTransaction(async (conn: PoolConnection) => {
      // 1. 行级排他锁查询用户当前实际积分余额，防止并发双花
      const [userRows]: any = await conn.execute('SELECT * FROM t_user WHERE openid = ? FOR UPDATE', [openid]);
      if (userRows.length === 0) {
        throw new Error('用户档案不存在');
      }
      const user = userRows[0];

      // 2. 服务端防篡改算价
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
      const pickupCode = Math.floor(1000 + Math.random() * 9000).toString();
      const address = body.receiver_address || body.delivery_address || '';
      const receiverName = body.receiver_name || '';
      const receiverPhone = body.receiver_phone || '';

      // 3. 插入主订单记录 (初始状态 10: 待付款)
      const [res]: any = await conn.execute(
        `INSERT INTO t_order (
          order_sn, user_id, delivery_type, delivery_address, receiver_name, receiver_phone, pickup_code, expect_time_slot, order_remark,
          goods_total_amount, member_discount_amount, normal_points_deduct, used_normal_points,
          red_packet_deduct, used_red_packet_points, delivery_fee, pay_amount, order_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 10)`,
        [
          orderSn, user.id, body.delivery_type || 1, address, receiverName, receiverPhone, pickupCode,
          body.expect_time_slot || '今日 16:30 傍晚批次', body.order_remark || '',
          financials.goods_origin_total, financials.member_discount,
          financials.normal_deduct, financials.used_normal_points,
          financials.red_deduct, financials.used_red_points,
          financials.delivery_fee, financials.final_pay_amount
        ]
      );

      const orderId = res.insertId;

      // 4. 插入商品子项
      for (const item of financials.verified_items) {
        await conn.execute(
          `INSERT INTO t_order_item (order_id, product_id, product_title, product_img, price, quantity, subtotal)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [orderId, item.product_id, item.title, item.cover_img, item.price, item.quantity, item.subtotal]
        );
      }

      // 5. 扣减已锁定的积分余额
      if (financials.used_normal_points > 0) {
        await conn.execute(
          'UPDATE t_user SET normal_points = GREATEST(0, normal_points - ?) WHERE id = ?',
          [financials.used_normal_points, user.id]
        );
      }
      if (Number(financials.used_red_points) > 0) {
        await conn.execute(
          'UPDATE t_user SET red_packet_points = GREATEST(0.00, red_packet_points - ?) WHERE id = ?',
          [financials.used_red_points, user.id]
        );
      }

      return {
        order_id: orderId,
        order_sn: orderSn,
        pay_amount: financials.final_pay_amount,
        pickup_code: pickupCode
      };
    });

    ctx.body = {
      code: 0,
      msg: '订单创建成功',
      data: orderData
    };
  } catch (err: any) {
    ctx.status = 500;
    ctx.body = { code: 500, msg: err.message || '下单事务执行失败' };
  }
}

/**
 * 微信支付成功回调 (工匠精神：原子幂等更新，防重入与并发双重返利)
 */
export async function payOrderSuccess(ctx: Context) {
  const { order_id } = ctx.request.body as { order_id: number };

  if (!order_id) {
    ctx.status = 400;
    ctx.body = { code: 400, msg: '缺少 order_id' };
    return;
  }

  try {
    const result = await withTransaction(async (conn: PoolConnection) => {
      // 1. 原子幂等翻转状态：仅当当前状态为 10(待付款) 时更新为 20(已付款/待出锅)
      const [updateRes]: any = await conn.execute(
        'UPDATE t_order SET order_status = 20, pay_time = NOW() WHERE id = ? AND order_status = 10',
        [order_id]
      );

      // 若影响行数为 0，说明该订单已被其他回调或流程处理过，直接幂等返回成功
      if (updateRes.affectedRows === 0) {
        return { msg: '订单已支付完成，无需重复处理' };
      }

      // 2. 查询该订单与买家信息
      const [orderRows]: any = await conn.execute('SELECT * FROM t_order WHERE id = ?', [order_id]);
      const order = orderRows[0];

      const [userRows]: any = await conn.execute('SELECT * FROM t_user WHERE id = ? FOR UPDATE', [order.user_id]);
      const buyer = userRows[0];
      const cashPay = Number(order.pay_amount || 0);

      // 3. 累加买家实际消费额和普通积分
      await conn.execute(
        'UPDATE t_user SET total_consume_amount = total_consume_amount + ?, normal_points = normal_points + ? WHERE id = ?',
        [cashPay, Math.floor(cashPay), buyer.id]
      );

      // 4. 会员消费满额自动晋级判定
      const gateMode = await getConfigValue('MEMBER_ENTRY_MODE', 'CONSUME');
      const gateThreshold = parseFloat(await getConfigValue('MEMBER_ENTRY_THRESHOLD', '68.00'));

      if (gateMode === 'CONSUME' && buyer.is_member === 0) {
        const [consumeRows]: any = await conn.execute('SELECT total_consume_amount FROM t_user WHERE id = ?', [buyer.id]);
        if (Number(consumeRows[0].total_consume_amount) >= gateThreshold) {
          await conn.execute('UPDATE t_user SET is_member = 1 WHERE id = ?', [buyer.id]);
        }
      }

      // 5. 防刷推荐人返利结算 (严格扣除红包抵扣与运费)
      if (buyer.referrer_id) {
        const commissionRate = parseFloat(await getConfigValue('COMMISSION_RATE', '0.03'));
        const commissionCashBase = Math.max(0, Number((cashPay - Number(order.delivery_fee || 0)).toFixed(2)));
        const rewardPoints = Number((commissionCashBase * commissionRate).toFixed(2));

        if (rewardPoints > 0) {
          // 写入返利流水表
          await conn.execute(
            `INSERT INTO t_commission_flow (referrer_user_id, buyer_user_id, order_id, order_cash_base, commission_rate, reward_red_points, status)
             VALUES (?, ?, ?, ?, ?, ?, 1)`,
            [buyer.referrer_id, buyer.id, order_id, commissionCashBase, commissionRate, rewardPoints]
          );

          // 增加推荐人红包积分钱包
          await conn.execute(
            'UPDATE t_user SET red_packet_points = red_packet_points + ? WHERE id = ?',
            [rewardPoints, buyer.referrer_id]
          );
        }
      }

      return { msg: '支付结算成功，已进入潘小兜作坊备餐队列' };
    });

    ctx.body = { code: 0, msg: result.msg };
  } catch (err: any) {
    ctx.status = 500;
    ctx.body = { code: 500, msg: err.message || '支付回调结算异常' };
  }
}

/**
 * 订单取消与退款 (工匠精神：全状态回滚，返还原扣积分，严防越权取消他人订单)
 */
export async function cancelOrder(ctx: Context) {
  const openid = (ctx.headers['x-wx-openid'] as string) || (ctx.query.openid as string);
  const { order_id } = ctx.request.body as { order_id: number };

  if (!order_id) {
    ctx.status = 400;
    ctx.body = { code: 400, msg: '缺少 order_id' };
    return;
  }

  const users: any = await query('SELECT id, is_admin FROM t_user WHERE openid = ? LIMIT 1', [openid]);
  if (users.length === 0) {
    ctx.status = 401;
    ctx.body = { code: 401, msg: '未识别微信用户身份' };
    return;
  }
  const currentUser = users[0];

  try {
    const result = await withTransaction(async (conn: PoolConnection) => {
      // 只能取消待付款(10)或未发车的已付款(20)订单
      const [orderRows]: any = await conn.execute(
        'SELECT * FROM t_order WHERE id = ? AND order_status IN (10, 20) FOR UPDATE',
        [order_id]
      );

      if (orderRows.length === 0) {
        throw new Error('订单不可取消或已发车配送');
      }
      const order = orderRows[0];

      // 防越权核心校验：必须是下单人本人，或者作坊掌柜管理员
      if (order.user_id !== currentUser.id && currentUser.is_admin !== 1) {
        throw new Error('权限拒绝：您无权取消他人的订单');
      }

      // 将订单置为 50: 已取消/已退款
      await conn.execute('UPDATE t_order SET order_status = 50 WHERE id = ?', [order_id]);

      // 原路回滚使用的普通积分与红包积分
      if (order.used_normal_points > 0) {
        await conn.execute(
          'UPDATE t_user SET normal_points = normal_points + ? WHERE id = ?',
          [order.used_normal_points, order.user_id]
        );
      }
      if (Number(order.used_red_packet_points) > 0) {
        await conn.execute(
          'UPDATE t_user SET red_packet_points = red_packet_points + ? WHERE id = ?',
          [order.used_red_packet_points, order.user_id]
        );
      }

      // 如果是已付款订单(20)，回退买家累计消费并冲正推荐人返佣
      if (order.order_status === 20) {
        const cashPay = Number(order.pay_amount || 0);
        await conn.execute(
          'UPDATE t_user SET total_consume_amount = GREATEST(0.00, total_consume_amount - ?), normal_points = GREATEST(0, normal_points - ?) WHERE id = ?',
          [cashPay, Math.floor(cashPay), order.user_id]
        );

        // 冲正推荐佣金
        const [flowRows]: any = await conn.execute(
          'SELECT * FROM t_commission_flow WHERE order_id = ? AND status = 1 FOR UPDATE',
          [order_id]
        );
        if (flowRows.length > 0) {
          const flow = flowRows[0];
          await conn.execute('UPDATE t_commission_flow SET status = 2 WHERE id = ?', [flow.id]);
          await conn.execute(
            'UPDATE t_user SET red_packet_points = GREATEST(0.00, red_packet_points - ?) WHERE id = ?',
            [flow.reward_red_points, flow.referrer_user_id]
          );
        }
      }

      return { msg: '订单已成功取消，积分已原路返还' };
    });

    ctx.body = { code: 0, msg: result.msg };
  } catch (err: any) {
    ctx.status = 400;
    ctx.body = { code: 400, msg: err.message || '取消订单失败' };
  }
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
    updateSql += ' WHERE id = ? AND order_status = 20';
    params.push(order_id);
  } else {
    // 批量全单发车：将所有已支付待备餐订单 (status=20) 批量置为发车配送
    updateSql += ' WHERE order_status = 20';
  }

  const res: any = await query(updateSql, params);
  ctx.body = {
    code: 0,
    msg: `发车成功！已派发 ${res.affectedRows || 0} 笔订单，潘师傅正在骑行配送中`,
    data: { affected_rows: res.affectedRows }
  };
}

/**
 * 确认送达/完成订单 (状态变更为 40，严格鉴权)
 */
export async function completeOrder(ctx: Context) {
  const openid = (ctx.headers['x-wx-openid'] as string) || (ctx.query.openid as string);
  const { order_id } = ctx.request.body as { order_id: number };
  if (!order_id) {
    ctx.status = 400;
    ctx.body = { code: 400, msg: '缺少 order_id' };
    return;
  }

  const users: any = await query('SELECT id, is_admin FROM t_user WHERE openid = ? LIMIT 1', [openid]);
  if (users.length === 0) {
    ctx.status = 401;
    ctx.body = { code: 401, msg: '未识别身份' };
    return;
  }
  const currentUser = users[0];

  const orders: any = await query('SELECT * FROM t_order WHERE id = ? LIMIT 1', [order_id]);
  if (orders.length === 0) {
    ctx.status = 404;
    ctx.body = { code: 404, msg: '订单不存在' };
    return;
  }
  const order = orders[0];

  // 只有掌柜本人，或该订单买家本人（确认收货/到店自提完成）有权确认
  if (currentUser.is_admin !== 1 && order.user_id !== currentUser.id) {
    ctx.status = 403;
    ctx.body = { code: 403, msg: '无权操作他人订单' };
    return;
  }

  await query('UPDATE t_order SET order_status = 40 WHERE id = ?', [order_id]);
  ctx.body = { code: 0, msg: '订单已送达完成' };
}

/**
 * 获取订单列表并挂载订单商品明细 (防越权隔离设计)
 */
export async function getOrderList(ctx: Context) {
  const openid = (ctx.headers['x-wx-openid'] as string) || (ctx.query.openid as string);
  const users: any = await query('SELECT id, is_admin FROM t_user WHERE openid = ? LIMIT 1', [openid]);

  if (users.length === 0) {
    ctx.body = { code: 0, msg: 'ok', data: [] };
    return;
  }
  const currentUser = users[0];

  let sql = 'SELECT * FROM t_order WHERE 1=1';
  const params: any[] = [];

  // 严格权限分级：
  // 1. 普通顾客：强制限定 user_id = currentUser.id，绝不暴露全店他人的订单数据！
  // 2. 掌柜管理员：允许按 order_status 查全店流水 (如待出炉出车列表)
  if (currentUser.is_admin !== 1) {
    sql += ' AND user_id = ?';
    params.push(currentUser.id);
    if (ctx.query.status) {
      sql += ' AND order_status = ?';
      params.push(ctx.query.status);
    }
  } else {
    // 掌柜管理员视图
    if (ctx.query.status) {
      sql += ' AND order_status = ?';
      params.push(ctx.query.status);
    }
  }

  sql += ' ORDER BY id DESC LIMIT 50';
  const orders: any = await query(sql, params);

  // 关联查询每个订单的明细项和返利贡献
  for (const o of orders) {
    const items: any = await query('SELECT * FROM t_order_item WHERE order_id = ?', [o.id]);
    o.items = items;

    o.goods_origin_total = Number(o.goods_total_amount || 0).toFixed(2);
    o.member_discount = Number(o.member_discount_amount || 0).toFixed(2);
    o.normal_deduct = Number(o.normal_points_deduct || 0).toFixed(2);
    o.red_deduct = Number(o.red_packet_deduct || 0).toFixed(2);
    o.delivery_fee = Number(o.delivery_fee || 0).toFixed(2);
    o.final_pay_amount = Number(o.pay_amount || 0).toFixed(2);
    o.receiver_address = o.delivery_address || '';
    o.receiver_name = o.receiver_name || '';
    o.receiver_phone = o.receiver_phone || '';

    // 格式化创建时间为便于阅读的字符串 (如 2026-11-17 16:30)
    if (o.create_time) {
      const dt = new Date(o.create_time);
      o.create_time_formatted = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
    } else {
      o.create_time_formatted = '近期';
    }

    o.summary_text = items.map((i: any) => `${i.product_title} x${i.quantity}`).join(', ');

    const flows: any = await query('SELECT reward_red_points FROM t_commission_flow WHERE order_id = ? LIMIT 1', [o.id]);
    o.commission_rebated = flows.length > 0 ? Number(flows[0].reward_red_points).toFixed(2) : '0.00';
  }

  ctx.body = { code: 0, msg: 'ok', data: orders };
}
