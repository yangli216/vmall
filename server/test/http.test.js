const {test}=require('node:test');const assert=require('node:assert/strict');
const {createApp}=require('../dist/app');const pool=require('../dist/db').default;
test('public API rejects fake pay, passcode upgrades and unsigned private requests without a database',async()=>{
 const server=createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 try {
  for(const [path,status,method] of [['/api/order/pay-success',410,'POST'],['/api/dev/accounts',404,'GET'],['/api/dev/payment/confirm',404,'POST'],['/api/admin/verify',410,'POST'],['/api/order/list?openid=forged',401,'GET'],['/api/admin/members',401,'GET'],['/api/user/activate-free',401,'POST'],['/api/referral/code',401,'POST'],['/api/admin/product/image',401,'POST'],['/api/user/privacy',401,'GET'],['/api/user/privacy/request',401,'POST'],['/api/user/clear-profile',401,'POST'],['/api/admin/privacy',401,'GET'],['/api/admin/privacy/handle',401,'POST'],['/api/admin/reports/daily',401,'GET'],['/api/admin/reports/transactions',401,'GET']]) {
    const response=await fetch(base+path,{method,headers:{'content-type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
    assert.equal(response.status,status,path);assert.equal((await response.json()).code,status,path);
  }
  const huge=JSON.stringify({base64:'a'.repeat(4*1024*1024)});
  assert.equal((await fetch(base+'/api/admin/product/image',{method:'POST',headers:{'content-type':'application/json'},body:huge})).status,401);
  const regular=await fetch(base+'/api/order/create',{method:'POST',headers:{'content-type':'application/json'},body:huge});assert.equal(regular.status,413);assert.match((await regular.json()).msg,/过大/);
 } finally {await new Promise(r=>server.close(r));await pool.end();}
});
