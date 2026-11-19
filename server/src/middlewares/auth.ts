import { Context, Next } from 'koa';
import { randomBytes } from 'crypto';
import { query } from '../db';
import { requireValue } from '../domain/errors';
import { adminAuditContext } from '../services/audit-context';
export interface AuthUser {
  id: number; openid: string; phone: string; nickname: string; avatar_url: string;
  is_member: number; is_admin: number; member_card_no: string; invite_code: string;
  normal_points: number; red_packet_points: number; total_consume_amount: number;
  member_opt_out: number; member_source: string;
}
export function isAdminOpenid(openid: string): boolean {
  return (process.env.ADMIN_OPENIDS || '').split(',').map(x => x.trim()).filter(Boolean).includes(openid);
}
export function identity(headers: Record<string, any>, env = process.env): string | undefined {
  // In production only the private WeChat cloud gateway may reach this service.
  // Query identities are deliberately unsupported, including in development.
  const trusted = headers['x-wx-openid'];
  if (typeof trusted === 'string' && trusted && trusted.length <= 64) return trusted;
  const dev = headers['x-dev-openid'];
  if (env.NODE_ENV !== 'production' && env.ALLOW_DEV_AUTH === 'true' && typeof dev === 'string' && /^[\w-]{1,64}$/.test(dev)) return dev;
  return undefined;
}
export async function wechatAuth(ctx: Context, next: Next) {
  if (ctx.path.startsWith('/api/payment/notify') || ctx.path.startsWith('/api/refund/notify')) return next();
  const openid = identity(ctx.headers);
  if (openid) {
    let users: any = await query('SELECT * FROM t_user WHERE openid = ? LIMIT 1', [openid]);
    if (!users.length) {
      const suffix = randomBytes(8).toString('hex').toUpperCase();
      try {
        await query(`INSERT INTO t_user (openid, nickname, invite_code, member_card_no, is_member, is_admin) VALUES (?, ?, ?, ?, 0, 0)`,
          [openid, '新食客', `PXD-${suffix}`, `NO.${suffix}`]);
      } catch (err: any) { if (err.code !== 'ER_DUP_ENTRY') throw err; }
      users = await query('SELECT * FROM t_user WHERE openid = ? LIMIT 1', [openid]);
    }
    requireValue(users.length > 0, '身份初始化失败，请重试', 503);
    ctx.state.user = { ...users[0], is_admin: isAdminOpenid(openid) ? 1 : 0 };
  }
  await next();
}
export async function userRequired(ctx: Context, next: Next) {
  requireValue(ctx.state.user, '未识别微信身份，请重新进入小程序', 401);
  await next();
}
export async function adminRequired(ctx: Context, next: Next) {
  requireValue(ctx.state.user, '未识别微信身份', 401);
  requireValue(ctx.state.user.is_admin === 1, '仅限已授权的掌柜账号操作', 403);
  await next();
}
export async function auditAdmin(ctx: Context, next: Next) {
  const body = ctx.request.body as any;
  await adminAuditContext.run({operatorId:ctx.state.user.id, action:ctx.path,
    targetId:String(body?.id || body?.user_id || body?.order_id || body?.product_id || ''), committed:false}, next);
}
