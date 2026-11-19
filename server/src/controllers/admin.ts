import { Context } from 'koa';
import { query, withTransaction } from '../db';
import { PoolConnection } from 'mysql2/promise';
import { getConfigs, validateConfigs, publicConfigs, configRevision } from '../services/config';
import { requireValue, positiveId, text } from '../domain/errors';
import { bindReferral, exitMember } from './user';
import { changeBalance } from '../services/ledger';
import { fen } from '../domain/pricing';
import { beforeId, pageRows } from '../domain/pagination';
import { createHash } from 'crypto';

/**
 * 获取所有运营参数配置
 */
export async function getSystemConfigs(ctx: Context) {
  ctx.set('Cache-Control','no-store');
  ctx.body = { code: 0, msg: 'ok', data: await getConfigs() };
}
export async function getAdminConfig(ctx:Context) {
  const configs=await getConfigs();ctx.set('Cache-Control','no-store');
  ctx.body={code:0,data:{configs,revision:configRevision(configs)}};
}
export async function updateSystemConfig(ctx: Context) {
  const body = ctx.request.body as any;
  const updates = validateConfigs(body.configs || { [body.config_key]: body.config_value });
  requireValue(typeof body.expected_revision==='string' && /^[a-f0-9]{64}$/.test(body.expected_revision),'请先重新读取营业设置再保存',409);
  const result=await withTransaction(async conn => {
    // Serialize settings edits, including cross-field checks and absent default keys.
    const [rows]:any=await conn.execute('SELECT config_key,config_value FROM t_system_config ORDER BY config_key FOR UPDATE');
    const current=publicConfigs(rows);
    const unchanged=Object.entries(updates).every(([key,value])=>current[key]===value);
    requireValue(body.expected_revision===configRevision(current) || unchanged,'营业设置已被更新，请重新读取并核对；当前填写可先保留',409);
    const merged = { ...current, ...updates };
    requireValue(merged.BATCH_CUTOFF_TIME <= merged.BATCH_SCHEDULE_TIME, '截单时间不能晚于出炉时间');
    for (const [key, value] of Object.entries(updates).filter(([key,value])=>current[key]!==value)) {
      await conn.execute('INSERT INTO t_system_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)', [key, value]);
    }
    return {configs:merged,revision:configRevision(merged)};
  });
  ctx.body = { code: 0, msg: '运营配置已保存',data:result };
}

/**
 * 掌柜后台：会员花名册全景查询 (支持姓名/手机号/卡号模糊搜索与身份筛选)
 */
