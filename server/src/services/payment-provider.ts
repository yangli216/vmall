import { query } from '../db';
import { requireValue } from '../domain/errors';
import { WechatPay, WechatPayError } from './wechat-pay';
import { simulationEnabled } from './local-simulation';

// Channel records survive restarts, independently of order state. Business code
// still validates amounts/identities and uses its existing ledger transactions.
export class LocalPayment extends WechatPay {
  constructor() {
    if (!simulationEnabled()) throw new Error('Local payments are disabled');
    super({appid:process.env.WECHAT_APP_ID || 'local-test-app', mchid:'LOCAL_SIMULATION',
      serial:'', privateKey:'', apiKey:'', publicKeys:{}, notifyUrl:'', refundNotifyUrl:''});
  }
  async request(_method:string, _path:string, _input?:any):Promise<any> {
    throw new Error('Simulated payments cannot call WeChat');
  }
  async prepay(order:any, openid:string) {
    const total = Math.round(Number(order.pay_amount) * 100);
    await query(`INSERT IGNORE INTO t_dev_payment(out_trade_no,buyer_openid,total_fen,transaction_id)
      VALUES (?,?,?,?)`, [order.order_sn,openid,total,`SIM_${order.order_sn}`]);
    const result = await this.query(order.order_sn);
    requireValue(result.payer.openid===openid && result.amount.total===total, '模拟支付信息不匹配',409);
    return `SIM_${order.order_sn}`;
  }
  paymentParams(prepayId:string) {
    return {simulated:true, timeStamp:'', nonceStr:'', package:prepayId, signType:'RSA', paySign:''};
  }
  async query(orderSn:string):Promise<any> {
    const rows:any=await query('SELECT * FROM t_dev_payment WHERE out_trade_no=?',[orderSn]);
    if(!rows.length)throw new WechatPayError('ORDER_NOT_EXIST','local');
    return this.transaction(rows[0]);
  }
  transaction(row:any) {
    return {appid:this.config.appid,mchid:this.config.mchid,trade_type:'JSAPI',trade_state:row.trade_state,
      out_trade_no:row.out_trade_no,transaction_id:row.transaction_id,payer:{openid:row.buyer_openid},
      amount:{total:Number(row.total_fen),payer_total:Number(row.total_fen),currency:'CNY'}};
  }
  async close(orderSn:string):Promise<any> {
    const rows:any=await query('SELECT trade_state FROM t_dev_payment WHERE out_trade_no=?',[orderSn]);
    if(!rows.length)return;
    if(rows[0].trade_state==='SUCCESS')throw new WechatPayError('ORDERPAID','local');
    await query("UPDATE t_dev_payment SET trade_state='CLOSED' WHERE out_trade_no=? AND trade_state='NOTPAY'",[orderSn]);
  }
  async refund(order:any):Promise<any> {
    const paid=await this.query(order.order_sn);
    requireValue(paid.trade_state==='SUCCESS' && paid.transaction_id===order.transaction_id,'模拟交易未付款',409);
    await query("UPDATE t_dev_payment SET refund_sn=?,refund_status='SUCCESS' WHERE out_trade_no=? AND (refund_sn IS NULL OR refund_sn=?)",
      [order.refund_sn,order.order_sn,order.refund_sn]);
    return this.queryRefund(order.refund_sn);
  }
  async queryRefund(refundSn:string):Promise<any> {
    const rows:any=await query('SELECT * FROM t_dev_payment WHERE refund_sn=?',[refundSn]);
    if(!rows.length)throw new WechatPayError('RESOURCE_NOT_EXISTS','local');
    const row=rows[0];
    return {status:row.refund_status,mchid:this.config.mchid,out_trade_no:row.out_trade_no,
      out_refund_no:row.refund_sn,transaction_id:row.transaction_id,
      amount:{total:Number(row.total_fen),refund:Number(row.total_fen),payer_refund:Number(row.total_fen)}};
  }
  notification(_raw:string,_headers:Record<string,any>):never {
    throw new Error('Local simulation uses its own confirmation endpoint');
  }
}

export function paymentProvider():WechatPay {
  return simulationEnabled() ? new LocalPayment() : new WechatPay();
}
