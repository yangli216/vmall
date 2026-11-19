import { PoolConnection } from 'mysql2/promise';
import pool from '../db';
import { requireValue } from '../domain/errors';
import { chinaDate } from '../domain/batches';
import { beforeId, pageRows } from '../domain/pagination';

export function reportDay(value:unknown) {
  const day=value===undefined?chinaDate():value;
  requireValue(typeof day==='string' && /^20\d{2}-\d{2}-\d{2}$/.test(day),'请选择有效的报表日期');
  const start=new Date(day+'T00:00:00+08:00');
  requireValue(!Number.isNaN(start.getTime()) && chinaDate(start)===day,'报表日期不存在');
  return {day,start:day+' 00:00:00',end:chinaDate(new Date(start.getTime()+86400000))+' 00:00:00'};
}
// SUM results are cast to strings in SQL, preserving every fen beyond JS float
// precision and without applying the single-order price validation ceiling.
export function reportFen(value:unknown):bigint {
  const raw=String(value ?? '0');
  requireValue(/^-?\d+(?:\.0+)?$/.test(raw),'报表金额格式异常',503);
  return BigInt(raw.split('.')[0]);
}
export function reportYuan(value:bigint):string {
  const sign=value<0n?'-':'',absolute=value<0n?-value:value;
  return sign+String(absolute/100n)+'.'+String(absolute%100n).padStart(2,'0');
}
const sumFen=(expression:string)=>`CAST(COALESCE(SUM(${expression}*100),0) AS CHAR)`;
async function snapshot<T>(work:(conn:PoolConnection)=>Promise<T>):Promise<T> {
  const conn=await pool.getConnection();
  try {
    await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const result=await work(conn);await conn.commit();return result;
  }catch(error){await conn.rollback();throw error;}finally{conn.release();}
}
export async function dailyReport(date:unknown) {
  const period=reportDay(date);
  return snapshot(async conn=>{
    const [payments]:any=await conn.execute(`SELECT COUNT(*) AS orders,
      COALESCE(SUM(pay_amount=0),0) AS zero_orders,
      COALESCE(SUM(payer_paid_amount IS NULL),0) AS unknown_payer_orders,
      ${sumFen('pay_amount')} AS nominal,${sumFen('payer_paid_amount')} AS payer
      FROM t_order WHERE pay_time>=? AND pay_time<? AND payment_state IN ('PAID','REFUNDING','REFUNDED')`,[period.start,period.end]);
    const [refunds]:any=await conn.execute(`SELECT COUNT(*) AS orders,
      COALESCE(SUM(payer_refund_amount IS NULL),0) AS unknown_payer_orders,
      ${sumFen('pay_amount')} AS nominal,${sumFen('payer_refund_amount')} AS payer
      FROM t_order WHERE closed_time>=? AND closed_time<? AND payment_state='REFUNDED'`,[period.start,period.end]);
    const [coverage]:any=await conn.execute(`SELECT
      COALESCE(SUM(payment_state='LEGACY'),0) AS legacy_orders,
      COALESCE(SUM(payment_state IN ('PAID','REFUNDING','REFUNDED') AND pay_time IS NULL),0) AS missing_payment_time,
      COALESCE(SUM(payment_state='REFUNDED' AND closed_time IS NULL),0) AS missing_refund_time FROM t_order`);
    const [fulfillment]:any=await conn.execute(`SELECT COUNT(*) AS created_orders,
      COALESCE(SUM(order_status=10 AND payment_state='UNPAID'),0) AS unpaid,
      COALESCE(SUM(order_status=20 AND payment_state='PAID'),0) AS preparing,
      COALESCE(SUM(order_status=25 AND payment_state='PAID'),0) AS ready_pickup,
      COALESCE(SUM(order_status=30 AND payment_state='PAID'),0) AS delivering,
      COALESCE(SUM(order_status=40 AND payment_state='PAID'),0) AS completed,
      COALESCE(SUM(payment_state='REFUNDING'),0) AS refund_pending,
      COALESCE(SUM(payment_state='REFUNDED'),0) AS refunded,
      COALESCE(SUM(order_status=60 AND payment_state='UNPAID'),0) AS cancelled_unpaid,
      COALESCE(SUM(payment_state='LEGACY'),0) AS legacy
      FROM t_order WHERE batch_date=?`,[period.day]);
    const [products]:any=await conn.execute(`SELECT i.product_id,i.product_title,SUM(i.quantity) AS quantity,${sumFen('i.subtotal')} AS total
      FROM t_order o JOIN t_order_item i ON i.order_id=o.id
      WHERE o.batch_date=? AND o.payment_state='PAID' AND o.order_status IN (20,25,30,40)
      GROUP BY i.product_id,i.product_title ORDER BY quantity DESC,i.product_id,i.product_title LIMIT 31`,[period.day]);
    const [benefits]:any=await conn.execute(`SELECT account_type,event_type,COUNT(*) AS records,
      ${sumFen('amount')} AS amount FROM t_account_flow WHERE create_time>=? AND create_time<?
      GROUP BY account_type,event_type ORDER BY account_type,event_type`,[period.start,period.end]);
    const pay=payments[0],refund=refunds[0],complete=Number(pay.unknown_payer_orders)===0 && Number(refund.unknown_payer_orders)===0;
    return {date:period.day,timezone:'Asia/Shanghai',generated_at:new Date().toISOString(),
      cash:{payment_orders:Number(pay.orders),zero_orders:Number(pay.zero_orders),refund_orders:Number(refund.orders),
        nominal_paid:reportYuan(reportFen(pay.nominal)),nominal_refunded:reportYuan(reportFen(refund.nominal)),nominal_net:reportYuan(reportFen(pay.nominal)-reportFen(refund.nominal)),
        known_payer_paid:reportYuan(reportFen(pay.payer)),known_payer_refunded:reportYuan(reportFen(refund.payer)),
        unknown_payment_orders:Number(pay.unknown_payer_orders),unknown_refund_orders:Number(refund.unknown_payer_orders),
        payer_amounts_complete:complete,payer_net:complete?reportYuan(reportFen(pay.payer)-reportFen(refund.payer)):null},
      coverage:coverage[0],fulfillment:fulfillment[0],products:products.slice(0,30).map((p:any)=>({...p,total:reportYuan(reportFen(p.total))})),has_more_products:products.length>30,
      benefits:benefits.map((r:any)=>({...r,amount:reportYuan(reportFen(r.amount)),unit:r.account_type.startsWith('NORMAL_POINT')?'分':'元'}))};
  });
}
export async function reportTransactions(date:unknown,kind:unknown,before:unknown) {
  const period=reportDay(date),cursor=beforeId(before);
  requireValue(kind==='PAYMENT' || kind==='REFUND','请选择支付或退款明细');
  const time=kind==='PAYMENT'?'pay_time':'closed_time',payer=kind==='PAYMENT'?'payer_paid_amount':'payer_refund_amount';
  const state=kind==='PAYMENT'?"payment_state IN ('PAID','REFUNDING','REFUNDED')":"payment_state='REFUNDED'";
  const params:any[]=[period.start,period.end];if(cursor)params.push(cursor);
  const [rows]:any=await pool.execute(`SELECT id,order_sn,batch_date,batch_time,payment_state,${time} AS booked_at,
    CAST(pay_amount AS CHAR) AS nominal_amount,CAST(${payer} AS CHAR) AS payer_amount
    FROM t_order WHERE ${time}>=? AND ${time}<? AND ${state} ${cursor?'AND id<?':''} ORDER BY id DESC LIMIT 31`,params);
  return {date:period.day,kind,...pageRows<any>(rows)};
}
