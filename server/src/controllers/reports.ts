import { Context } from 'koa';
import { dailyReport, reportTransactions } from '../services/reports';
export async function daily(ctx:Context){
  ctx.set('Cache-Control','private, no-store');ctx.body={code:0,data:await dailyReport(ctx.query.date)};
}
export async function transactions(ctx:Context){
  ctx.set('Cache-Control','private, no-store');ctx.body={code:0,data:await reportTransactions(ctx.query.date,ctx.query.kind,ctx.query.before_id)};
}
