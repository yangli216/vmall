const {test}=require('node:test');
const assert=require('node:assert/strict');
const database=require('../dist/db');
const order=require('../dist/controllers/order');
const {createApp}=require('../dist/app');

test('public callback instances reject business routes before parsing or resolving identity',async()=>{
 const previousMode=process.env.SERVICE_MODE,originalQuery=database.query;
 const payment=order.paymentNotify,refund=order.refundNotify;
 let identityQueries=0,notificationCalls=0;
 database.query=async sql=>{
  if(sql.includes('WHERE openid')){identityQueries++;throw new Error('Public identity lookup');}
  return sql.includes('t_activity_cursor') ? [{revision:0}] : [];
 };
 for(const name of ['paymentNotify','refundNotify'])order[name]=async ctx=>{
  notificationCalls++;assert.equal(ctx.request.body.id,'unsigned-probe');
  ctx.status=400;ctx.body={code:'FAIL',message:'test verification rejected'};
 };
 process.env.SERVICE_MODE='callbacks';
 const server=createApp().listen(0,'127.0.0.1');
 // The selected role stays fixed for the lifetime of this app.
 if(previousMode===undefined)delete process.env.SERVICE_MODE;else process.env.SERVICE_MODE=previousMode;
 await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 try{
  for(const [method,path] of [
   ['GET','/api/products'],['GET','/api/config/all'],['GET','/api/order/list'],
   ['GET','/api/user/info'],['GET','/api/admin/members'],['POST','/api/admin/product/image'],
   ['POST','/api/order/create'],['GET','/api/payment/notify'],['HEAD','/api/refund/notify'],
   ['POST','/api/payment/notify/extra'],['POST','/api/refund/notify/']
  ]){
   const response=await fetch(base+path,{method,headers:{'x-wx-openid':'forged-public-user','content-type':'application/json'},
    ...(method==='POST'?{body:'{ malformed JSON'}:{})});
   assert.equal(response.status,404,`${method} ${path}`);
  }
  const health=await fetch(base+'/api/health',{headers:{'x-wx-openid':'forged-public-user'}});
  assert.equal(health.status,200);assert.deepEqual(await health.json(),{status:'UP'});
  assert.equal((await fetch(base+'/api/health',{method:'HEAD'})).status,200);
  for(const path of ['/api/payment/notify','/api/refund/notify']){
   const response=await fetch(base+path,{method:'POST',headers:{'x-wx-openid':'forged-public-user','content-type':'application/json'},body:JSON.stringify({id:'unsigned-probe'})});
   assert.equal(response.status,400);assert.equal((await response.json()).code,'FAIL');
  }
  assert.equal(identityQueries,0);assert.equal(notificationCalls,2);
  process.env.SERVICE_MODE='invalid-role';assert.throws(()=>createApp(),/Invalid SERVICE_MODE/);
 }finally{
  if(previousMode===undefined)delete process.env.SERVICE_MODE;else process.env.SERVICE_MODE=previousMode;
  database.query=originalQuery;order.paymentNotify=payment;order.refundNotify=refund;
  await new Promise(r=>server.close(r));await database.default.end();
 }
});
