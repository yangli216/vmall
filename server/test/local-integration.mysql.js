// Uses only the local runner's loopback MySQL and a newly-created disposable DB.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const mysql=require('mysql2/promise');
const root=path.resolve(__dirname,'..'),project=path.resolve(root,'..');
const local=JSON.parse(fs.readFileSync(path.join(project,'.runtime/local-dev/config.json'),'utf8'));
if(local.mysqlPort!==33317)throw Error('Expected the isolated local MySQL');
const name='pandou_local_verify_'+Date.now();
for(const key of Object.keys(process.env))if(key.startsWith('MYSQL_') || key.startsWith('WECHATPAY_'))delete process.env[key];
Object.assign(process.env,{NODE_ENV:'development',PAYMENT_MODE:'mock',ALLOW_DEV_AUTH:'true',SERVICE_MODE:'app',BIND_HOST:'127.0.0.1',
 MYSQL_HOST:'127.0.0.1',MYSQL_PORT:'33317',MYSQL_DATABASE:name,MYSQL_USER:'root',MYSQL_PASSWORD:local.rootPassword,
 ADMIN_OPENIDS:'local-admin',WECHAT_APP_ID:'wx8e2380dec308d5de'});
test('local simulation preserves full order accounting and is isolated from real payment',async t=>{
 const admin=await mysql.createConnection({host:'127.0.0.1',port:33317,user:'root',password:local.rootPassword,dateStrings:true});
 let pool,server;
 try{
  assert.match(name,/^pandou_local_verify_\d+$/);
  await admin.query('CREATE DATABASE ?? CHARACTER SET utf8mb4',[name]);await admin.changeUser({database:name});
  const init=fs.readFileSync(path.join(project,'init.sql'),'utf8').replace(/^\s*--.*$/gm,'');
  for(const sql of init.split(';').map(s=>s.trim()).filter(Boolean))await admin.query(sql);
  execFileSync(process.execPath,[path.join(root,'scripts/migrate.js')],{env:process.env,cwd:root,stdio:'pipe'});
  await admin.query(fs.readFileSync(path.join(root,'scripts/local-payment-schema.sql'),'utf8'));
  await admin.query('UPDATE t_product SET stock_qty=50');
  pool=require('../dist/db').default;
  const {createApp}=require('../dist/app');
  server=createApp().listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  let base=`http://127.0.0.1:${server.address().port}`;
  const api=async(url,body,who='local-buyer')=>{
   const response=await fetch(base+url,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(who?{'x-dev-openid':who}:{})},...(body?{body:JSON.stringify(body)}:{})});
   return {status:response.status,...await response.json()};
  };
  const batches=await api('/api/batches');assert.equal(batches.code,0);
  const slot=batches.data.slots[0];assert.ok(slot,'Need an available current or next-day batch');
  const body={items:[{product_id:1,quantity:1}],delivery_type:2,receiver_name:'模拟测试',receiver_phone:'13900000000',
   batch_date:slot.date,batch_time:slot.time,use_normal_points:false,use_red_packet_points:false,expected_pay_amount:'48.00'};
  const make=async(tag)=>{const result=await api('/api/order/create',{...body,request_id:'local_verify_order_'+tag});assert.equal(result.code,0,JSON.stringify(result));return result.data.order_id;};
  const detail=id=>api('/api/order/detail?id='+id);
  await t.test('positive amount orders use simulated prepay, failures do not pay, and other users are rejected',async()=>{
   assert.equal((await api('/api/health')).payment_mode,'mock');
   assert.equal((await api('/api/dev/accounts')).data.accounts.length,3);
   assert.equal((await api('/api/dev/payment/confirm',{order_id:1,outcome:'SUCCESS'},'')).status,401);
   const id=await make('failure');
   assert.equal((await api('/api/dev/payment/confirm',{order_id:id,outcome:'SUCCESS'})).code,409);
   const payment=await api('/api/order/payment',{order_id:id});assert.equal(payment.data.payment.simulated,true);
   assert.equal((await api('/api/dev/payment/confirm',{order_id:id,outcome:'SUCCESS'},'other-buyer')).code,403);
   for(const outcome of ['FAIL','CANCEL'])assert.equal((await api('/api/dev/payment/confirm',{order_id:id,outcome})).data.paid,false);
   assert.equal((await detail(id)).data.payment_state,'UNPAID');
   assert.equal((await api('/api/order/cancel',{order_id:id})).data.order_status,60);
   assert.equal((await api('/api/dev/payment/confirm',{order_id:id,outcome:'SUCCESS'})).code,409);
  });
  let paidId;
  await t.test('concurrent success confirmations credit once, channel state survives API restart, and refunds reverse once',async()=>{
   paidId=await make('success');await api('/api/order/payment',{order_id:paidId});
   const results=await Promise.all([1,2].map(()=>api('/api/dev/payment/confirm',{order_id:paidId,outcome:'SUCCESS'})));
   results.forEach(r=>assert.equal(r.data.paid,true));
   let user=(await api('/api/user/info')).data;assert.equal(Number(user.total_consumption),48);
   await new Promise(resolve=>server.close(resolve));server=createApp().listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
   assert.equal((await api('/api/order/sync-payment',{order_id:paidId})).data.payment_state,'PAID');
   assert.equal((await api('/api/order/cancel',{order_id:paidId})).data.payment_state,'REFUNDED');
   assert.equal((await api('/api/order/cancel',{order_id:paidId})).data.payment_state,'REFUNDED');
   user=(await api('/api/user/info')).data;assert.equal(Number(user.total_consumption),0);
   assert.equal(Number((await detail(paidId)).data.payer_refund_amount),48);
  });
  await t.test('completion rewards and after-sales refund use the same ledger and are idempotent',async()=>{
   const id=await make('complete');await api('/api/order/payment',{order_id:id});await api('/api/dev/payment/confirm',{order_id:id,outcome:'SUCCESS'});
   // Move only this disposable fixture to today's pickup queue for fulfillment.
   const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
   await admin.execute("UPDATE t_order SET batch_date=?,order_status=25 WHERE id=?",[today,id]);
   const order=(await detail(id)).data;
   assert.equal((await api('/api/admin/order/complete',{order_id:id,pickup_code:order.pickup_code},'local-admin')).code,0);
   assert.equal((await api('/api/admin/order/complete',{order_id:id,pickup_code:order.pickup_code},'local-admin')).code,0);
   assert.equal((await api('/api/user/info')).data.normal_points,48);
   assert.equal((await api('/api/admin/order/refund',{order_id:id,reason:'本机联调售后退款'},'local-admin')).data.payment_state,'REFUNDED');
   const user=(await api('/api/user/info')).data;assert.equal(user.normal_points,0);assert.equal(Number(user.total_consumption),0);
  });
  await t.test('expired orders cannot simulate payment and the reconciliation path releases stock',async()=>{
   const id=await make('expiry');await api('/api/order/payment',{order_id:id});
   await admin.execute('UPDATE t_order SET expires_at=DATE_SUB(NOW(),INTERVAL 1 MINUTE) WHERE id=?',[id]);
   assert.equal((await api('/api/dev/payment/confirm',{order_id:id,outcome:'SUCCESS'})).code,409);
   await require('../dist/services/orders').reconcileOrders();
   assert.equal((await detail(id)).data.order_status,60);
   const [stock]=await admin.execute('SELECT available_qty FROM t_batch_stock WHERE product_id=1 AND batch_date=?',[slot.date]);
   assert.equal(Number(stock[0].available_qty),49); // One completed meal was consumed before its refund.
  });
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));if(pool)await pool.end();
  await admin.query('DROP DATABASE IF EXISTS ??',[name]);await admin.end();
 }
});
