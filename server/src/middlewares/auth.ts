import { Context, Next } from 'koa';
import { query } from '../db';

export interface AuthUser {
  id: number;
  openid: string;
  phone: string;
  nickname: string;
  avatar_url: string;
  is_member: number;
  is_admin: number;
  member_card_no: string;
  invite_code: string;
  normal_points: number;
  red_packet_points: number;
  total_consume_amount: number;
}

/**
 * 微信用户身份解析中间件
 * 依托微信云托管天然网关注入 Header: x-wx-openid
 * 本地开发调试支持 Header 或 Query openid
 */
export async function wechatAuth(ctx: Context, next: Next) {
  const openid = (ctx.headers['x-wx-openid'] as string) || (ctx.query.openid as string);

  if (openid) {
    let users: any = await query('SELECT * FROM t_user WHERE openid = ? LIMIT 1', [openid]);
    if (users.length === 0) {
      // 首次进入微信小程序，自动建档 (毫秒级防碰撞专属邀请码与会员卡号)
      const randomSuffix = `${Date.now().toString(36).slice(-4).toUpperCase()}${Math.floor(100 + Math.random() * 900)}`;
      const invite_code = `PXD-${randomSuffix}`;
      const card_no = `NO.${randomSuffix}`;

      const insertRes: any = await query(
        `INSERT INTO t_user (openid, nickname, invite_code, member_card_no, is_member, is_admin, normal_points, red_packet_points, total_consume_amount)
         VALUES (?, ?, ?, ?, 0, 0, 0, 0.00, 0.00)`,
        [openid, `临安食客_${randomSuffix}`, invite_code, card_no]
      );

      users = await query('SELECT * FROM t_user WHERE id = ?', [insertRes.insertId]);
    }

    ctx.state.user = users[0] as AuthUser;
  }

  await next();
}

/**
 * 掌柜管理员权限强制拦截中间件 (RBAC 核心防护)
 * 拦截非法或非掌柜身份请求，杜绝越权改价、删菜、改配置
 */
export async function adminRequired(ctx: Context, next: Next) {
  const user: AuthUser | undefined = ctx.state.user;

  if (!user) {
    ctx.status = 401;
    ctx.body = { code: 401, msg: '未识别微信身份，请在微信中打开' };
    return;
  }

  if (user.is_admin !== 1) {
    ctx.status = 403;
    ctx.body = { code: 403, msg: '权限拒绝：仅限潘小兜作坊掌柜本人操作' };
    return;
  }

  await next();
}
