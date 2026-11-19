import { Context } from 'koa';
import { query, withTransaction } from '../db';
import { requireValue, text } from '../domain/errors';
import { getConfigs } from '../services/config';
import { changeBalance } from '../services/ledger';
import { fen } from '../domain/pricing';

export async function getOrCreateCurrentUser(ctx: Context) {
  const rows: any = await query(`SELECT u.*, r.invite_code AS referrer_code, r.nickname AS referrer_name
    FROM t_user u LEFT JOIN t_user r ON r.id = u.referrer_id WHERE u.id = ?`, [ctx.state.user.id]);
  const user = rows[0];
  const { openid, member_source, forfeited_red_rewards, ...safe } = user;
  ctx.body = { code: 0, msg: 'ok', data: { ...safe, is_admin: ctx.state.user.is_admin,
    red_packet_points: Number(user.red_packet_points).toFixed(2), total_consumption: Number(user.total_consume_amount).toFixed(2) } };
}
export async function updateProfile(ctx: Context) {
  const body = ctx.request.body as any, fields: string[] = [], params: any[] = [];
  if (body.nickname !== undefined) { fields.push('nickname = ?'); params.push(text(body.nickname, '昵称', 50)); }
  if (body.avatar_url !== undefined) {
    const value = text(body.avatar_url, '头像地址', 500, false);
    requireValue(!value || /^(https?:\/\/|cloud:\/\/|wxfile:\/\/|http:\/\/tmp\/)/.test(value), '头像须为有效图片地址');
    fields.push('avatar_url = ?'); params.push(value);
  }
  if (body.phone !== undefined) {
    requireValue(body.phone==='' || (typeof body.phone==='string' && /^1[3-9]\d{9}$/.test(body.phone)), '手机号无效');
    fields.push('phone = ?'); params.push(body.phone);
  }
  requireValue(fields.length, '没有可保存的资料');
  await query(`UPDATE t_user SET ${fields.join(', ')} WHERE id = ?`, [...params, ctx.state.user.id]);
  ctx.body = { code: 0, msg: '资料已保存' };
}
export async function verifyAdminPasscode(ctx: Context) {
  ctx.status = 410;
  ctx.body = { code: 410, msg: '口令授权已停用，请由部署管理员配置掌柜微信账号' };
}
export async function bindReferral(conn: any, userId: number, invite: string) {
  const [rows]: any = await conn.execute('SELECT id, referrer_id FROM t_user WHERE id = ? FOR UPDATE', [userId]);
  const user = rows[0];
  requireValue(user, '用户不存在', 404);
  requireValue(!user.referrer_id, '已绑定推荐人，不能重复变更', 409);
  const [orders]: any = await conn.execute('SELECT id FROM t_order WHERE user_id = ? LIMIT 1', [userId]);
  requireValue(!orders.length, '仅支持首次下单前绑定推荐人', 409);
  const [refs]: any = await conn.execute('SELECT id, is_member FROM t_user WHERE invite_code = ?', [invite]);
  requireValue(refs.length && refs[0].is_member === 1, '邀请码无效或推荐人不是有效会员');
  const ref = refs[0];
  requireValue(ref.id !== user.id, '不能推荐自己');
  // Reject indirect cycles too, even though rewards are single-level.
  let ancestor: number | null = ref.id;
  const seen = new Set<number>();
  while (ancestor) {
    requireValue(ancestor !== userId && !seen.has(ancestor), '推荐关系不能形成循环');
    seen.add(ancestor);
    requireValue(seen.size <= 1000, '推荐关系异常，请联系掌柜');
    const [parents]: any = await conn.execute('SELECT referrer_id FROM t_user WHERE id = ? FOR UPDATE', [ancestor]);
    ancestor = parents[0]?.referrer_id || null;
  }
  await conn.execute('UPDATE t_user SET referrer_id = ?, referrer_bound_time = NOW() WHERE id = ?', [ref.id, userId]);
}
export async function bindReferrer(ctx: Context) {
  const invite = text((ctx.request.body as any).invite_code, '邀请码', 32);
  await withTransaction(conn => bindReferral(conn, ctx.state.user.id, invite));
  ctx.body = { code: 0, msg: '推荐关系已绑定' };
}
export async function exitMember(conn: any, userId: number, operatorId: number | null = null) {
  const [users]: any = await conn.execute('SELECT * FROM t_user WHERE id = ? FOR UPDATE', [userId]);
  requireValue(users.length, '用户不存在', 404);
  const [active]: any = await conn.execute('SELECT id FROM t_order WHERE user_id = ? AND order_status IN (10,20,25,30,70) LIMIT 1', [userId]);
  requireValue(!active.length, '请先完成或取消进行中的订单，再退出会员', 409);
  const red = fen(users[0].red_packet_points);
  if (red) await changeBalance(conn, userId, 'RED_PACKET', -red, 'MEMBER_EXIT', null, '退出会员清零红包', operatorId);
  if (red) await conn.execute('UPDATE t_user SET forfeited_red_rewards=forfeited_red_rewards+? WHERE id=?',[users[0].red_packet_points,userId]);
  await conn.execute('UPDATE t_user SET is_member = 0, member_opt_out = 1 WHERE id = ?', [userId]);
}
export async function exitMembership(ctx: Context) {
  requireValue((ctx.request.body as any).confirm_clear_red === true, '请先确认退出后红包清零');
  await withTransaction(conn => exitMember(conn, ctx.state.user.id));
  ctx.body = { code: 0, msg: '已退出会员，红包已清零，普通积分保留；不会自动再次入会' };
}
export async function activateFreeMembership(ctx: Context) {
  await withTransaction(async conn => {
    const config = await getConfigs(conn);
    requireValue(config.MEMBER_ENTRY_MODE === 'FREE', '当前不支持免费入会', 403);
    await conn.execute("UPDATE t_user SET is_member = 1, member_opt_out = 0, member_source = 'FREE' WHERE id = ?", [ctx.state.user.id]);
  });
  ctx.body = { code: 0, msg: '会员已开通' };
}
export async function accountFlows(ctx: Context) {
  const before = Number(ctx.query.before_id || 0);
  requireValue(Number.isSafeInteger(before) && before >= 0, '分页参数无效');
  const rows = await query('SELECT * FROM t_account_flow WHERE user_id = ? AND (? = 0 OR id < ?) ORDER BY id DESC LIMIT 30', [ctx.state.user.id, before, before]);
  ctx.body = { code: 0, data: rows };
}
