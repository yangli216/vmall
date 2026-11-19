const {test}=require('node:test');const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {WechatPay,rsaSign,verifyWechatSignature,decryptResource,payConfig}=require('../dist/services/wechat-pay');
const {validatePayment,ownOrder}=require('../dist/services/orders');
const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
const keys={PUB_KEY_ID_TEST:publicKey};
function signed(body,timestamp=String(Math.floor(Date.now()/1000))){const nonce='nonce';return {'wechatpay-serial':'PUB_KEY_ID_TEST','wechatpay-timestamp':timestamp,'wechatpay-nonce':nonce,'wechatpay-signature':rsaSign(`${timestamp}\n${nonce}\n${body}\n`,privateKey)};}
test('valid raw-body signature succeeds, modified payload and probe signatures fail',()=>{
 const body='{"a":1}',headers=signed(body);verifyWechatSignature(body,headers,keys);
 assert.throws(()=>verifyWechatSignature('{"a":2}',headers,keys));
 assert.throws(()=>verifyWechatSignature(body,{...headers,'wechatpay-signature':'WECHATPAY/SIGNTEST/test'},keys));
 assert.throws(()=>verifyWechatSignature(body,{...headers,'wechatpay-serial':'unknown'},keys));
 assert.throws(()=>verifyWechatSignature(body,signed(body,'1'),keys));
});
test('AES-GCM authenticates ciphertext and associated data',()=>{
 const key='01234567890123456789012345678901',nonce='012345678901',aad='transaction';
 const cipher=crypto.createCipheriv('aes-256-gcm',Buffer.from(key),nonce);cipher.setAAD(Buffer.from(aad));
 const data=Buffer.concat([cipher.update('{"trade_state":"SUCCESS"}'),cipher.final(),cipher.getAuthTag()]);
 const resource={algorithm:'AEAD_AES_256_GCM',nonce,associated_data:aad,ciphertext:data.toString('base64')};
 assert.equal(decryptResource(resource,key).trade_state,'SUCCESS');assert.throws(()=>decryptResource({...resource,associated_data:'tampered'},key));
});
test('signed API requests and client payment parameters follow WeChat canonical strings',async()=>{
 let request;
 const config={appid:'wx-test',mchid:'merchant',serial:'cert',privateKey,apiKey:'0'.repeat(32),publicKeys:keys,notifyUrl:'https://example.com/api/payment/notify',refundNotifyUrl:'https://example.com/api/refund/notify'};
 const provider=new WechatPay(config,async(url,options)=>{request={url,options};const raw='{"prepay_id":"test-prepay"}';return new Response(raw,{status:200,headers:signed(raw)});});
 await provider.prepay({order_sn:'PXD1',pay_amount:'1.01',expires_at:'2026-11-19 15:00:00'},'buyer');
 assert.equal(JSON.parse(request.options.body).amount.total,101);assert.equal(JSON.parse(request.options.body).payer.openid,'buyer');
 const values=Object.fromEntries([...request.options.headers.Authorization.matchAll(/(\w+)="([^"]*)"/g)].map(x=>[x[1],x[2]]));
 const canonical=`POST\n/v3/pay/transactions/jsapi\n${values.timestamp}\n${values.nonce_str}\n${request.options.body}\n`;
 assert.equal(crypto.verify('RSA-SHA256',Buffer.from(canonical),publicKey,Buffer.from(values.signature,'base64')),true);
 const p=provider.paymentParams('test-prepay');assert.equal(crypto.verify('RSA-SHA256',Buffer.from(`wx-test\n${p.timeStamp}\n${p.nonceStr}\n${p.package}\n`),publicKey,Buffer.from(p.paySign,'base64')),true);
});
test('unsigned provider responses never change payment state',async()=>{
 const provider=new WechatPay({publicKeys:keys,privateKey,mchid:'m',serial:'s'},async()=>new Response('{"trade_state":"SUCCESS"}'));
 await assert.rejects(()=>provider.query('PXD1'));
});
test('notification business fields must match amount, merchant, app, order and buyer',()=>{
 const order={user_id:1,order_sn:'PXD1',pay_amount:'12.00'},config={appid:'wx',mchid:'m'};
 const data={trade_state:'SUCCESS',trade_type:'JSAPI',appid:'wx',mchid:'m',out_trade_no:'PXD1',transaction_id:'wx-txn',payer:{openid:'buyer'},amount:{total:1200,payer_total:1200,currency:'CNY'}};
 validatePayment(order,'buyer',data,config);
 for(const change of [{appid:'wrong'},{mchid:'wrong'},{out_trade_no:'wrong'},{payer:{openid:'other'}},{trade_state:'NOTPAY'},{amount:{total:1,payer_total:1,currency:'CNY'}}])assert.throws(()=>validatePayment(order,'buyer',{...data,...change},config));
 assert.throws(()=>ownOrder(order,{id:2,is_admin:0}));
 ownOrder(order,{id:2,is_admin:1},true);
});
test('missing payment configuration fails closed',()=>{assert.throws(()=>payConfig({}),/未配置完成/);});
