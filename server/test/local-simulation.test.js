const {test}=require('node:test');
const assert=require('node:assert/strict');
const {simulationEnabled}=require('../dist/services/local-simulation');
test('mock payments require explicit local development and an isolated database',()=>{
 const local={PAYMENT_MODE:'mock',NODE_ENV:'development',ALLOW_DEV_AUTH:'true',MYSQL_HOST:'127.0.0.1',MYSQL_DATABASE:'pandou_local_dev'};
 assert.equal(simulationEnabled(local),true);
 for(const change of [{NODE_ENV:'production'},{NODE_ENV:'test'},{ALLOW_DEV_AUTH:'false'},
  {MYSQL_HOST:'10.21.108.202'},{MYSQL_ADDRESS:'remote.example.com:3306'},
  {MYSQL_DATABASE:'pandou_db'},{SERVICE_MODE:'callbacks'},{BIND_HOST:'0.0.0.0'}]){
  assert.throws(()=>simulationEnabled({...local,...change}),/Mock payments require/);
 }
 assert.equal(simulationEnabled({NODE_ENV:'production'}),false);
 assert.equal(simulationEnabled({PAYMENT_MODE:'wechat'}),false);
 assert.throws(()=>simulationEnabled({PAYMENT_MODE:'unknown'}),/Invalid PAYMENT_MODE/);
});
test('local payment implementation refuses network and notification processing',async()=>{
 const saved={...process.env};
 try{
  Object.assign(process.env,{PAYMENT_MODE:'mock',NODE_ENV:'development',ALLOW_DEV_AUTH:'true',MYSQL_HOST:'127.0.0.1',MYSQL_DATABASE:'pandou_local_test',MYSQL_ADDRESS:'',SERVICE_MODE:'app',BIND_HOST:'127.0.0.1'});
  const {LocalPayment}=require('../dist/services/payment-provider');
  const provider=new LocalPayment();
  assert.equal(provider.paymentParams('SIM_TEST').simulated,true);
  await assert.rejects(()=>provider.request('POST','/v3/pay/transactions/jsapi'),/cannot call WeChat/);
  assert.throws(()=>provider.notification('{}',{}),/own confirmation endpoint/);
  process.env.NODE_ENV='production';assert.throws(()=>new LocalPayment(),/Mock payments require/);
 }finally{
  for(const key of Object.keys(process.env))if(!Object.hasOwn(saved,key))delete process.env[key];
  Object.assign(process.env,saved);
  await require('../dist/db').default.end();
 }
});
