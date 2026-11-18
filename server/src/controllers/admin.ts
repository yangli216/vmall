import { Context } from 'koa';
import { query, withTransaction } from '../db';
import { PoolConnection } from 'mysql2/promise';

/**
 * 获取所有运营参数配置
 */
export async function getSystemConfigs(ctx: Context) {
  const configs: any = await query('SELECT * FROM t_system_config');
  const map: Record<string, string> = {};
  for (const c of configs) {
    map[c.config_key] = c.config_value;
  }
  ctx.body = { code: 0, msg: 'ok', data: map };
}

/**
 * 修改某项运营参数 (门槛、抵扣比例、返利比，支持批量一次性更新)
 */
export async function updateSystemConfig(ctx: Context) {
  const body = ctx.request.body as any;

  if (body.configs && typeof body.configs === 'object') {
    for (const key of Object.keys(body.configs)) {
      await query('UPDATE t_system_config SET config_value = ? WHERE config_key = ?', [body.configs[key].toString(), key]);
    }
    ctx.body = { code: 0, msg: '配置已批量更新并实时生效' };
    return;
  }

  const { config_key, config_value } = body;

  if (!config_key || config_value === undefined) {
    ctx.status = 400;
    ctx.body = { code: 400, msg: '缺少参数 (config_key 或 config_value)' };
    return;
  }

  await query('UPDATE t_system_config SET config_value = ? WHERE config_key = ?', [config_value.toString(), config_key]);
  ctx.body = { code: 0, msg: '配置已更新并实时生效', data: { config_key, config_value } };
}

/**
 * 掌柜后台：会员花名册全景查询 (支持姓名/手机号/卡号模糊搜索与身份筛选)
 */
export async function getMemberList(ctx: Context) {
  const { keyword, is_member } = ctx.query as { keyword?: string; is_member?: string };

  let sql = `
    SELECT u.id, u.openid, u.phone, u.nickname, u.avatar_url, u.is_member, u.is_admin,
           u.member_card_no, u.invite_code, u.referrer_id,
           u.normal_points, u.red_packet_points, u.total_consume_amount, u.create_time,
           r.nickname AS referrer_name, r.invite_code AS referrer_code,
           (SELECT COUNT(id) FROM t_user WHERE referrer_id = u.id) AS referral_count,
           (SELECT COUNT(id) FROM t_order WHERE user_id = u.id AND order_status >= 20) AS paid_order_count
    FROM t_user u
    LEFT JOIN t_user r ON u.referrer_id = r.id
    WHERE 1=1
  `;
  const params: any[] = [];

  if (typeof is_member === 'string' && is_member !== '') {
    sql += ' AND u.is_member = ?';
    params.push(parseInt(is_member, 10));
  }

  if (keyword && keyword.trim()) {
    const kw = `%${keyword.trim()}%`;
    sql += ' AND (u.nickname LIKE ? OR u.phone LIKE ? OR u.member_card_no LIKE ? OR u.invite_code LIKE ?)';
    params.push(kw, kw, kw, kw);
  }

  sql += ' ORDER BY u.is_member DESC, u.total_consume_amount DESC, u.id DESC LIMIT 100';

  const list: any = await query(sql, params);

  const formatted = list.map((item: any) => ({
    ...item,
    red_packet_points: Number(item.red_packet_points || 0).toFixed(2),
    total_consume_amount: Number(item.total_consume_amount || 0).toFixed(2),
    create_time_formatted: item.create_time ? new Date(item.create_time).toISOString().slice(0, 10) : '近期'
  }));

  // 统计概览指标
  const summaryRes: any = await query(`
    SELECT COUNT(id) AS total_users,
           SUM(CASE WHEN is_member = 1 THEN 1 ELSE 0 END) AS total_vip_members,
           COALESCE(SUM(total_consume_amount), 0) AS all_time_consumption,
           COALESCE(SUM(red_packet_points), 0) AS total_outstanding_red_points
    FROM t_user
  `);

  const summary = summaryRes[0] || {};

  ctx.body = {
    code: 0,
    msg: 'ok',
    data: {
      summary: {
        total_users: summary.total_users || 0,
        total_vip_members: summary.total_vip_members || 0,
        all_time_consumption: Number(summary.all_time_consumption || 0).toFixed(2),
        total_outstanding_red_points: Number(summary.total_outstanding_red_points || 0).toFixed(2)
      },
      list: formatted
    }
  };
}

/**
 * 掌柜后台：人工修改会员身份 (支持一键升级尊享会员或注销撤销会员)
 */
