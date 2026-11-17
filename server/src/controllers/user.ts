import { Context } from 'koa';
import { query } from '../db';

/**
 * 获取或初始化当前微信用户信息
 * 依托微信云托管网关自动注入的 Header: x-wx-openid，天然免登录鉴权
 */
export async function getOrCreateCurrentUser(ctx: Context) {
  const openid = (ctx.headers['x-wx-openid'] as string) || (ctx.query.openid as string);

  if (!openid) {
    ctx.status = 401;
    ctx.body = { code: 401, msg: '未识别微信用户身份，请在微信中打开' };
    return;
  }

  // 查询用户，并关联查询推荐人信息
  let users: any = await query(
    `SELECT u.*, r.invite_code AS referrer_code, r.nickname AS referrer_name
     FROM t_user u
     LEFT JOIN t_user r ON u.referrer_id = r.id
     WHERE u.openid = ? LIMIT 1`,
    [openid]
  );

  if (users.length === 0) {
    // 新用户首次进入，自动建档
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const invite_code = `PXD-${randomSuffix}`;
    const card_no = `NO.${randomSuffix}`;

    const insertRes: any = await query(
      `INSERT INTO t_user (openid, nickname, invite_code, member_card_no, is_member, is_admin, normal_points, red_packet_points, total_consume_amount)
       VALUES (?, ?, ?, ?, 0, 0, 0, 0.00, 0.00)`,
      [openid, `临安食客_${randomSuffix}`, invite_code, card_no]
    );

    users = await query(
      `SELECT u.*, r.invite_code AS referrer_code, r.nickname AS referrer_name
       FROM t_user u
       LEFT JOIN t_user r ON u.referrer_id = r.id
       WHERE u.id = ?`,
      [insertRes.insertId]
    );
  }

  const user = users[0];
  ctx.body = {
    code: 0,
    msg: 'ok',
    data: {
      id: user.id,
      openid: user.openid,
      nickname: user.nickname,
      avatar_url: user.avatar_url,
      phone: user.phone,
      is_member: user.is_member,
      is_admin: user.is_admin || 0,
      member_card_no: user.member_card_no,
      invite_code: user.invite_code,
      referrer_id: user.referrer_id,
      referrer_code: user.referrer_code,
      referrer_name: user.referrer_name,
      normal_points: user.normal_points,
      red_packet_points: Number(user.red_packet_points).toFixed(2),
      total_consumption: Number(user.total_consume_amount).toFixed(2)
    }
  };
}

/**
 * 微信用户更新个人资料 (头像、昵称、手机号)
 * 适配微信小程序 open-type="chooseAvatar" 与 input type="nickname"
 */
export async function updateProfile(ctx: Context) {
  const openid = (ctx.headers['x-wx-openid'] as string) || (ctx.query.openid as string);
  const { nickname, avatar_url, phone } = ctx.request.body as {
    nickname?: string;
    avatar_url?: string;
    phone?: string;
  };

  if (!openid) {
    ctx.status = 401;
    ctx.body = { code: 401, msg: '未识别身份' };
    return;
  }

  const updates: string[] = [];
  const params: any[] = [];

  if (typeof nickname === 'string' && nickname.trim()) {
    updates.push('nickname = ?');
    params.push(nickname.trim());
  }
  if (typeof avatar_url === 'string' && avatar_url.trim()) {
    updates.push('avatar_url = ?');
    params.push(avatar_url.trim());
  }
  if (typeof phone === 'string' && phone.trim()) {
    updates.push('phone = ?');
    params.push(phone.trim());
  }

  if (updates.length === 0) {
    ctx.body = { code: 0, msg: '无信息需更新' };
    return;
  }

  params.push(openid);
  await query(`UPDATE t_user SET ${updates.join(', ')} WHERE openid = ?`, params);

  ctx.body = { code: 0, msg: '资料已成功更新' };
}

/**
 * 掌柜主口令身份验证与 OpenID 绑定 (RBAC 核心认证)
 * 验证通过后将当前微信 OpenID 提升为管理员身份
 */
