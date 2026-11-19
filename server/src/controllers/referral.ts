import { Context } from 'koa';
import { requireValue } from '../domain/errors';
import { codeVersion, inviteCodes } from '../services/wechat-code';

export async function createInviteCode(ctx:Context) {
  requireValue(ctx.state.user.is_member===1,'成为有效会员后可生成专属邀请海报',403);
  const version=codeVersion((ctx.request.body as any).version);
  requireValue(process.env.WECHAT_OPENAPI_ENABLED==='true','海报暂不可用，请先使用好友分享',503);
  const image=await inviteCodes.generate(ctx.state.user.invite_code,version);
  ctx.set('Cache-Control','private, no-store');
  ctx.body={code:0,data:image};
}
