import { Context } from 'koa';
import { withTransaction } from '../db';
import { requireValue, positiveId } from '../domain/errors';
import { chinaTimestamp } from '../domain/batches';
import { lockedOrder, ownOrder, recordPaid } from '../services/orders';
import { LocalPayment } from '../services/payment-provider';
import { LOCAL_ACCOUNTS, simulationEnabled } from '../services/local-simulation';

export async function accounts(ctx:Context) {
  requireValue(simulationEnabled(),'接口不存在',404);
  ctx.body={code:0,data:{simulated:true,accounts:LOCAL_ACCOUNTS}};
}
export async function confirmPayment(ctx:Context) {
  requireValue(simulationEnabled(),'接口不存在',404);
  const body=ctx.request.body as any, id=positiveId(body.order_id);
  requireValue(['SUCCESS','FAIL','CANCEL'].includes(body.outcome),'请选择模拟支付结果');
  const result=await withTransaction(async conn=>{
    const order=await lockedOrder(conn,id);ownOrder(order,ctx.state.user);
    requireValue(order.payment_state!=='LEGACY','历史订单不能模拟支付',409);
    const [rows]:any=await conn.execute('SELECT * FROM t_dev_payment WHERE out_trade_no=? FOR UPDATE',[order.order_sn]);
    requireValue(rows.length && rows[0].buyer_openid===ctx.state.user.openid,'请先发起模拟支付',409);
    const provider=new LocalPayment(), channel=rows[0];
    if(channel.trade_state==='SUCCESS') {
      requireValue(order.payment_state==='PAID','订单已经进入退款流程',409);
      return {paid:true,simulated:true};
    }
    requireValue(order.payment_state==='UNPAID' && order.order_status===10 && channel.trade_state==='NOTPAY','订单已关闭',409);
    requireValue(order.expires_at>chinaTimestamp(),'付款已超时，请重新下单',409);
    if(body.outcome!=='SUCCESS')return {paid:false,simulated:true,outcome:body.outcome};
    await conn.execute("UPDATE t_dev_payment SET trade_state='SUCCESS' WHERE out_trade_no=?",[order.order_sn]);
    await recordPaid(conn,order,provider.transaction({...channel,trade_state:'SUCCESS'}),provider);
    return {paid:true,simulated:true};
  });
  ctx.body={code:0,data:result};
}
