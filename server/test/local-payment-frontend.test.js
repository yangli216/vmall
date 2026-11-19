const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../../miniprogram/utils/payment.js'),'utf8');
function client(choice,version='develop'){
 const calls=[];let wxPayments=0;
 const app={globalData:{allowLocalDev:version==='develop',runtimeVersion:version},api:async(url,method,body)=>{
  calls.push({url,body});
  if(url==='/api/order/payment')return {paid:false,payment:{simulated:true}};
  if(url==='/api/dev/payment/confirm')return {paid:body.outcome==='SUCCESS',simulated:true};
  if(url==='/api/order/sync-payment')return {payment_state:'PAID'};
  throw Error('Unexpected route');
 }};
 const wx={showActionSheet:options=>options.success({tapIndex:choice}),requestPayment:()=>{wxPayments++;}};
 const module={exports:{}};
 vm.runInNewContext(source,{getApp:()=>app,wx,module,setTimeout});
 return {pay:module.exports.payOrder,calls,wxPayments:()=>wxPayments};
}
test('simulated success uses the local confirmation and server state without invoking WeChat payment',async()=>{
 const c=client(0);const result=await c.pay(12);assert.equal(result.confirmed,true);assert.equal(result.simulated,true);
 assert.equal(c.wxPayments(),0);assert.equal(c.calls[1].body.outcome,'SUCCESS');assert.equal(c.calls[2].url,'/api/order/sync-payment');
});
test('simulated payment failure and cancellation retain an unpaid order for retry',async()=>{
 for(const [choice,outcome,message] of [[1,'FAIL',/模拟付款失败/],[2,'CANCEL',/已取消模拟支付/]]){
  const c=client(choice);await assert.rejects(()=>c.pay(12),message);assert.equal(c.calls[1].body.outcome,outcome);assert.equal(c.wxPayments(),0);
 }
});
test('trial and release builds refuse a mock response before displaying choices or confirming payment',async()=>{
 for(const version of ['trial','release']){
  const c=client(0,version);await assert.rejects(()=>c.pay(12),/不允许模拟支付/);assert.equal(c.calls.length,1);assert.equal(c.wxPayments(),0);
 }
});