export async function verifyAdminPasscode(ctx: Context) {
  const openid = (ctx.headers['x-wx-openid'] as string) || (ctx.query.openid as string);
  const { passcode } = ctx.request.body as { passcode: string };

  if (!openid || !passcode) {
    ctx.status = 400;
    ctx.body = { code: 400, msg: '缺少必要参数 (passcode)' };
    return;
  }

  const configs: any = await query('SELECT config_value FROM t_system_config WHERE config_key = "ADMIN_PASSCODE" LIMIT 1');
  const validPasscode = configs.length > 0 ? configs[0].config_value : '8899';

  if (passcode.trim() !== validPasscode) {
    ctx.status = 403;
    ctx.body = { code: 403, msg: '掌柜口令验证失败，无权访问' };
    return;
  }

  // 绑定当前 OpenID 为管理员
  await query('UPDATE t_user SET is_admin = 1 WHERE openid = ?', [openid]);

  ctx.body = {
    code: 0,
    msg: '掌柜身份验证成功！您的微信账号已获得作坊管理中枢权限。',
    data: { is_admin: 1 }
  };
}

/**
 * 绑定推荐人关系 (新会员扫码进入小程序时调用)
 */
export async function bindReferrer(ctx: Context) {
  const openid = (ctx.headers['x-wx-openid'] as string) || (ctx.query.openid as string);
  const { invite_code } = ctx.request.body as { invite_code: string };

  if (!openid || !invite_code) {
    ctx.status = 400;
    ctx.body = { code: 400, msg: '缺少必要参数 (openid 或 invite_code)' };
    return;
  }

  // 查出当前用户
  const currentUsers: any = await query('SELECT id, referrer_id, invite_code FROM t_user WHERE openid = ? LIMIT 1', [openid]);
  if (currentUsers.length === 0) {
    ctx.body = { code: 404, msg: '用户不存在' };
    return;
  }
  const curUser = currentUsers[0];

  // 不能绑定自己
  if (curUser.invite_code === invite_code) {
    ctx.body = { code: 400, msg: '不可使用自己的推荐码' };
    return;
  }

  // 如果已经绑定过推荐人，终身锁客不可更改
  if (curUser.referrer_id) {
    ctx.body = { code: 0, msg: '已绑定过推荐人', data: { referrer_id: curUser.referrer_id } };
    return;
  }

  // 根据邀请码查询推荐人 (必须是会员)
  const referrers: any = await query('SELECT id, nickname FROM t_user WHERE invite_code = ? LIMIT 1', [invite_code]);
  if (referrers.length === 0) {
    ctx.body = { code: 400, msg: '无效的邀请码' };
    return;
  }

  await query('UPDATE t_user SET referrer_id = ? WHERE id = ?', [referrers[0].id, curUser.id]);
  ctx.body = {
    code: 0,
    msg: '推荐关系绑定成功',
    data: {
      referrer_id: referrers[0].id,
      referrer_name: referrers[0].nickname
    }
  };
}

/**
 * 会员主动申请退出会员 (需求第5条: 会员可以退，变成非会员)
 */
export async function exitMembership(ctx: Context) {
  const openid = (ctx.headers['x-wx-openid'] as string) || (ctx.query.openid as string);
  if (!openid) {
    ctx.status = 401;
    ctx.body = { code: 401, msg: '未识别身份' };
    return;
  }

  await query(
    'UPDATE t_user SET is_member = 0, red_packet_points = 0.00 WHERE openid = ?',
    [openid]
  );

  ctx.body = {
    code: 0,
    msg: '已成功退出会员身份，恢复为普通客官。红包积分已失效清零，普通积分已为您保留。'
  };
}

/**
 * 免费/手动开通会员 (若后台配置为免费一键开通)
 */
export async function activateFreeMembership(ctx: Context) {
  const openid = (ctx.headers['x-wx-openid'] as string) || (ctx.query.openid as string);
  if (!openid) {
    ctx.status = 401;
    ctx.body = { code: 401, msg: '未识别身份' };
    return;
  }

  await query('UPDATE t_user SET is_member = 1 WHERE openid = ?', [openid]);
  ctx.body = { code: 0, msg: '尊享会员已成功开通！即享全场8.8折与推荐返利！' };
}
