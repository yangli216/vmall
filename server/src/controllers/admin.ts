import { Context } from 'koa';
import { query } from '../db';

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
 * 修改某项运营参数 (门槛、抵扣比例、返利比)
 */
export async function updateSystemConfig(ctx: Context) {
  const { config_key, config_value } = ctx.request.body as { config_key: string; config_value: string };

  if (!config_key || config_value === undefined) {
    ctx.status = 400;
    ctx.body = { code: 400, msg: '缺少参数 (config_key 或 config_value)' };
    return;
  }

  await query('UPDATE t_system_config SET config_value = ? WHERE config_key = ?', [config_value.toString(), config_key]);
  ctx.body = { code: 0, msg: '配置已更新并实时生效', data: { config_key, config_value } };
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
