import { Context } from 'koa';
import { createHash } from 'crypto';
import { query, withTransaction } from '../db';
import { positiveId, requireValue, text } from '../domain/errors';
import { beforeId, pageRows } from '../domain/pagination';

const kinds=['ACCESS','CORRECT','DELETE','CLOSE_ACCOUNT'];
const statuses=['OPEN','PROCESSING','RESOLVED','CANCELLED'];
// These are requests for human review. Saving a reply does not execute a
// deletion, close an account, or assert a statutory retention period.
export async function createRequest(ctx:Context) {
  const body=ctx.request.body as any;
  requireValue(kinds.includes(body.kind),'请选择个人信息处理类型');
  const description=text(body.description,'申请说明',1000);
  requireValue(typeof body.request_id==='string' && /^[A-Za-z0-9_-]{16,64}$/.test(body.request_id),'申请请求号无效，请重新提交');
  requireValue(body.confirm_review===true,'请确认申请需要掌柜核实处理');
  const hash=createHash('sha256').update(JSON.stringify({kind:body.kind,description})).digest('hex');
  const id=await withTransaction(async conn=>{
    // Serialize different request ids for this user, including response loss.
    await conn.execute('SELECT id FROM t_user WHERE id=? FOR UPDATE',[ctx.state.user.id]);
    const [existing]:any=await conn.execute('SELECT id,request_hash FROM t_privacy_request WHERE user_id=? AND request_id=?',[ctx.state.user.id,body.request_id]);
    if(existing.length){requireValue(existing[0].request_hash===hash,'该请求号已用于其他申请，请重新确认',409);return existing[0].id;}
    const [active]:any=await conn.execute('SELECT id,request_hash FROM t_privacy_request WHERE active_user_id=?',[ctx.state.user.id]);
    requireValue(!active.length,'已有处理中申请，请先查看进度或联系掌柜补充',409);
    const [recent]:any=await conn.execute('SELECT COUNT(*) AS total FROM t_privacy_request WHERE user_id=? AND create_time>=DATE_SUB(NOW(),INTERVAL 1 DAY)',[ctx.state.user.id]);
    requireValue(recent[0].total<10,'今日申请次数较多，请联系掌柜继续处理',429);
    const [result]:any=await conn.execute('INSERT INTO t_privacy_request(user_id,request_id,request_hash,kind,description) VALUES(?,?,?,?,?)',[ctx.state.user.id,body.request_id,hash,body.kind,description]);
    return result.insertId;
  });
  ctx.body={code:0,data:{id},msg:'申请已提交，请在本页查看掌柜回复；提交不等于已经注销或删除'};
}
async function list(ctx:Context,admin:boolean) {
  const cursor=beforeId(ctx.query.before_id),params:any[]=[];
  let sql=`SELECT p.id,p.user_id,p.kind,p.description,p.status,p.resolution,p.create_time,p.update_time${admin?',u.nickname,u.phone':''}
    FROM t_privacy_request p ${admin?'JOIN t_user u ON u.id=p.user_id':''} WHERE 1=1`;
  if(!admin){sql+=' AND p.user_id=?';params.push(ctx.state.user.id);}
  if(ctx.query.status!==undefined){requireValue(statuses.includes(String(ctx.query.status)),'申请状态无效');sql+=' AND p.status=?';params.push(ctx.query.status);}
  if(cursor){sql+=' AND p.id<?';params.push(cursor);}
  const rows:any=await query(sql+' ORDER BY p.id DESC LIMIT 31',params);
  ctx.set('Cache-Control','private, no-store');
  ctx.body={code:0,data:pageRows<any>(rows)};
}
export async function myRequests(ctx:Context){await list(ctx,false);}
export async function adminRequests(ctx:Context){await list(ctx,true);}
export async function cancelRequest(ctx:Context) {
  const id=positiveId((ctx.request.body as any).id);
  await withTransaction(async conn=>{
    const [rows]:any=await conn.execute('SELECT * FROM t_privacy_request WHERE id=? FOR UPDATE',[id]);
    requireValue(rows.length,'申请不存在',404);
    requireValue(rows[0].user_id===ctx.state.user.id,'无权撤回其他人的申请',403);
    if(rows[0].status==='CANCELLED')return;
    requireValue(rows[0].status==='OPEN','申请已接单或回复，请联系掌柜协商处理',409);
    await conn.execute("UPDATE t_privacy_request SET status='CANCELLED' WHERE id=?",[id]);
  });
  ctx.body={code:0,msg:'申请已撤回'};
}
export async function handleRequest(ctx:Context) {
  const body=ctx.request.body as any,id=positiveId(body.id);
  requireValue(['PROCESSING','RESOLVED'].includes(body.status),'处理状态无效');
  const resolution=body.status==='RESOLVED'?text(body.resolution,'具体处理说明',1000):'';
  if(body.status==='RESOLVED')requireValue(body.confirm_actual_result===true,'请先核实实际处理结果，并说明已处理内容及仍保留的信息');
  await withTransaction(async conn=>{
    const [rows]:any=await conn.execute('SELECT * FROM t_privacy_request WHERE id=? FOR UPDATE',[id]);
    requireValue(rows.length,'申请不存在',404);const request=rows[0];
    if(request.status==='RESOLVED'){requireValue(body.status==='RESOLVED' && resolution===request.resolution,'已保存的回复不能覆盖',409);return;}
    requireValue(request.status!=='CANCELLED','申请已撤回，不能继续处理',409);
    await conn.execute('UPDATE t_privacy_request SET status=?,resolution=?,operator_id=? WHERE id=?',[body.status,resolution,ctx.state.user.id,id]);
  });
  ctx.body={code:0,msg:body.status==='RESOLVED'?'回复已保存，请以实际执行结果为准':'已接单，请核实申请及交易情况'};
}
export async function clearProfile(ctx:Context) {
  requireValue((ctx.request.body as any).confirm_clear_profile===true,'请确认清除昵称、头像和资料手机号');
  await query("UPDATE t_user SET nickname='食客',avatar_url='',phone='' WHERE id=?",[ctx.state.user.id]);
  ctx.body={code:0,msg:'账户展示资料已清除，订单留存资料和会员资产未修改'};
}
