// Destructive setup is restricted to a newly-created, randomly-named test database.
const {test}=require('node:test');const assert=require('node:assert/strict');const mysql=require('mysql2/promise');const fs=require('node:fs');const path=require('node:path');const {execFileSync}=require('node:child_process');
if(!process.env.TEST_MYSQL_HOST)throw new Error('Set TEST_MYSQL_HOST and TEST_MYSQL_PORT for an isolated MySQL 8 instance. See compose.test.yml.');
process.env.NODE_ENV='test';process.env.ALLOW_DEV_AUTH='true';process.env.ADMIN_OPENIDS='test-admin';
// This test process must never inherit usable merchant credentials.
for(const key of Object.keys(process.env))if(key==='WECHAT_APP_ID' || key.startsWith('WECHATPAY_'))delete process.env[key];
const name='pandou_test_'+Date.now();process.env.MYSQL_HOST=process.env.TEST_MYSQL_HOST;process.env.MYSQL_PORT=process.env.TEST_MYSQL_PORT||'3306';process.env.MYSQL_USER=process.env.TEST_MYSQL_USER||'root';process.env.MYSQL_USERNAME=process.env.MYSQL_USER;process.env.MYSQL_PASSWORD=process.env.TEST_MYSQL_PASSWORD||'';process.env.MYSQL_DATABASE=name;process.env.MYSQL_ADDRESS='';
const {chinaDate}=require('../dist/domain/batches');
test('MySQL8 migration, live HTTP, competing last-item orders, zero-payment idempotency and stock release',async(t)=>{
 const admin=await mysql.createConnection({host:process.env.MYSQL_HOST,port:Number(process.env.MYSQL_PORT),user:process.env.MYSQL_USER,password:process.env.MYSQL_PASSWORD});
 let server,pool;
 try{
  assert.match(name,/^pandou_test_\d+$/);await admin.query('CREATE DATABASE `'+name+'` CHARACTER SET utf8mb4');await admin.changeUser({database:name});
  const init=fs.readFileSync(path.join(__dirname,'../../init.sql'),'utf8').replace(/^\s*--.*$/gm,'');
  for(const sql of init.split(';').map(s=>s.trim()).filter(Boolean))await admin.query(sql);
  execFileSync(process.execPath,[path.join(__dirname,'../scripts/migrate.js')],{env:process.env,stdio:'pipe'});
  // A second execution must be a no-op, preserving existing balances and orders.
  execFileSync(process.execPath,[path.join(__dirname,'../scripts/migrate.js')],{env:process.env,stdio:'pipe'});
  pool=require('../dist/db').default;server=require('../dist/app').createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  async function api(url,body,who='buyer-a'){
   const response=await fetch(base+url,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-dev-openid':who},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,...await response.json()};
  }
  for(const who of ['buyer-a','buyer-b'])assert.equal((await api('/api/user/info',null,who)).code,0);
  await admin.query("UPDATE t_user SET is_member=1,normal_points=100,red_packet_points=5 WHERE openid IN ('buyer-a','buyer-b')");
  await admin.query('UPDATE t_product SET origin_price=10,member_price=10,stock_qty=1 WHERE id=1');
  const date=chinaDate(new Date(Date.now()+86400000));
  const body={items:[{product_id:1,quantity:1}],delivery_type:2,receiver_name:'测试',receiver_phone:'13958001122',batch_date:date,batch_time:'16:30',use_normal_points:true,use_red_packet_points:true,custom_red_amount:'5.00',expected_pay_amount:'0.00'};
  const attempts=await Promise.all(['buyer-a','buyer-b'].map((who,i)=>api('/api/order/create',{...body,request_id:'integration_last_item_'+i},who)));
  assert.equal(attempts.filter(r=>r.code===0).length,1);assert.equal(attempts.filter(r=>r.code===409).length,1);
  const index=attempts.findIndex(r=>r.code===0),winner=index===0?'buyer-a':'buyer-b',orderId=attempts[index].data.order_id;
  const duplicate=await api('/api/order/create',{...body,request_id:'integration_last_item_'+index},winner);assert.equal(duplicate.data.order_id,orderId);
  assert.equal((await api('/api/order/payment',{order_id:orderId},winner)).data.paid,true);
  assert.equal((await api('/api/order/complete',{order_id:orderId},winner)).code,403);
  assert.equal((await api('/api/order/payment',{order_id:orderId},index===0?'buyer-b':'buyer-a')).code,403);
  assert.equal((await api('/api/order/cancel',{order_id:orderId},winner)).data.order_status,50);
  const [balances]=await admin.query('SELECT normal_points,red_packet_points FROM t_user WHERE openid=?',[winner]);assert.equal(balances[0].normal_points,100);assert.equal(Number(balances[0].red_packet_points),5);
  const [stocks]=await admin.query('SELECT available_qty FROM t_batch_stock WHERE product_id=1 AND batch_date=?',[date]);assert.equal(stocks[0].available_qty,1);
  const [count]=await admin.query('SELECT COUNT(*) AS total FROM t_order');assert.equal(count[0].total,1);
  const clockResponse=await fetch(base+'/api/order/list',{headers:{'x-dev-openid':winner}}),clockBody=await clockResponse.json();
  assert.equal(clockResponse.headers.get('cache-control'),'no-store');assert.ok(Number.isSafeInteger(clockBody.server_time));assert.ok(Math.abs(clockBody.server_time-Date.now())<5000);
  await t.test('merchant settings serialize conflicting revisions, survive retries and audit failures, and preserve existing pickup addresses',async()=>{
   assert.equal((await api('/api/admin/config',null,'buyer-a')).code,403);
   const read=async()=>{const result=await api('/api/admin/config',null,'test-admin');assert.equal(result.code,0);return result.data;};
   const original=await read();assert.match(original.revision,/^[a-f0-9]{64}$/);assert.equal(original.configs.ADMIN_PASSCODE,undefined);
   const save=(configs,revision=original.revision)=>api('/api/admin/config/update',{configs,expected_revision:revision},'test-admin');
   assert.equal((await api('/api/admin/config/update',{configs:{WORKSHOP_ADDRESS:'新地址'}},'test-admin')).code,409);
   assert.equal((await save({WORKSHOP_ADDRESS:' '})).code,400);assert.equal((await save({BATCH_CUTOFF_TIME:'17:00'})).code,400);
   const races=await Promise.all([save({BATCH_CUTOFF_TIME:'16:20'}),save({BATCH_SCHEDULE_TIME:'16:10'})]);
   assert.equal(races.filter(r=>r.code===0).length,1);assert.equal(races.filter(r=>r.code===409).length,1);
   const changed=await read();assert.ok(changed.configs.BATCH_CUTOFF_TIME<=changed.configs.BATCH_SCHEDULE_TIME);
   const winning=races.findIndex(r=>r.code===0),retry=await save(winning===0?{BATCH_CUTOFF_TIME:'16:20'}:{BATCH_SCHEDULE_TIME:'16:10'});assert.equal(retry.code,0);assert.equal(retry.data.revision,changed.revision);
   const restored=await save({BATCH_CUTOFF_TIME:original.configs.BATCH_CUTOFF_TIME,BATCH_SCHEDULE_TIME:original.configs.BATCH_SCHEDULE_TIME},changed.revision);assert.equal(restored.code,0);
   const [old]=await admin.execute('SELECT delivery_address FROM t_order WHERE id=?',[orderId]);
   const shop={WORKSHOP_ADDRESS:'浙江省杭州市临安区联调新门牌36号',DELIVERY_PERSON_NAME:'联调掌柜',DELIVERY_PERSON_PHONE:'13958001122'};
   const updated=await save(shop,restored.data.revision);assert.equal(updated.code,0);assert.notEqual(updated.data.revision,restored.data.revision);
   const listed=(await api('/api/config/all')).data;assert.equal(listed.WORKSHOP_ADDRESS,shop.WORKSHOP_ADDRESS);assert.equal(listed.DELIVERY_PERSON_NAME,shop.DELIVERY_PERSON_NAME);
   const created=await api('/api/order/create',{...body,request_id:'integration_new_pickup_address'},winner);assert.equal(created.code,0);
   const [newOrder]=await admin.execute('SELECT delivery_address FROM t_order WHERE id=?',[created.data.order_id]);assert.equal(newOrder[0].delivery_address,shop.WORKSHOP_ADDRESS);
   const [oldAgain]=await admin.execute('SELECT delivery_address FROM t_order WHERE id=?',[orderId]);assert.equal(oldAgain[0].delivery_address,old[0].delivery_address);
   await api('/api/order/cancel',{order_id:created.data.order_id},winner);
   await admin.query("CREATE TRIGGER fail_config_audit BEFORE INSERT ON t_admin_audit FOR EACH ROW BEGIN IF NEW.action='/api/admin/config/update' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test audit failure'; END IF; END");
   try{assert.equal((await save({WORKSHOP_ADDRESS:'不应提交的地址'},updated.data.revision)).code,500);}finally{await admin.query('DROP TRIGGER fail_config_audit');}
   const rollback=await read();assert.equal(rollback.revision,updated.data.revision);assert.equal(rollback.configs.WORKSHOP_ADDRESS,shop.WORKSHOP_ADDRESS);
   assert.equal((await save({WORKSHOP_ADDRESS:original.configs.WORKSHOP_ADDRESS,DELIVERY_PERSON_NAME:original.configs.DELIVERY_PERSON_NAME,DELIVERY_PERSON_PHONE:original.configs.DELIVERY_PERSON_PHONE},rollback.revision)).code,0);
  });
  await t.test('admin photo uploads serialize retries, verify registered covers and roll back database records on storage or audit failure',async()=>{
   const imageService=require('../dist/services/product-images'),sharp=require('sharp');
   const savedPut=imageService.productImageStorage.put;
   const envKeys=['PRODUCT_IMAGE_UPLOAD_ENABLED','WECHAT_OPENAPI_ENABLED','PRODUCT_IMAGE_ENV_ID','PRODUCT_IMAGE_BUCKET','PRODUCT_IMAGE_REGION'];const original=envKeys.map(k=>process.env[k]);
   Object.assign(process.env,{PRODUCT_IMAGE_UPLOAD_ENABLED:'true',WECHAT_OPENAPI_ENABLED:'true',PRODUCT_IMAGE_ENV_ID:'prod-test',PRODUCT_IMAGE_BUCKET:'test-bucket-12345',PRODUCT_IMAGE_REGION:'ap-shanghai'});
   let calls=0,fail=false;
   imageService.productImageStorage.put=async(key,bytes)=>{calls++;assert.equal((await sharp(bytes).metadata()).format,'jpeg');if(fail)throw new Error('simulated-storage-failure');return 'cloud://prod-test.test-bucket-12345/'+key;};
   try {
    const base64=(await sharp({create:{width:16,height:12,channels:3,background:'red'}}).png().toBuffer()).toString('base64'),payload={request_id:'integration_photo_retry_001',base64};
    assert.equal((await api('/api/admin/product/image',payload,'buyer-a')).code,403);
    assert.equal((await api('/api/admin/product/image',{...payload,base64:'bad'},'test-admin')).code,400);
    const concurrent=await Promise.all([api('/api/admin/product/image',payload,'test-admin'),api('/api/admin/product/image',payload,'test-admin')]);
    assert.ok(concurrent.every(r=>r.code===0));assert.equal(calls,1);const id=concurrent[0].data.file_id;assert.equal(concurrent[1].data.file_id,id);
    const other=(await sharp({create:{width:16,height:12,channels:3,background:'blue'}}).png().toBuffer()).toString('base64');
    assert.equal((await api('/api/admin/product/image',{...payload,base64:other},'test-admin')).code,409);
    assert.equal((await api('/api/admin/product/image',payload,'test-admin')).data.file_id,id);assert.equal(calls,1);
    const data={title:'实拍上传测试',origin_price:10,member_price:9,category_id:1,stock_qty:2,cover_img:id};
    const added=await api('/api/admin/product/add',data,'test-admin');assert.equal(added.code,0);
    assert.equal((await api('/api/admin/product/update',{id:added.data.id,cover_img:'cloud://foreign.bucket/not-uploaded.jpg'},'test-admin')).code,400);
    assert.equal((await api('/api/admin/product/add',{...data,cover_img:'cloud://foreign.bucket/not-uploaded.jpg'},'test-admin')).code,400);
    assert.equal((await api('/api/admin/product/update',{id:added.data.id,title:'实拍更新'},'test-admin')).code,0);
    const [covers]=await admin.execute('SELECT cover_img FROM t_product WHERE id=?',[added.data.id]);assert.equal(covers[0].cover_img,id);
    assert.equal((await api('/api/admin/product/delete',{id:added.data.id},'test-admin')).code,0);
    const [kept]=await admin.execute('SELECT file_id FROM t_product_image WHERE file_id=?',[id]);assert.equal(kept.length,1);
    fail=true;assert.equal((await api('/api/admin/product/image',{...payload,request_id:'integration_photo_failed_001'},'test-admin')).code,500);fail=false;
    const [failed]=await admin.query("SELECT COUNT(*) AS total FROM t_product_image WHERE request_id='integration_photo_failed_001'");assert.equal(failed[0].total,0);
    await admin.query("CREATE TRIGGER fail_photo_audit BEFORE INSERT ON t_admin_audit FOR EACH ROW BEGIN IF NEW.action='/api/admin/product/image' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test audit failure'; END IF; END");
    try{assert.equal((await api('/api/admin/product/image',{...payload,request_id:'integration_photo_audit_001'},'test-admin')).code,500);}finally{await admin.query('DROP TRIGGER fail_photo_audit');}
    const [rolled]=await admin.query("SELECT COUNT(*) AS total FROM t_product_image WHERE request_id='integration_photo_audit_001'");assert.equal(rolled[0].total,0);
    assert.equal((await api('/api/admin/product/image',{...payload,request_id:'integration_photo_audit_001'},'test-admin')).code,0);
    const huge=await api('/api/admin/product/image',{base64:'a'.repeat(4*1024*1024)},'test-admin');assert.equal(huge.code,413);
    const malformed=await fetch(base+'/api/admin/product/image',{method:'POST',headers:{'content-type':'application/json','x-dev-openid':'test-admin'},body:'{bad'});assert.equal(malformed.status,400);
   }finally{imageService.productImageStorage.put=savedPut;envKeys.forEach((k,i)=>original[i]===undefined?delete process.env[k]:process.env[k]=original[i]);}
  });
  await t.test('product categories support CRUD, cascade product names and block deletion when used',async()=>{
   assert.equal((await api('/api/admin/category/add',{name:'非管理员'},'buyer-a')).code,403);
   const added=await api('/api/admin/category/add',{name:'凉拌时蔬',sort_order:88},'test-admin');
   assert.equal(added.code,0);const catId=added.data.id;
   assert.equal((await api('/api/admin/category/add',{name:'凉拌时蔬'},'test-admin')).code,409);
   const prod=await api('/api/admin/product/add',{title:'凉拌黄瓜',origin_price:'12.00',member_price:'10.00',category_id:catId,stock_qty:5},'test-admin');
   assert.equal(prod.code,0);
   assert.equal((await api('/api/admin/category/delete',{id:catId},'test-admin')).code,409);
   assert.equal((await api('/api/admin/category/update',{id:catId,name:'爽口凉拌',sort_order:90},'test-admin')).code,0);
   const list=(await api('/api/products?category_id='+catId,null,'buyer-a')).data;
   assert.equal(list[0].category_name,'爽口凉拌');
   assert.equal((await api('/api/admin/product/delete',{id:prod.data.id},'test-admin')).code,0);
   assert.equal((await api('/api/admin/category/delete',{id:catId},'test-admin')).code,0);
   const cats=(await api('/api/categories',null,'buyer-a')).data;
   assert.equal(cats.some(c=>c.id===catId),false);
  });
  await t.test('daily sign in grants points once per day, prevents duplicates and records ledger flow',async()=>{
   const who='signin-buyer';await api('/api/user/info',null,who);
   const initialStatus=await api('/api/user/signin-status',null,who);
   assert.equal(initialStatus.code,0);assert.equal(initialStatus.data.is_signed_today,false);assert.equal(initialStatus.data.reward_points,10);
   const signResult=await api('/api/user/signin',{},who);
   assert.equal(signResult.code,0);assert.equal(signResult.data.points_earned,10);assert.equal(signResult.data.is_signed_today,true);assert.equal(signResult.data.continuous_days,1);
   const duplicate=await api('/api/user/signin',{},who);
   assert.equal(duplicate.code,409);
   const afterStatus=await api('/api/user/signin-status',null,who);
   assert.equal(afterStatus.data.is_signed_today,true);assert.equal(afterStatus.data.continuous_days,1);
   const user=(await api('/api/user/info',null,who)).data;assert.equal(user.normal_points,10);
   const flows=(await api('/api/user/account-flows',null,who)).data;
   const signFlow=flows.find(f=>f.event_type==='SIGN_IN');assert.ok(signFlow);assert.equal(Number(signFlow.amount),10);
  });
  await t.test('personal information requests are private, deduplicate concurrent retries, retain replies and commit with admin audit',async()=>{
   const who='privacy-buyer';await api('/api/user/info',null,who);
   await admin.execute("UPDATE t_user SET phone='13958001122',nickname='隐私测试',avatar_url='https://example.com/a.jpg',normal_points=123,red_packet_points=4,is_member=1 WHERE openid=?",[who]);
   const payload={kind:'CLOSE_ACCOUNT',description:'希望核对订单与权益后申请注销，请在此回复具体方案',confirm_review:true,request_id:'integration_privacy_retry_001'};
   assert.equal((await api('/api/user/privacy/request',{...payload,confirm_review:false},who)).code,400);
   assert.equal((await api('/api/user/privacy/request',{...payload,kind:'OTHER'},who)).code,400);
   const attempts=await Promise.all([api('/api/user/privacy/request',payload,who),api('/api/user/privacy/request',payload,who)]);
   assert.ok(attempts.every(r=>r.code===0));const id=attempts[0].data.id;assert.equal(attempts[1].data.id,id);
   assert.equal((await api('/api/user/privacy/request',{...payload,request_id:'integration_privacy_retry_002'},who)).code,409);
   assert.equal((await api('/api/user/privacy/request',{...payload,description:'不同申请',request_id:'integration_privacy_other_001'},who)).code,409);
   assert.equal((await api('/api/user/privacy/request',{...payload,description:'修改同请求编号'},who)).code,409);
   assert.equal((await api('/api/user/privacy',null,'buyer-b')).data.list.length,0);
   const mine=(await api('/api/user/privacy',null,who)).data.list;assert.equal(mine.length,1);assert.equal(mine[0].description,payload.description);assert.equal(mine[0].operator_id,undefined);assert.equal(mine[0].openid,undefined);
   assert.equal((await api('/api/user/privacy/cancel',{id},'buyer-b')).code,403);
   assert.equal((await api('/api/admin/privacy',null,who)).code,403);
   assert.equal((await api('/api/admin/privacy/handle',{id,status:'PROCESSING'},who)).code,403);
   assert.ok((await api('/api/admin/activity',null,'test-admin')).data.queues.privacy_open>=1);
   await admin.query("CREATE TRIGGER fail_privacy_audit BEFORE INSERT ON t_admin_audit FOR EACH ROW BEGIN IF NEW.action='/api/admin/privacy/handle' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test audit failure'; END IF; END");
   try{assert.equal((await api('/api/admin/privacy/handle',{id,status:'PROCESSING'},'test-admin')).code,500);}finally{await admin.query('DROP TRIGGER fail_privacy_audit');}
   assert.equal((await api('/api/user/privacy',null,who)).data.list[0].status,'OPEN');
   assert.equal((await api('/api/admin/privacy/handle',{id,status:'PROCESSING'},'test-admin')).code,0);
   assert.equal((await api('/api/user/privacy/cancel',{id},who)).code,409);
   const resolution='已核对本人申请，尚未执行账号注销，请先确认积分红包的后续处理方案。';
   assert.equal((await api('/api/admin/privacy/handle',{id,status:'RESOLVED',resolution},'test-admin')).code,400);
   for(let i=0;i<2;i++)assert.equal((await api('/api/admin/privacy/handle',{id,status:'RESOLVED',resolution,confirm_actual_result:true},'test-admin')).code,0);
   assert.equal((await api('/api/admin/privacy/handle',{id,status:'RESOLVED',resolution:'覆盖原始回复',confirm_actual_result:true},'test-admin')).code,409);
   assert.equal((await api('/api/user/privacy/request',payload,who)).data.id,id);
   const result=(await api('/api/user/privacy',null,who)).data.list[0];assert.equal(result.status,'RESOLVED');assert.equal(result.resolution,resolution);
   const [unchanged]=await admin.execute('SELECT is_member,normal_points,red_packet_points,phone FROM t_user WHERE openid=?',[who]);assert.equal(unchanged[0].is_member,1);assert.equal(unchanged[0].normal_points,123);assert.equal(Number(unchanged[0].red_packet_points),4);assert.equal(unchanged[0].phone,'13958001122');
   assert.equal((await api('/api/user/clear-profile',{},who)).code,400);
   assert.equal((await api('/api/user/clear-profile',{confirm_clear_profile:true},who)).code,0);
   const [cleared]=await admin.execute('SELECT nickname,avatar_url,phone,normal_points,red_packet_points,is_member FROM t_user WHERE openid=?',[who]);assert.equal(cleared[0].nickname,'食客');assert.equal(cleared[0].phone,'');assert.equal(cleared[0].avatar_url,'');assert.equal(cleared[0].normal_points,123);assert.equal(Number(cleared[0].red_packet_points),4);assert.equal(cleared[0].is_member,1);
   assert.equal((await api('/api/user/update-profile',{nickname:'新昵称',phone:''},who)).code,0);
   const second=await api('/api/user/privacy/request',{...payload,kind:'DELETE',request_id:'integration_privacy_cancel_001'},who);assert.equal(second.code,0);
   for(let i=0;i<2;i++)assert.equal((await api('/api/user/privacy/cancel',{id:second.data.id},who)).code,0);
   assert.equal((await api('/api/admin/privacy/handle',{id:second.data.id,status:'PROCESSING'},'test-admin')).code,409);
   assert.equal((await api('/api/user/privacy?before_id=-1',null,who)).code,400);
   assert.equal((await api('/api/admin/privacy?status=UNKNOWN',null,'test-admin')).code,400);
   const [person]=await admin.execute('SELECT id FROM t_user WHERE openid=?',[who]);
   for(let i=0;i<35;i++)await admin.execute("INSERT INTO t_privacy_request(user_id,request_id,request_hash,kind,description,status) VALUES(?,?,'hash','ACCESS','历史申请','RESOLVED')",[person[0].id,'privacy-history-'+i]);
   const first=await api('/api/user/privacy',null,who),next=await api('/api/user/privacy?before_id='+first.data.next_cursor,null,who);assert.equal(first.data.list.length,30);assert.equal(new Set(first.data.list.concat(next.data.list).map(r=>r.id)).size,37);
   assert.equal((await api('/api/user/privacy/request',{...payload,request_id:'integration_privacy_rate_001'},who)).code,429);
  });
  await t.test('batch capacity serializes reservations, rolls back failures and retains fulfilled workload',async()=>{
   await admin.query("UPDATE t_system_config SET config_value='1' WHERE config_key='BATCH_MAX_ORDERS'");
   await admin.query("UPDATE t_user SET normal_points=100,red_packet_points=5 WHERE openid IN ('buyer-a','buyer-b')");
   await admin.execute('UPDATE t_batch_stock SET available_qty=10 WHERE product_id=1 AND batch_date=?',[date]);
   const capacity=async()=>(await api('/api/admin/batch-capacity?batch_date='+date+'&batch_time=16:30',null,'test-admin')).data;
   assert.equal((await capacity()).used_orders,0);
   const bad=await api('/api/order/create',{...body,request_id:'capacity_failed_price',expected_pay_amount:'99.00'},'buyer-a');
   assert.equal(bad.code,409);assert.equal((await capacity()).used_orders,0);
   const [a,b]=await Promise.all(['buyer-a','buyer-b'].map((who,i)=>api('/api/order/create',{...body,request_id:'capacity_concurrent_'+i},who)));
   const results=[a,b];assert.equal(results.filter(r=>r.code===0).length,1);assert.equal(results.filter(r=>r.code===409).length,1);
   const win=results.findIndex(r=>r.code===0),who=['buyer-a','buyer-b'][win],other=['buyer-a','buyer-b'][1-win],id=results[win].data.order_id;
   assert.equal((await capacity()).remaining_orders,0);
   assert.equal((await api('/api/order/create',{...body,request_id:'capacity_concurrent_'+win},who)).data.order_id,id);
   assert.equal((await capacity()).used_orders,1);
   const slots=(await api('/api/batches')).data;assert.equal(slots.slots.some(s=>s.date===date),false);assert.ok(slots.full_batch_labels.some(label=>label.includes('16:30')));
   assert.equal((await api('/api/order/calculate',body,other)).code,409);
   assert.equal((await api('/api/order/cancel',{order_id:id},who)).code,0);
   assert.equal((await capacity()).used_orders,0);
   const next=await api('/api/order/create',{...body,request_id:'capacity_concurrent_'+(1-win)},other);assert.equal(next.code,0);
   assert.equal((await api('/api/order/payment',{order_id:next.data.order_id},other)).data.paid,true);
   // A ready meal still used kitchen capacity, even if a later quality refund succeeds.
   await admin.execute('UPDATE t_order SET order_status=25 WHERE id=?',[next.data.order_id]);
   const refund=await api('/api/admin/order/refund',{order_id:next.data.order_id,reason:'本地验收备好后的退款'},'test-admin');assert.equal(refund.data.payment_state,'REFUNDED');
   assert.equal((await capacity()).used_orders,1);
   await api('/api/admin/order/refund',{order_id:next.data.order_id,reason:'重复本地验收退款'},'test-admin');assert.equal((await capacity()).used_orders,1);
   const pickup=await api('/api/admin/orders?batch_date='+date+'&delivery_type=2',null,'test-admin');assert.ok(pickup.data.length>0);assert.ok(pickup.data.every(o=>o.delivery_type===2));
   assert.equal((await api('/api/admin/orders?batch_date='+date+'&delivery_type=1',null,'test-admin')).data.length,0);
   assert.equal((await api('/api/admin/orders?delivery_type=3',null,'test-admin')).code,400);
   await admin.query("UPDATE t_system_config SET config_value='0' WHERE config_key='BATCH_MAX_ORDERS'");
  });
  await t.test('member and referral pages include all records with accurate totals and reject invalid cursors',async()=>{
   const [buyers]=await admin.execute('SELECT id FROM t_user WHERE openid=?',[winner]);
   for(let i=0;i<65;i++)await admin.execute('INSERT INTO t_user(openid,nickname,invite_code,referrer_id) VALUES(?,?,?,?)',['page-user-'+i,'分页食客'+i,'PAGE-'+i,buyers[0].id]);
   // Create the admin before asking for the total; this endpoint initializes its identity.
   const first=await api('/api/admin/members?keyword='+encodeURIComponent('分页食客'),null,'test-admin');
   assert.equal(first.code,0);assert.equal(first.data.total,65);
   let list=first.data.list,cursor=first.data.next_cursor;
   while(cursor){const r=await api('/api/admin/members?keyword='+encodeURIComponent('分页食客')+'&before_id='+cursor,null,'test-admin');assert.equal(r.code,0);list=list.concat(r.data.list);cursor=r.data.next_cursor;}
   assert.equal(list.length,65);assert.equal(new Set(list.map(u=>u.id)).size,65);assert.ok(list.every(u=>u.openid===undefined));
   let friends=[],next=null;
   do{const r=await api('/api/referral/my'+(next?'?before_id='+next:''),null,winner);assert.equal(r.code,0);assert.equal(r.data.summary.total_referred,65);friends=friends.concat(r.data.list);next=r.data.next_cursor;}while(next);
   assert.equal(friends.length,65);assert.equal(new Set(friends.map(u=>u.id)).size,65);
   for(const route of ['/api/admin/members','/api/referral/my'])assert.equal((await api(route+'?before_id=-1',null,'test-admin')).code,400);
  });
  await t.test('administrator mutations and audit records commit together, including rollback when auditing fails',async()=>{
   const [buyers]=await admin.execute('SELECT id FROM t_user WHERE openid=?',[winner]);
   const userId=buyers[0].id;
   const adjust=amount=>api('/api/admin/member/adjust-points',{user_id:userId,adjust_type:'NORMAL_POINT',amount,reason:'集成测试审计原子性',request_id:'integration_adjustment_'+amount},'test-admin');
   assert.equal((await adjust(1)).code,0);
   assert.equal((await adjust(1)).code,0); // Same request after a lost response must not credit twice.
   assert.equal((await api('/api/admin/member/adjust-points',{user_id:userId,adjust_type:'NORMAL_POINT',amount:10,reason:'集成测试审计原子性',request_id:'integration_adjustment_1'},'test-admin')).code,409);
   await admin.query("CREATE TRIGGER reject_test_audit BEFORE INSERT ON t_admin_audit FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'test audit unavailable'");
   try{
    assert.equal((await adjust(2)).code,500);
    assert.equal((await api('/api/admin/product/toggle',{product_id:1,status:0},'test-admin')).code,500);
    const [balances]=await admin.query('SELECT normal_points FROM t_user WHERE id=?',[userId]);assert.equal(balances[0].normal_points,101);
    const [products]=await admin.query('SELECT status FROM t_product WHERE id=1');assert.equal(products[0].status,1);
   }finally{await admin.query('DROP TRIGGER reject_test_audit');}
   assert.equal((await adjust(2)).code,0);
   const [balances]=await admin.query('SELECT normal_points FROM t_user WHERE id=?',[userId]);assert.equal(balances[0].normal_points,103);
   const [flows]=await admin.query("SELECT COUNT(*) AS total FROM t_account_flow WHERE event_type='ADMIN_ADJUST'");assert.equal(flows[0].total,2);
   const [audits]=await admin.query("SELECT COUNT(*) AS total FROM t_admin_audit WHERE action='/api/admin/member/adjust-points'");assert.equal(audits[0].total,3);
   assert.equal((await api('/api/order/cancel',{order_id:orderId},'test-admin')).code,403);
   assert.equal((await api('/api/order/sync-payment',{order_id:orderId},'test-admin')).code,403);
  });
  await t.test('support tickets are private, deduplicate retries and preserve payment state when staff reply',async()=>{
   const request={order_id:orderId,category:'PAYMENT',description:'请核对本地测试订单权益返还',request_id:'integration_support_request_1'};
   const responses=await Promise.all([api('/api/support/create',request,winner),api('/api/support/create',request,winner)]);
   assert.equal(responses[0].code,0);assert.equal(responses[1].code,0);assert.equal(responses[0].data.id,responses[1].data.id);
   const ticketId=responses[0].data.id;
   assert.equal((await api('/api/support/create',{...request,description:'不同的问题说明'},winner)).code,409);
   assert.equal((await api('/api/support/create',{...request,request_id:'integration_support_request_2'},winner)).code,409);
   const other=winner==='buyer-a'?'buyer-b':'buyer-a';
   assert.equal((await api('/api/support/create',request,other)).code,403);
   assert.equal((await api('/api/support/my?order_id='+orderId,null,other)).data.list.length,0);
   assert.equal((await api('/api/admin/support/handle',{id:ticketId,status:'RESOLVED',resolution:'不能自行回复'},winner)).code,403);
   const queue=await api('/api/admin/support?status=OPEN',null,'test-admin');assert.equal(queue.data.list.length,1);
   assert.equal((await api('/api/admin/support/handle',{id:ticketId,status:'PROCESSING'},'test-admin')).code,0);
   assert.equal((await api('/api/admin/support/handle',{id:ticketId,status:'RESOLVED',resolution:''},'test-admin')).code,400);
   const reply={id:ticketId,status:'RESOLVED',resolution:'已核对，抵扣权益已全部返还，具体见账户流水。'};
   assert.equal((await api('/api/admin/support/handle',reply,'test-admin')).code,0);
   assert.equal((await api('/api/admin/support/handle',reply,'test-admin')).code,0);
   assert.equal((await api('/api/admin/support/handle',{...reply,resolution:'覆盖原结果'},'test-admin')).code,409);
   const tickets=await api('/api/support/my?order_id='+orderId,null,winner);assert.equal(tickets.data.list[0].status,'RESOLVED');assert.equal(tickets.data.list[0].resolution,reply.resolution);
   const [orders]=await admin.query('SELECT order_status,payment_state FROM t_order WHERE id=?',[orderId]);assert.equal(orders[0].order_status,50);assert.equal(orders[0].payment_state,'REFUNDED');
   assert.equal((await api('/api/support/create',{...request,request_id:'integration_support_request_3'},winner)).code,0);
   assert.equal((await api('/api/health',null,winner)).status,'UP');
  });
  await t.test('poster endpoint uses only the current member code, fails closed when disabled, and binding still checks eligibility',async()=>{
   const {inviteCodes}=require('../dist/services/wechat-code');
   const original=inviteCodes.generate,previous=process.env.WECHAT_OPENAPI_ENABLED,calls=[];
   const [rows]=await admin.execute('SELECT id,invite_code,is_member FROM t_user WHERE openid=?',[winner]);const person=rows[0];
   try{
    await admin.execute('UPDATE t_user SET is_member=1 WHERE id=?',[person.id]);
    inviteCodes.generate=async(invite,version)=>{calls.push({invite,version});return {invite_code:invite,version,mime:'image/png',base64:'test-transport-only'};};
    process.env.WECHAT_OPENAPI_ENABLED='false';assert.equal((await api('/api/referral/code',{version:'release'},winner)).code,503);assert.equal(calls.length,0);
    process.env.WECHAT_OPENAPI_ENABLED='true';
    assert.equal((await api('/api/referral/code',{version:'wrong'},winner)).code,400);
    const own=await api('/api/referral/code',{version:'trial',invite_code:'FORGED-OTHER-MEMBER'},winner);
    assert.equal(own.code,0);assert.equal(own.data.invite_code,person.invite_code);assert.equal(calls[0].invite,person.invite_code);assert.equal(calls[0].version,'trial');
    assert.equal((await api('/api/referral/code',{version:'release'},'poster-nonmember')).code,403);assert.equal(calls.length,1);
    assert.equal((await api('/api/user/bind-referrer',{invite_code:person.invite_code},'poster-nonmember')).code,0);
    assert.equal((await api('/api/user/bind-referrer',{invite_code:person.invite_code},'poster-nonmember')).code,409);
    await admin.execute('UPDATE t_user SET is_member=0 WHERE id=?',[person.id]);
    assert.equal((await api('/api/referral/code',{version:'trial'},winner)).code,403);assert.equal(calls.length,1);
    assert.equal((await api('/api/user/bind-referrer',{invite_code:person.invite_code},'poster-after-revoke')).code,400);
   }finally{inviteCodes.generate=original;if(previous===undefined)delete process.env.WECHAT_OPENAPI_ENABLED;else process.env.WECHAT_OPENAPI_ENABLED=previous;await admin.execute('UPDATE t_user SET is_member=? WHERE id=?',[person.is_member,person.id]);}
  });
  await t.test('fulfillment evidence is atomic with audit, private to staff, and completed only once',async()=>{
   const [buyers]=await admin.execute('SELECT id FROM t_user WHERE openid=?',[winner]);
   const userId=buyers[0].id;
   const yesterday=chinaDate(new Date(Date.now()-86400000));
   const insert=async(sn,type,status,day)=>{
    const [result]=await admin.execute("INSERT INTO t_order(order_sn,user_id,delivery_type,goods_total_amount,pay_amount,paid_goods_amount,order_status,payment_state,batch_date,batch_time,pickup_code) VALUES(?,?,?,0,0,0,?,'PAID',?,'16:30','1234')",[sn,userId,type,status,day]);return result.insertId;
   };
   const id=await insert('FULFILL-DELIVERY',1,30,date),pickupId=await insert('FULFILL-OLD-PICKUP',2,25,yesterday);
   const request={order_id:id,delivery_confirmed:true,confirmation_note:'电话联系顾客确认收到餐品'};
   assert.equal((await api('/api/admin/order/complete',request,winner)).code,403);
   assert.equal((await api('/api/admin/order/complete',{order_id:id},'test-admin')).code,400);
   await admin.query("CREATE TRIGGER reject_fulfillment_audit BEFORE INSERT ON t_admin_audit FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'test audit unavailable'");
   try{
    assert.equal((await api('/api/admin/order/complete',request,'test-admin')).code,500);
    const [rows]=await admin.execute('SELECT order_status,completion_source FROM t_order WHERE id=?',[id]);assert.equal(rows[0].order_status,30);assert.equal(rows[0].completion_source,'');
   }finally{await admin.query('DROP TRIGGER reject_fulfillment_audit');}
   const responses=await Promise.all([api('/api/admin/order/complete',request,'test-admin'),api('/api/admin/order/complete',request,'test-admin')]);assert.ok(responses.every(r=>r.code===0));
   const [rows]=await admin.execute('SELECT order_status,completion_note,completion_source,completed_by FROM t_order WHERE id=?',[id]);
   assert.equal(rows[0].order_status,40);assert.equal(rows[0].completion_note,request.confirmation_note);assert.equal(rows[0].completion_source,'ADMIN_DELIVERY');assert.ok(rows[0].completed_by>0);
   const queue=await api('/api/admin/activity',null,'test-admin');assert.ok(queue.data.queues.overdue_pickup>=1);
   const overdue=await api('/api/admin/orders?overdue_pickup=1',null,'test-admin');assert.ok(overdue.data.some(o=>o.id===pickupId));assert.ok(overdue.data.every(o=>o.batch_date<chinaDate() && o.order_status===25 && o.delivery_type===2));
   assert.equal((await api('/api/admin/orders?overdue_pickup=2',null,'test-admin')).code,400);
   assert.equal((await api('/api/admin/order/complete',{order_id:pickupId,pickup_code:'9999'},'test-admin')).code,400);
   assert.equal((await api('/api/admin/order/complete',{order_id:pickupId,pickup_code:'1234'},'test-admin')).code,0);
   const [completed]=await admin.execute('SELECT completion_source FROM t_order WHERE id=?',[pickupId]);assert.equal(completed[0].completion_source,'ADMIN_PICKUP');
  });
  await t.test('activity revisions serialize commits, roll back failed payments, paginate without skips and reject customers',async()=>{
   const {withTransaction}=require('../dist/db');const {recordActivity,activitySnapshot}=require('../dist/services/activity');const {recordPaid,lockedOrder}=require('../dist/services/orders');
   assert.equal((await api('/api/admin/activity',null,winner)).code,403);
   assert.equal((await api('/api/admin/activity?after_revision=-1',null,'test-admin')).code,400);
   assert.equal((await api('/api/admin/activity?after_revision=1.5',null,'test-admin')).code,400);
   const baseline=await activitySnapshot();assert.deepEqual(baseline.events,[]);
   const [buyers]=await admin.execute('SELECT id FROM t_user WHERE openid=?',[winner]);
   const [result]=await admin.execute("INSERT INTO t_order(order_sn,user_id,delivery_type,goods_total_amount,pay_amount,order_status,payment_state,batch_date,batch_time) VALUES('ACTIVITY-PAYMENT',?,2,0,0,10,'UNPAID',?,'16:30')",[buyers[0].id,date]);
   const id=result.insertId,paid=()=>withTransaction(async conn=>recordPaid(conn,await lockedOrder(conn,id)));
   await admin.query("CREATE TRIGGER reject_activity BEFORE INSERT ON t_admin_activity FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'test activity unavailable'");
   try{
    await assert.rejects(paid);
    const [order]=await admin.execute('SELECT payment_state FROM t_order WHERE id=?',[id]);assert.equal(order[0].payment_state,'UNPAID');
    assert.equal((await activitySnapshot()).cursor,baseline.cursor);
   }finally{await admin.query('DROP TRIGGER reject_activity');}
   await Promise.all([paid(),paid()]);
   const event=await activitySnapshot(baseline.cursor);assert.equal(event.events.length,1);assert.equal(event.events[0].kind,'ORDER_PAID');assert.equal(event.events[0].order_id,id);
   const [supportEvents]=await admin.query("SELECT support_id,COUNT(*) AS total FROM t_admin_activity WHERE kind='SUPPORT_OPENED' GROUP BY support_id");assert.ok(supportEvents.length>0);assert.ok(supportEvents.every(e=>e.total===1));
   let release,ready;const gate=new Promise(resolve=>{release=resolve;}),inserted=new Promise(resolve=>{ready=resolve;});
   const before=event.cursor;
   const first=withTransaction(async conn=>{await recordActivity(conn,'ORDER_PAID',id);ready();await gate;});await inserted;
   let secondDone=false;const second=withTransaction(conn=>recordActivity(conn,'ORDER_PAID',id)).then(()=>{secondDone=true;});
   try{const during=await activitySnapshot(before);assert.equal(during.cursor,before);assert.equal(during.events.length,0);assert.equal(secondDone,false);}finally{release();await Promise.all([first,second]);}
   const after=await activitySnapshot(before);assert.deepEqual(after.events.map(e=>e.revision),[before+1,before+2]);
   await withTransaction(async conn=>{for(let i=0;i<55;i++)await recordActivity(conn,'ORDER_PAID',id);});
   const page1=await activitySnapshot(after.cursor);assert.equal(page1.events.length,50);assert.equal(page1.has_more,true);
   const page2=await activitySnapshot(page1.cursor);assert.equal(page2.events.length,5);assert.equal(page2.has_more,false);assert.equal(page2.events[0].revision,page1.cursor+1);
   const reset=await activitySnapshot(page2.cursor+100);assert.equal(reset.reset,true);assert.equal(reset.cursor,page2.cursor);assert.equal(reset.events.length,0);
  });
  await t.test('completed refunds reverse spent rewards once, preserve consumed stock, and offset future rewards',async()=>{
   const {withTransaction}=require('../dist/db');
   const {complete,recordRefund,lockedOrder}=require('../dist/services/orders');
   const {changeBalance,creditReward}=require('../dist/services/ledger');
   const [people]=await admin.query("SELECT id,openid FROM t_user WHERE openid IN ('buyer-a','buyer-b') ORDER BY id");
   const buyer=people[0],ref=people[1];
   await admin.query('UPDATE t_user SET is_member=1,normal_points=0,red_packet_points=0,total_consume_amount=100 WHERE id IN (?,?)',[buyer.id,ref.id]);
   const [insert]=await admin.execute(`INSERT INTO t_order(order_sn,user_id,delivery_type,goods_total_amount,pay_amount,paid_goods_amount,order_status,payment_state,transaction_id,batch_date,batch_time,stock_reserved,referrer_id)
    VALUES('PXD-INTEGRATION-AFTERSALE',?,1,100,100,100,30,'PAID','TXN-INTEGRATION-AFTERSALE',?,'16:30',1,?)`,[buyer.id,date,ref.id]);
   const id=insert.insertId;
   await admin.execute("INSERT INTO t_order_item(order_id,product_id,product_title,product_img,price,quantity,subtotal) VALUES(?,1,'售后测试','',100,1,100)",[id]);
   const [beforeStock]=await admin.execute('SELECT available_qty FROM t_batch_stock WHERE product_id=1 AND batch_date=?',[date]);
   await complete(id,{id:buyer.id,is_admin:0});
   // Both buyers have already spent all rewards on subsequent purchases.
   await withTransaction(async conn=>{
    await changeBalance(conn,buyer.id,'NORMAL_POINT',-100,'ORDER_RESERVE',id,'测试后续消费');
    await changeBalance(conn,ref.id,'RED_PACKET',-300,'ORDER_RESERVE',id,'测试后续消费');
   });
   assert.equal((await api('/api/admin/order/refund',{order_id:id,reason:'商品质量问题'},buyer.openid)).code,403);
   assert.equal((await api('/api/admin/order/refund',{order_id:id,reason:''},'test-admin')).code,400);
   assert.equal((await api('/api/order/cancel',{order_id:id},buyer.openid)).code,409);
   const request={order_id:id,reason:'本地集成验收质量退款'};
   const pending=await api('/api/admin/order/refund',request,'test-admin');
   assert.equal(pending.code,0);assert.equal(pending.data.payment_state,'REFUNDING');assert.equal(pending.data.refund_origin_status,40);
   // Payment transport is deliberately absent: no live charge or refund occurs.
   // Apply a verified-channel-shaped result directly to the transactional state machine.
   const result={out_trade_no:'PXD-INTEGRATION-AFTERSALE',out_refund_no:'RFPXD-INTEGRATION-AFTERSALE',transaction_id:'TXN-INTEGRATION-AFTERSALE',amount:{total:10000,refund:10000},status:'SUCCESS'};
   const apply=()=>withTransaction(async conn=>recordRefund(conn,await lockedOrder(conn,id),result,{config:{mchid:'test-only'}}));
   await Promise.all([apply(),apply()]);
   assert.equal((await api('/api/admin/order/refund',request,'test-admin')).data.payment_state,'REFUNDED');
   const [afterStock]=await admin.execute('SELECT available_qty FROM t_batch_stock WHERE product_id=1 AND batch_date=?',[date]);
   assert.equal(afterStock[0].available_qty,beforeStock[0].available_qty);
   const [debts]=await admin.query('SELECT id,normal_points,normal_points_debt,red_packet_points,red_packet_debt FROM t_user WHERE id IN (?,?) ORDER BY id',[buyer.id,ref.id]);
   assert.equal(debts[0].normal_points,0);assert.equal(debts[0].normal_points_debt,100);assert.equal(Number(debts[1].red_packet_points),0);assert.equal(Number(debts[1].red_packet_debt),3);
   const [commissions]=await admin.execute('SELECT status FROM t_commission_flow WHERE order_id=?',[id]);assert.equal(commissions[0].status,2);
   const [debtFlows]=await admin.execute("SELECT COUNT(*) AS count FROM t_account_flow WHERE order_id=? AND event_type='REFUND_REWARD_DEBT'",[id]);assert.equal(debtFlows[0].count,2);
   const info=await api('/api/user/info',null,buyer.openid);assert.equal(info.data.normal_points_debt,100);
   // A later order whose rewards pay down existing debt must also be reversible.
   const [offsetInsert]=await admin.execute(`INSERT INTO t_order(order_sn,user_id,delivery_type,goods_total_amount,pay_amount,paid_goods_amount,order_status,payment_state,transaction_id,batch_date,batch_time,referrer_id)
    VALUES('PXD-INTEGRATION-OFFSET',?,1,60,60,60,30,'PAID','TXN-INTEGRATION-OFFSET',?,'16:30',?)`,[buyer.id,date,ref.id]);
   const offsetId=offsetInsert.insertId;
   await complete(offsetId,{id:buyer.id,is_admin:0});
   await api('/api/admin/order/refund',{order_id:offsetId,reason:'测试抵回后再退款'},'test-admin');
   await withTransaction(async conn=>recordRefund(conn,await lockedOrder(conn,offsetId),{
    out_trade_no:'PXD-INTEGRATION-OFFSET',out_refund_no:'RFPXD-INTEGRATION-OFFSET',transaction_id:'TXN-INTEGRATION-OFFSET',amount:{total:6000,refund:6000},status:'SUCCESS'
   },{config:{mchid:'test-only'}}));
   const [restoredDebt]=await admin.query('SELECT id,normal_points_debt,red_packet_debt FROM t_user WHERE id IN (?,?) ORDER BY id',[buyer.id,ref.id]);
   assert.equal(restoredDebt[0].normal_points_debt,100);assert.equal(Number(restoredDebt[1].red_packet_debt),3);
   await withTransaction(async conn=>{
    await creditReward(conn,buyer.id,'NORMAL_POINT',60,'ORDER_EARN',999001,'测试后续奖励');
    await creditReward(conn,ref.id,'RED_PACKET',200,'REFERRAL_EARN',999001,'测试后续奖励');
   });
   const [partial]=await admin.query('SELECT id,normal_points,normal_points_debt,red_packet_points,red_packet_debt FROM t_user WHERE id IN (?,?) ORDER BY id',[buyer.id,ref.id]);
   assert.equal(partial[0].normal_points,0);assert.equal(partial[0].normal_points_debt,40);assert.equal(Number(partial[1].red_packet_points),0);assert.equal(Number(partial[1].red_packet_debt),1);
   await withTransaction(async conn=>{
    await creditReward(conn,buyer.id,'NORMAL_POINT',50,'ORDER_EARN',999002,'测试后续奖励');
    await creditReward(conn,ref.id,'RED_PACKET',150,'REFERRAL_EARN',999002,'测试后续奖励');
   });
   const [settled]=await admin.query('SELECT id,normal_points,normal_points_debt,red_packet_points,red_packet_debt FROM t_user WHERE id IN (?,?) ORDER BY id',[buyer.id,ref.id]);
   assert.equal(settled[0].normal_points,10);assert.equal(settled[0].normal_points_debt,0);assert.equal(Number(settled[1].red_packet_points),0.5);assert.equal(Number(settled[1].red_packet_debt),0);
   const {exitMember}=require('../dist/controllers/user');
   const {recoverReward}=require('../dist/services/ledger');
   await withTransaction(conn=>exitMember(conn,ref.id));
   await withTransaction(conn=>recoverReward(conn,ref.id,'RED_PACKET',50,999003));
   const [forfeited]=await admin.execute('SELECT red_packet_debt,red_packet_points,forfeited_red_rewards FROM t_user WHERE id=?',[ref.id]);
   assert.equal(Number(forfeited[0].red_packet_debt),0);assert.equal(Number(forfeited[0].red_packet_points),0);assert.equal(Number(forfeited[0].forfeited_red_rewards),0);
  });
  await t.test('reconciliation rotates past persistent failures, retries them after wrapping and never overlaps a running pass',async()=>{
   await api('/api/user/info',null,'retry-queue-buyer');const [users]=await admin.query("SELECT id FROM t_user WHERE openid='retry-queue-buyer'");const userId=users[0].id;
   await admin.execute('UPDATE t_user SET normal_points=0,red_packet_points=0 WHERE id=?',[userId]);
   const insert=async(suffix,pay,status,state,points=0,red=0)=>{
    const [result]=await admin.execute(`INSERT INTO t_order(order_sn,user_id,delivery_type,goods_total_amount,pay_amount,order_status,payment_state,expires_at,refund_sn,transaction_id,used_normal_points,used_red_packet_points)
     VALUES(?,?,2,10,?,?,?,DATE_SUB(NOW(),INTERVAL 1 MINUTE),?,?,?,?)`,['RETRY-QUEUE-'+suffix,userId,pay,status,state,'RFRETRY-QUEUE-'+suffix,'TXRETRY-QUEUE-'+suffix,points,red]);return result.insertId;
   };
   for(let i=0;i<20;i++)await insert('EXPIRE-'+i,10,10,'UNPAID');const expiry=await insert('EXPIRE-HEALTHY',0,10,'UNPAID',100);
   for(let i=0;i<20;i++)await insert('REFUND-'+i,10,70,'REFUNDING');const refund=await insert('REFUND-HEALTHY',0,70,'REFUNDING',0,5);
   const paymentModule=require('../dist/services/wechat-pay'),savedProvider=paymentModule.WechatPay,savedError=console.error,attempts=[];
   let enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
   paymentModule.WechatPay=class {
    async close(sn){attempts.push(sn);if(attempts.length===1){enter();await gate;}throw new Error('simulated-channel-outage');}
    async queryRefund(sn){attempts.push(sn);throw new Error('simulated-channel-outage');}
   };
   console.error=()=>{};const {reconcileOrders}=require('../dist/services/orders');const first=reconcileOrders();
   try{
    await Promise.race([entered,first.then(()=>{throw new Error('expected a blocked channel attempt');})]);
    await reconcileOrders();assert.equal(attempts.length,1);release();await first;
    const states=async()=>{const [rows]=await admin.execute('SELECT id,order_status,benefits_released FROM t_order WHERE id IN (?,?) ORDER BY id',[expiry,refund]);return rows;};
    const before=await states();assert.equal(before[0].order_status,10);assert.equal(before[1].order_status,70);
    await reconcileOrders();const completed=await states();assert.equal(completed[0].order_status,60);assert.equal(completed[1].order_status,50);assert.ok(completed.every(row=>row.benefits_released===1));
    assert.equal(new Set(attempts.filter(sn=>sn.startsWith('RETRY-QUEUE-EXPIRE-'))).size,20);assert.equal(new Set(attempts.filter(sn=>sn.startsWith('RFRETRY-QUEUE-REFUND-'))).size,20);
    const expiryAttempts=attempts.filter(sn=>sn==='RETRY-QUEUE-EXPIRE-0').length,refundAttempts=attempts.filter(sn=>sn==='RFRETRY-QUEUE-REFUND-0').length;
    await reconcileOrders();assert.ok(attempts.filter(sn=>sn==='RETRY-QUEUE-EXPIRE-0').length>expiryAttempts);assert.ok(attempts.filter(sn=>sn==='RFRETRY-QUEUE-REFUND-0').length>refundAttempts);
    const [balance]=await admin.execute('SELECT normal_points,red_packet_points FROM t_user WHERE id=?',[userId]);assert.equal(balance[0].normal_points,100);assert.equal(Number(balance[0].red_packet_points),5);
    const [pending]=await admin.query("SELECT COUNT(*) AS total FROM t_order WHERE order_sn LIKE 'RETRY-QUEUE-%' AND pay_amount>0 AND order_status IN (10,70)");assert.equal(pending[0].total,40);
   }finally{release();try{await first;}finally{paymentModule.WechatPay=savedProvider;console.error=savedError;}}
  });
  await t.test('daily reports separate booked cash, refunds, fulfillment and benefits, preserving unknowns and snapshot consistency',async()=>{
   const day='2026-03-31',next='2026-04-01';await api('/api/user/info',null,'report-buyer');
   const [people]=await admin.query("SELECT id FROM t_user WHERE openid='report-buyer'");const userId=people[0].id;
   const {withTransaction}=require('../dist/db'),{recordPaid,recordRefund}=require('../dist/services/orders');
   const [cashOrder]=await admin.execute("INSERT INTO t_order(order_sn,user_id,delivery_type,goods_total_amount,pay_amount,order_status,payment_state) VALUES('REPORT-VERIFIED-CASH',?,2,12,12,10,'UNPAID')",[userId]);
   const provider={config:{appid:'report-app',mchid:'report-merchant'}};
   const payment={trade_state:'SUCCESS',trade_type:'JSAPI',appid:'report-app',mchid:'report-merchant',out_trade_no:'REPORT-VERIFIED-CASH',transaction_id:'REPORT-VERIFIED-TRANSACTION',payer:{openid:'report-buyer'},amount:{currency:'CNY',total:1200,payer_total:900}};
   const transition=work=>withTransaction(async conn=>{const [rows]=await conn.execute('SELECT * FROM t_order WHERE id=? FOR UPDATE',[cashOrder.insertId]);await work(conn,rows[0]);});
   await transition((conn,order)=>recordPaid(conn,order,payment,provider));
   await admin.execute("UPDATE t_order SET pay_time='2026-05-01 12:00:00' WHERE id=?",[cashOrder.insertId]);
   await transition((conn,order)=>recordPaid(conn,order,payment,provider));
   const [paid]=await admin.execute("SELECT payer_paid_amount,DATE_FORMAT(pay_time,'%Y-%m-%d %H:%i:%s') AS pay_time,paid_goods_amount FROM t_order WHERE id=?",[cashOrder.insertId]);
   assert.equal(Number(paid[0].payer_paid_amount),9);assert.equal(Number(paid[0].paid_goods_amount),9);assert.equal(paid[0].pay_time,'2026-05-01 12:00:00');
   await admin.execute("UPDATE t_order SET order_status=70,payment_state='REFUNDING',refund_sn='RFREPORT-VERIFIED-CASH' WHERE id=?",[cashOrder.insertId]);
   const refund={out_trade_no:payment.out_trade_no,out_refund_no:'RFREPORT-VERIFIED-CASH',transaction_id:payment.transaction_id,status:'SUCCESS',amount:{total:1200,refund:1200,payer_refund:900}};
   await transition((conn,order)=>recordRefund(conn,order,refund,provider));
   await admin.execute("UPDATE t_order SET closed_time='2026-05-02 12:00:00' WHERE id=?",[cashOrder.insertId]);
   await transition((conn,order)=>recordRefund(conn,order,refund,provider));
   const [refunded]=await admin.execute("SELECT payer_paid_amount,payer_refund_amount,DATE_FORMAT(closed_time,'%Y-%m-%d %H:%i:%s') AS closed_time FROM t_order WHERE id=?",[cashOrder.insertId]);
   assert.equal(Number(refunded[0].payer_paid_amount),9);assert.equal(Number(refunded[0].payer_refund_amount),9);assert.equal(refunded[0].closed_time,'2026-05-02 12:00:00');
   const add=async(sn,state,status,nominal,payer,paid,closed,batch=day,refunded=null,qty=0)=>{
    const [row]=await admin.execute(`INSERT INTO t_order(order_sn,user_id,delivery_type,goods_total_amount,pay_amount,payer_paid_amount,payer_refund_amount,pay_time,closed_time,batch_date,batch_time,payment_state,order_status)
      VALUES(?,?,2,?,?,?,?,?,?,?,'16:30',?,?)`,['REPORT-'+sn,userId,nominal,nominal,payer,refunded,paid,closed,batch,state,status]);
    if(qty)await admin.execute("INSERT INTO t_order_item(order_id,product_id,product_title,product_img,price,quantity,subtotal) VALUES(?,1,'报表卤味','',10,?,?)",[row.insertId,qty,qty*10]);return row.insertId;
   };
   const original=await add('PAID','PAID',20,100,90,day+' 00:00:00',null,next,null,10);
   await add('REFUND','REFUNDED',50,50,45,'2026-03-30 18:00:00',day+' 12:00:00',day,45,5);
   await add('PENDING','REFUNDING',70,30,30,day+' 18:00:00',null,day,null,3);
   await add('ZERO','PAID',20,0,0,day+' 23:59:59',null,day,null,2);
   await add('LEGACY','LEGACY',20,100,null,day+' 12:00:00',null,day,null,10);
   await add('UNPAID','UNPAID',10,10,null,null,null,day,null,1);
   await add('CANCELLED','UNPAID',60,10,null,null,day+' 15:00:00',day,null,1);
   const unknownPay=await add('UNKNOWNPAY','PAID',20,10,null,day+' 10:00:00',null,day,null,1);
   const unknownRefund=await add('UNKNOWNREFUND','REFUNDED',50,20,20,'2026-03-30 12:00:00',day+' 13:00:00',day,null,2);
   await add('NEXT','PAID',20,30,30,next+' 00:00:00',null,day,null,3);
   await add('MISSINGPAYTIME','PAID',20,3,3,null,null);
   await add('MISSINGREFUNDTIME','REFUNDED',50,2,2,'2026-03-30 12:00:00',null,day,2);
   await admin.execute("INSERT INTO t_account_flow(user_id,account_type,event_type,amount,before_val,after_val,reason,create_time) VALUES(?,'NORMAL_POINT','ORDER_RESERVE',-100,100,0,'报表测试',?),(?,'RED_PACKET','REFERRAL_EARN',1.25,0,1.25,'报表测试',?)",[userId,day+' 00:00:00',userId,day+' 23:59:59']);
   assert.equal((await api('/api/admin/reports/daily?date='+day,null,'report-buyer')).code,403);
   const read=async(date=day)=>(await api('/api/admin/reports/daily?date='+date,null,'test-admin')).data;
   const report=await read();assert.equal(report.cash.payment_orders,4);assert.equal(report.cash.refund_orders,2);assert.equal(report.cash.zero_orders,1);
   assert.equal(report.cash.nominal_paid,'140.00');assert.equal(report.cash.nominal_refunded,'70.00');assert.equal(report.cash.nominal_net,'70.00');
   assert.equal(report.cash.known_payer_paid,'120.00');assert.equal(report.cash.known_payer_refunded,'45.00');assert.equal(report.cash.payer_net,null);assert.equal(report.cash.unknown_payment_orders,1);assert.equal(report.cash.unknown_refund_orders,1);
   assert.ok(report.coverage.legacy_orders>=1);assert.ok(report.coverage.missing_payment_time>=1);assert.ok(report.coverage.missing_refund_time>=1);
   assert.equal(report.products.length,1);assert.equal(Number(report.products[0].quantity),6);assert.equal(report.products[0].total,'60.00');
   assert.equal(report.fulfillment.unpaid,1);assert.equal(report.fulfillment.refund_pending,1);assert.equal(report.fulfillment.cancelled_unpaid,1);assert.equal(report.fulfillment.refunded,3);assert.equal(report.fulfillment.legacy,1);
   assert.equal(report.benefits.find(r=>r.account_type==='NORMAL_POINT').amount,'-100.00');assert.equal(report.benefits.find(r=>r.account_type==='RED_PACKET').amount,'1.25');
   await admin.execute('UPDATE t_order SET payer_paid_amount=10 WHERE id=?',[unknownPay]);await admin.execute('UPDATE t_order SET payer_refund_amount=20 WHERE id=?',[unknownRefund]);
   assert.equal((await read()).cash.payer_net,'65.00');assert.equal((await read('2026-03-30')).cash.nominal_net,'72.00');
   const refundOnly=await read('2026-02-02');assert.equal(refundOnly.cash.nominal_net,'0.00');assert.equal(refundOnly.cash.payment_orders,0);
   assert.equal((await api('/api/admin/reports/daily?date=2026-02-30',null,'test-admin')).code,400);
   assert.equal((await api('/api/admin/reports/transactions?date='+day+'&kind=FAKE',null,'test-admin')).code,400);
   const details=await api('/api/admin/reports/transactions?date='+day+'&kind=REFUND',null,'test-admin');assert.equal(details.data.list.length,2);assert.ok(details.data.list.every(r=>r.receiver_phone===undefined && r.user_id===undefined && r.openid===undefined));
   const getConnection=pool.getConnection;let release,ready;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>ready=resolve);let intercepted=false;
   pool.getConnection=async()=>{
    const conn=await getConnection.call(pool);
    return {query:conn.query.bind(conn),commit:conn.commit.bind(conn),rollback:conn.rollback.bind(conn),release:conn.release.bind(conn),execute:async(...args)=>{
     const result=await conn.execute(...args);if(!intercepted){intercepted=true;ready();await gate;}return result;
    }};
   };
   const work=require('../dist/services/reports').dailyReport(day);
   try{await Promise.race([started,work.then(()=>{throw new Error('report completed without the expected snapshot query');})]);await admin.execute("UPDATE t_order SET payment_state='REFUNDED',order_status=50,closed_time=?,payer_refund_amount=90 WHERE id=?",[day+' 20:00:00',original]);release();const consistent=await work;assert.equal(consistent.cash.refund_orders,2);assert.equal(consistent.cash.nominal_net,'70.00');}
   finally{release();try{await work;}finally{pool.getConnection=getConnection;}}
   const after=await read();assert.equal(after.cash.refund_orders,3);assert.equal(after.cash.nominal_net,'-30.00');assert.equal(after.cash.payer_net,'-25.00');
   for(let i=0;i<35;i++){
    const id=await add('PAGE-'+i,'PAID',20,1,1,'2026-04-02 12:00:00',null,'2026-04-02');
    await admin.execute("INSERT INTO t_order_item(order_id,product_id,product_title,product_img,price,quantity,subtotal) VALUES(?,1,?,'',1,1,1)",[id,'分页菜品'+i]);
   }
   const page=await api('/api/admin/reports/transactions?date=2026-04-02&kind=PAYMENT',null,'test-admin');assert.equal(page.data.list.length,30);assert.ok(page.data.next_cursor);
   const more=await api('/api/admin/reports/transactions?date=2026-04-02&kind=PAYMENT&before_id='+page.data.next_cursor,null,'test-admin');assert.equal(more.data.list.length,5);assert.equal(more.data.next_cursor,null);assert.equal(new Set(page.data.list.concat(more.data.list).map(r=>r.id)).size,35);
   const top=await read('2026-04-02');assert.equal(top.products.length,30);assert.equal(top.has_more_products,true);
  });
  await t.test('a real InnoDB deadlock retries the rolled-back transaction without duplicating effects',async()=>{
   const {withTransaction}=require('../dist/db');
   await admin.query('CREATE TABLE t_test_balance(id INT PRIMARY KEY, balance INT NOT NULL) ENGINE=InnoDB');
   await admin.query('INSERT INTO t_test_balance VALUES(1,0),(2,0)');
   await admin.query('CREATE TABLE t_test_event(id INT PRIMARY KEY) ENGINE=InnoDB');
   let arrivals=0,invocations=0,release;
   const gate=new Promise(resolve=>{release=resolve;});
   const transfer=(first,second,event)=>withTransaction(async conn=>{
    invocations++;
    await conn.execute('SELECT balance FROM t_test_balance WHERE id=? FOR UPDATE',[first]);
    arrivals++;if(arrivals===2)release();await gate;
    await conn.execute('INSERT INTO t_test_event(id) VALUES(?)',[event]);
    await conn.execute('UPDATE t_test_balance SET balance=balance+1 WHERE id=?',[second]);
    await conn.execute('UPDATE t_test_balance SET balance=balance+1 WHERE id=?',[first]);
   });
   await Promise.all([transfer(1,2,1),transfer(2,1,2)]);
   const [balances]=await admin.query('SELECT balance FROM t_test_balance ORDER BY id');
   assert.deepEqual(balances.map(r=>r.balance),[2,2]);
   const [events]=await admin.query('SELECT COUNT(*) AS total FROM t_test_event');assert.equal(events[0].total,2);assert.equal(invocations,3);
  });
  await t.test('upgrading populated older schemas backfills rewards and batch capacity without counting cancelled or legacy orders',async()=>{
   const os=require('node:os');
   const upgradeName='pandou_test_upgrade_'+Date.now();
   const stage=fs.mkdtempSync(path.join(os.tmpdir(),'pandou-upgrade-'));
   let upgrade;
   try{
    await admin.query('CREATE DATABASE `'+upgradeName+'` CHARACTER SET utf8mb4');
    upgrade=await mysql.createConnection({host:process.env.MYSQL_HOST,port:Number(process.env.MYSQL_PORT),user:process.env.MYSQL_USER,password:process.env.MYSQL_PASSWORD,database:upgradeName});
    for(const sql of init.split(';').map(s=>s.trim()).filter(Boolean))await upgrade.query(sql);
    fs.mkdirSync(path.join(stage,'scripts'));fs.mkdirSync(path.join(stage,'migrations'));
    fs.copyFileSync(path.join(__dirname,'../scripts/migrate.js'),path.join(stage,'scripts/migrate.js'));
    fs.symlinkSync(path.join(__dirname,'../node_modules'),path.join(stage,'node_modules'),'dir');
    const files=fs.readdirSync(path.join(__dirname,'../migrations')).filter(v=>v.endsWith('.sql')).sort();
    const run=()=>execFileSync(process.execPath,[path.join(stage,'scripts/migrate.js')],{env:{...process.env,MYSQL_DATABASE:upgradeName},stdio:'pipe'});
    for(const file of files.filter(v=>v<'004'))fs.copyFileSync(path.join(__dirname,'../migrations',file),path.join(stage,'migrations',file));
    run();
    const [person]=await upgrade.execute("INSERT INTO t_user(openid,nickname,invite_code) VALUES('upgrade-buyer','升级测试','UPGRADE-ONE')");
    const userId=person.insertId;
    const [completed]=await upgrade.execute("INSERT INTO t_order(order_sn,user_id,delivery_type,goods_total_amount,pay_amount,order_status,payment_state,batch_date,batch_time,completed_time) VALUES('UPGRADE-COMPLETED',?,1,60,60,40,'PAID',?,'16:30',NOW())",[userId,date]);
    await upgrade.execute("INSERT INTO t_account_flow(user_id,order_id,account_type,event_type,amount,before_val,after_val,reason) VALUES(?,?,'NORMAL_POINT','ORDER_EARN',60,0,60,'升级前已发积分'),(?,NULL,'RED_PACKET','MEMBER_EXIT',-3,3,0,'升级前退会清零')",[userId,completed.insertId,userId]);
    fs.copyFileSync(path.join(__dirname,'../migrations/004_after_sales_refunds.sql'),path.join(stage,'migrations/004_after_sales_refunds.sql'));run();
    const [earned]=await upgrade.execute('SELECT earned_normal_points FROM t_order WHERE id=?',[completed.insertId]);assert.equal(earned[0].earned_normal_points,60);
    const [forfeit]=await upgrade.execute('SELECT forfeited_red_rewards FROM t_user WHERE id=?',[userId]);assert.equal(Number(forfeit[0].forfeited_red_rewards),3);
    for(const [suffix,status,payment,origin] of [['READY',25,'PAID',null],['PREPARING',20,'PAID',null],['UNPAID',10,'UNPAID',null],['AFTERSALE',50,'REFUNDED',40],['BEFOREPREP',50,'REFUNDED',20],['CANCELLED',60,'UNPAID',null],['REFUNDING',70,'REFUNDING',20],['LEGACY',20,'LEGACY',null]]){
     await upgrade.execute('INSERT INTO t_order(order_sn,user_id,delivery_type,goods_total_amount,pay_amount,order_status,payment_state,batch_date,batch_time,refund_origin_status) VALUES(?,?,1,10,10,?,?,?,\'16:30\',?)',['UPGRADE-'+suffix,userId,status,payment,date,origin]);
    }
    fs.copyFileSync(path.join(__dirname,'../migrations/005_batch_capacity.sql'),path.join(stage,'migrations/005_batch_capacity.sql'));run();run();
    const [count]=await upgrade.execute('SELECT reserved_orders FROM t_batch_capacity WHERE batch_date=? AND batch_time=\'16:30\'',[date]);assert.equal(count[0].reserved_orders,6);
    const [excluded]=await upgrade.query("SELECT SUM(capacity_reserved) AS counted FROM t_order WHERE order_sn IN ('UPGRADE-BEFOREPREP','UPGRADE-CANCELLED','UPGRADE-LEGACY')");assert.equal(Number(excluded[0].counted),0);
    fs.copyFileSync(path.join(__dirname,'../migrations/006_fulfillment_activity.sql'),path.join(stage,'migrations/006_fulfillment_activity.sql'));run();run();
    fs.copyFileSync(path.join(__dirname,'../migrations/007_product_images.sql'),path.join(stage,'migrations/007_product_images.sql'));run();run();
    const [images]=await upgrade.query('SELECT COUNT(*) AS total FROM t_product_image');assert.equal(images[0].total,0);
    fs.copyFileSync(path.join(__dirname,'../migrations/008_privacy_requests.sql'),path.join(stage,'migrations/008_privacy_requests.sql'));run();run();
    const [privacy]=await upgrade.query('SELECT COUNT(*) AS total FROM t_privacy_request');assert.equal(privacy[0].total,0);
    await upgrade.execute("INSERT INTO t_order(order_sn,user_id,delivery_type,goods_total_amount,pay_amount,order_status,payment_state,pay_time,closed_time) VALUES('UPGRADE-ZERO-REFUND',?,2,10,0,50,'REFUNDED',NOW(),NOW()),('UPGRADE-ZERO-LEGACY',?,2,10,0,40,'LEGACY',NOW(),NULL),('UPGRADE-ZERO-UNPAID',?,2,10,0,10,'UNPAID',NULL,NULL)",[userId,userId,userId]);
    fs.copyFileSync(path.join(__dirname,'../migrations/009_report_payment_amounts.sql'),path.join(stage,'migrations/009_report_payment_amounts.sql'));run();run();
    fs.copyFileSync(path.join(__dirname,'../migrations/010_daily_signin.sql'),path.join(stage,'migrations/010_daily_signin.sql'));run();run();
    const [signins]=await upgrade.query('SELECT COUNT(*) AS total FROM t_user_sign_in');assert.equal(signins[0].total,0);
    fs.copyFileSync(path.join(__dirname,'../migrations/011_product_categories.sql'),path.join(stage,'migrations/011_product_categories.sql'));run();run();
    const [cats]=await upgrade.query('SELECT COUNT(*) AS total FROM t_product_category WHERE is_deleted=0');assert.equal(cats[0].total,5);
    const [amounts]=await upgrade.execute('SELECT payer_paid_amount,payer_refund_amount FROM t_order WHERE id=?',[completed.insertId]);assert.equal(amounts[0].payer_paid_amount,null);assert.equal(amounts[0].payer_refund_amount,null);
    const [zeros]=await upgrade.query("SELECT order_sn,payer_paid_amount,payer_refund_amount FROM t_order WHERE order_sn LIKE 'UPGRADE-ZERO-%'");
    const zeroRefund=zeros.find(r=>r.order_sn==='UPGRADE-ZERO-REFUND');assert.equal(Number(zeroRefund.payer_paid_amount),0);assert.equal(Number(zeroRefund.payer_refund_amount),0);
    assert.ok(zeros.filter(r=>r!==zeroRefund).every(r=>r.payer_paid_amount===null && r.payer_refund_amount===null));
    const [completion]=await upgrade.execute('SELECT completed_by,completion_source,completion_note FROM t_order WHERE id=?',[completed.insertId]);assert.equal(completion[0].completed_by,null);assert.equal(completion[0].completion_source,'');
    const [cursor]=await upgrade.query('SELECT revision FROM t_activity_cursor WHERE id=1');assert.equal(cursor[0].revision,0);
    const [activity]=await upgrade.query('SELECT COUNT(*) AS total FROM t_admin_activity');assert.equal(activity[0].total,0);

   }finally{if(upgrade)await upgrade.end();await admin.query('DROP DATABASE IF EXISTS `'+upgradeName+'`');fs.rmSync(stage,{recursive:true,force:true});}
  });
 }finally{if(server)await new Promise(r=>server.close(r));if(pool)await pool.end();await admin.query('DROP DATABASE IF EXISTS `'+name+'`');await admin.end();}
});