export async function updateMemberStatus(ctx: Context) {
  const { user_id, is_member } = ctx.request.body as { user_id: number; is_member: number };

  if (!user_id || typeof is_member !== 'number') {
    ctx.status = 400;
    ctx.body = { code: 400, msg: '缺少参数 (user_id 或 is_member)' };
    return;
  }

  const users: any = await query('SELECT * FROM t_user WHERE id = ? LIMIT 1', [user_id]);
  if (users.length === 0) {
    ctx.status = 404;
    ctx.body = { code: 404, msg: '会员不存在' };
    return;
  }

  if (is_member === 1) {
    // 升级为尊享会员
    await query('UPDATE t_user SET is_member = 1 WHERE id = ?', [user_id]);
    ctx.body = { code: 0, msg: `已将顾客【${users[0].nickname}】设置为尊享会员，立享全场8.8折与返佣特权！` };
  } else {
    // 撤销会员身份：清空红包积分，保留普通积分
    await query('UPDATE t_user SET is_member = 0, red_packet_points = 0.00 WHERE id = ?', [user_id]);
    ctx.body = { code: 0, msg: `已撤销【${users[0].nickname}】的尊享会员身份，恢复为普通食客。` };
  }
}

/**
 * 掌柜后台：人工调整积分与红包 (支持奖励赠送与扣减冲正，严格记入审计日志)
 */
export async function adjustMemberPoints(ctx: Context) {
  const { user_id, adjust_type, amount, reason } = ctx.request.body as {
    user_id: number;
    adjust_type: 'NORMAL_POINT' | 'RED_PACKET';
    amount: number;
    reason: string;
  };

  if (!user_id || !adjust_type || typeof amount !== 'number' || !reason) {
    ctx.status = 400;
    ctx.body = { code: 400, msg: '缺少必要参数 (user_id, adjust_type, amount, reason)' };
    return;
  }

  try {
    const result = await withTransaction(async (conn: PoolConnection) => {
      const [userRows]: any = await conn.execute('SELECT * FROM t_user WHERE id = ? FOR UPDATE', [user_id]);
      if (userRows.length === 0) {
        throw new Error('未找到指定会员');
      }
      const user = userRows[0];

      let beforeVal = 0;
      let afterVal = 0;

      if (adjust_type === 'NORMAL_POINT') {
        beforeVal = user.normal_points;
        afterVal = beforeVal + Math.round(amount);
        if (afterVal < 0) {
          throw new Error(`扣减超出可用普通积分(当前: ${beforeVal})`);
        }
        await conn.execute('UPDATE t_user SET normal_points = ? WHERE id = ?', [afterVal, user_id]);
      } else if (adjust_type === 'RED_PACKET') {
        beforeVal = Number(user.red_packet_points);
        afterVal = Number((beforeVal + amount).toFixed(2));
        if (afterVal < 0) {
          throw new Error(`扣减超出可用红包积分(当前: ¥${beforeVal.toFixed(2)})`);
        }
        await conn.execute('UPDATE t_user SET red_packet_points = ? WHERE id = ?', [afterVal, user_id]);
      } else {
        throw new Error('无效的调整类型');
      }

      // 记入审计日志
      await conn.execute(
        `INSERT INTO t_point_adjust_log (user_id, adjust_type, amount, before_val, after_val, operator_name, reason)
         VALUES (?, ?, ?, ?, ?, '掌柜潘师傅', ?)`,
        [user_id, adjust_type, amount, beforeVal, afterVal, reason.trim()]
      );

      return {
        nickname: user.nickname,
        beforeVal,
        afterVal,
        adjust_type,
        amount
      };
    });

    ctx.body = {
      code: 0,
      msg: `成功为【${result.nickname}】${result.amount >= 0 ? '赠送补发' : '扣减冲正'} ${Math.abs(result.amount)} ${result.adjust_type === 'NORMAL_POINT' ? '普通积分' : '元红包积分'}！`,
      data: result
    };
  } catch (err: any) {
    ctx.status = 400;
    ctx.body = { code: 400, msg: err.message || '调整失败' };
  }
}

/**
 * 掌柜后台：人工补录/修正推荐人关系 (线下老客转介绍补绑)
 */