export async function getMemberList(ctx: Context) {
  const { keyword, is_member } = ctx.query as { keyword?: string; is_member?: string };
  const cursor = beforeId(ctx.query.before_id);
  requireValue(keyword === undefined || (typeof keyword === 'string' && keyword.length <= 64), '搜索内容最多64字');
  requireValue(is_member === undefined || ['', '0', '1'].includes(is_member), '会员筛选无效');

  let sql = `
    SELECT u.id, u.phone, u.nickname, u.avatar_url, u.is_member,
           u.member_card_no, u.invite_code, u.referrer_id,
           u.normal_points, u.red_packet_points, u.normal_points_debt, u.red_packet_debt, u.total_consume_amount, u.create_time,
           r.nickname AS referrer_name, r.invite_code AS referrer_code,
           (SELECT COUNT(id) FROM t_user WHERE referrer_id = u.id) AS referral_count,
           (SELECT COUNT(id) FROM t_order WHERE user_id = u.id AND order_status IN (20,25,30,40)) AS paid_order_count
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

  const where = sql.slice(sql.indexOf('WHERE 1=1'));
  const totals: any = await query('SELECT COUNT(*) AS total FROM t_user u ' + where, params);
  if (cursor) { sql += ' AND u.id < ?'; params.push(cursor); }
  sql += ' ORDER BY u.id DESC LIMIT 31';

  const list: any = await query(sql, params);
  const page = pageRows<any>(list);

  const formatted = page.list.map((item: any) => ({
    ...item,
    red_packet_points: Number(item.red_packet_points || 0).toFixed(2),
    total_consume_amount: Number(item.total_consume_amount || 0).toFixed(2),
    create_time_formatted: item.create_time ? String(item.create_time).slice(0, 10) : '近期'
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
      list: formatted,
      total: Number(totals[0].total),
      next_cursor: page.next_cursor
    }
  };
}

/**
 * 掌柜后台：人工修改会员身份 (支持一键升级尊享会员或注销撤销会员)
 */
export async function updateMemberStatus(ctx: Context) {
  const body = ctx.request.body as any;
  const userId = positiveId(body.user_id, '会员ID');
  requireValue(body.is_member === 0 || body.is_member === 1, '会员状态无效');
  await withTransaction(async conn => {
    if (body.is_member === 1) {
      const [result]: any = await conn.execute("UPDATE t_user SET is_member = 1, member_opt_out = 0, member_source = 'MANUAL' WHERE id = ?", [userId]);
      requireValue(result.affectedRows, '会员不存在', 404);
    } else await exitMember(conn, userId, ctx.state.user.id);
  });
  ctx.body = { code: 0, msg: '会员身份已更新' };
}

/**
 * 掌柜后台：人工调整积分与红包 (支持奖励赠送与扣减冲正，严格记入审计日志)
 */
export async function adjustMemberPoints(ctx: Context) {
  const body = ctx.request.body as any;
  const userId = positiveId(body.user_id, '会员ID');
  requireValue(['NORMAL_POINT', 'RED_PACKET'].includes(body.adjust_type), '积分类型无效');
  requireValue(typeof body.amount === 'number' && Number.isFinite(body.amount) && body.amount !== 0, '调整数值无效');
  if (body.adjust_type === 'NORMAL_POINT') requireValue(Number.isSafeInteger(body.amount) && Math.abs(body.amount) <= 1000000, '普通积分须为整数且不超过100万');
  const delta = body.adjust_type === 'NORMAL_POINT' ? body.amount : fen(Math.abs(body.amount)) * Math.sign(body.amount);
  const reason = text(body.reason, '调整原因', 255);
  requireValue(typeof body.request_id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(body.request_id), '缺少调整请求号，请重新打开调整窗口');
  const hash = createHash('sha256').update(JSON.stringify({userId, kind:body.adjust_type, delta, reason})).digest('hex');
  await withTransaction(async conn => {
    const [inserted]: any = await conn.execute("INSERT IGNORE INTO t_admin_mutation(operator_id,request_id,action,request_hash) VALUES(?,?,'ADJUST_POINTS',?)", [ctx.state.user.id,body.request_id,hash]);
    if (!inserted.affectedRows) {
      const [existing]: any = await conn.execute('SELECT action,request_hash FROM t_admin_mutation WHERE operator_id=? AND request_id=? FOR UPDATE', [ctx.state.user.id,body.request_id]);
      requireValue(existing[0]?.action === 'ADJUST_POINTS' && existing[0].request_hash === hash, '请求号已用于其他调整，请重新确认', 409);
      return;
    }
    await changeBalance(conn, userId, body.adjust_type, delta, 'ADMIN_ADJUST', null, reason, ctx.state.user.id);
  });
  ctx.body = { code: 0, msg: '资产调整成功，已记入流水' };
}

/**
 * 掌柜后台：人工补录/修正推荐人关系 (线下老客转介绍补绑)
 */
export async function bindMemberReferrer(ctx: Context) {
  const body = ctx.request.body as any;
  await withTransaction(conn => bindReferral(conn, positiveId(body.user_id), text(body.referrer_invite_code, '邀请码', 32)));
  ctx.body = { code: 0, msg: '推荐关系已绑定' };
}

/**
 * 掌柜后台：查询某会员积分调整历史审计记录
 */
export async function getPointAdjustLogs(ctx: Context) {
  const params: any[]=[];let sql="SELECT * FROM t_account_flow WHERE event_type='ADMIN_ADJUST'";
  if(ctx.query.user_id){sql+=' AND user_id=?';params.push(positiveId(ctx.query.user_id));}
  const rows=await query(sql+' ORDER BY id DESC LIMIT 50',params);
  ctx.body={code:0,data:rows};
}

/**
 * 获取我的推广下级会员与收益贡献列表 (真实数据统计，拒绝假数据)
 */
export async function getMyReferrals(ctx: Context) {
  const myUserId = ctx.state.user.id, cursor = beforeId(ctx.query.before_id);

  // 查询由我推荐的下级会员列表及其实际累计贡献的返佣
  const referrals: any = await query(
    `SELECT u.id, u.nickname, u.avatar_url, u.is_member, u.referrer_bound_time AS create_time,
      COALESCE(f.contributed_points, 0) AS contributed_points, COALESCE(o.order_count, 0) AS order_count
     FROM t_user u
     LEFT JOIN (SELECT buyer_user_id, SUM(reward_red_points) AS contributed_points FROM t_commission_flow
       WHERE referrer_user_id = ? AND status = 1 GROUP BY buyer_user_id) f ON f.buyer_user_id = u.id
     LEFT JOIN (SELECT user_id, COUNT(*) AS order_count FROM t_order
       WHERE order_status IN (20,25,30,40) GROUP BY user_id) o ON o.user_id = u.id
     WHERE u.referrer_id = ? AND (? = 0 OR u.id < ?) ORDER BY u.id DESC LIMIT 31`, [myUserId, myUserId, cursor, cursor]);
  const page = pageRows<any>(referrals);

  // 统计由我获得的总返利金额
  const totalFlows: any = await query(
    'SELECT COALESCE(SUM(reward_red_points), 0) AS total_commission, COUNT(id) AS total_orders FROM t_commission_flow WHERE referrer_user_id = ? AND status = 1',
    [myUserId]
  );

  const referredCount: any = await query('SELECT COUNT(*) AS total FROM t_user WHERE referrer_id = ?', [myUserId]);
  const totalReferred = Number(referredCount[0].total);
  const totalOrders = totalFlows[0] ? totalFlows[0].total_orders : 0;
  const totalCommission = totalFlows[0] ? Number(totalFlows[0].total_commission).toFixed(2) : '0.00';

  const formattedList = page.list.map((r: any) => ({
    id: r.id,
    nickname: r.nickname || `临安食客_${r.id}`,
    avatar_url: r.avatar_url || '',
    is_member: r.is_member,
    bind_time: r.create_time ? String(r.create_time).slice(0, 10) : '近期',
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
      list: formattedList,
      next_cursor: page.next_cursor
    }
  };
}