export async function bindMemberReferrer(ctx: Context) {
  const { user_id, referrer_invite_code } = ctx.request.body as { user_id: number; referrer_invite_code: string };

  if (!user_id || !referrer_invite_code) {
    ctx.status = 400;
    ctx.body = { code: 400, msg: '缺少 user_id 或 referrer_invite_code' };
    return;
  }

  const users: any = await query('SELECT * FROM t_user WHERE id = ? LIMIT 1', [user_id]);
  if (users.length === 0) {
    ctx.status = 404;
    ctx.body = { code: 404, msg: '会员不存在' };
    return;
  }
  const curUser = users[0];

  const referrers: any = await query('SELECT * FROM t_user WHERE invite_code = ? LIMIT 1', [referrer_invite_code.trim()]);
  if (referrers.length === 0) {
    ctx.status = 400;
    ctx.body = { code: 400, msg: '未找到该推荐码对应的会员' };
    return;
  }
  const referrer = referrers[0];

  if (referrer.id === curUser.id) {
    ctx.status = 400;
    ctx.body = { code: 400, msg: '不可将自己设为自己的推荐人' };
    return;
  }

  await query('UPDATE t_user SET referrer_id = ? WHERE id = ?', [referrer.id, curUser.id]);
  ctx.body = {
    code: 0,
    msg: `成功将【${curUser.nickname}】的推荐人绑定为【${referrer.nickname} (${referrer.invite_code})】！`,
    data: {
      referrer_id: referrer.id,
      referrer_name: referrer.nickname,
      referrer_code: referrer.invite_code
    }
  };
}

/**
 * 掌柜后台：查询某会员积分调整历史审计记录
 */
export async function getPointAdjustLogs(ctx: Context) {
  const { user_id } = ctx.query as { user_id?: string };
  let sql = 'SELECT * FROM t_point_adjust_log';
  const params: any[] = [];
  if (user_id) {
    sql += ' WHERE user_id = ?';
    params.push(user_id);
  }
  sql += ' ORDER BY id DESC LIMIT 50';

  const logs: any = await query(sql, params);
  ctx.body = { code: 0, msg: 'ok', data: logs };
}

/**
 * 获取我的推广下级会员与收益贡献列表 (真实数据统计，拒绝假数据)
 */
export async function getMyReferrals(ctx: Context) {
  const openid = (ctx.headers['x-wx-openid'] as string) || (ctx.query.openid as string);
  const users: any = await query('SELECT id FROM t_user WHERE openid = ? LIMIT 1', [openid]);

  if (users.length === 0) {
    ctx.body = {
      code: 0,
      msg: 'ok',
      data: {
        summary: {
          total_referred: 0,
          total_orders: 0,
          total_commission: '0.00'
        },
        list: []
      }
    };
    return;
  }

  const myUserId = users[0].id;

  // 查询由我推荐的下级会员列表及其实际累计贡献的返佣
  const referrals: any = await query(
    `SELECT u.id, u.nickname, u.avatar_url, u.is_member, u.total_consume_amount, u.create_time,
            COALESCE(SUM(f.reward_red_points), 0) AS contributed_points,
            COUNT(DISTINCT o.id) AS order_count
     FROM t_user u
     LEFT JOIN t_commission_flow f ON f.buyer_user_id = u.id AND f.referrer_user_id = ?
     LEFT JOIN t_order o ON o.user_id = u.id AND o.order_status >= 20
     WHERE u.referrer_id = ?
     GROUP BY u.id
     ORDER BY u.id DESC`,
    [myUserId, myUserId]
  );

  // 统计由我获得的总返利金额
  const totalFlows: any = await query(
    'SELECT COALESCE(SUM(reward_red_points), 0) AS total_commission, COUNT(id) AS total_orders FROM t_commission_flow WHERE referrer_user_id = ? AND status = 1',
    [myUserId]
  );

  const totalReferred = referrals.length;
  const totalOrders = totalFlows[0] ? totalFlows[0].total_orders : 0;
  const totalCommission = totalFlows[0] ? Number(totalFlows[0].total_commission).toFixed(2) : '0.00';

  const formattedList = referrals.map((r: any) => ({
    id: r.id,
    nickname: r.nickname || `临安食客_${r.id}`,
    avatar_url: r.avatar_url || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=120',
    is_member: r.is_member,
    bind_time: r.create_time ? new Date(r.create_time).toISOString().slice(0, 10) : '近期',
    commission_earned: Number(r.contributed_points).toFixed(2),
    order_count: r.order_count
  }));

  ctx.body = {
    code: 0,
    msg: 'ok',
    data: {
      summary: {
        total_referred: totalReferred,
        total_orders: totalOrders,
        total_commission: totalCommission
      },
      list: formattedList
    }
  };
}
