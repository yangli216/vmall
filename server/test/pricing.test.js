const {test}=require('node:test');const assert=require('node:assert/strict');
const {fen,yuan,normalizeItems,priceOrder}=require('../dist/domain/pricing');
const {DEFAULT_CONFIG,publicConfigs,validateConfigs,configRevision}=require('../dist/services/config');
const {batchSlots,validateFulfillment}=require('../dist/domain/batches');
const {identity}=require('../dist/middlewares/auth');
const products=[{id:1,title:'卤味',origin_price:12,member_price:10.5,status:1,stock_qty:2,is_deleted:0}];
const user={is_member:1,normal_points:100,red_packet_points:100};
const config={...DEFAULT_CONFIG,RED_PACKET_MAX_DEDUCT_RATIO:'1.00'};
const opts={delivery_type:2,use_normal_points:true,use_red_packet_points:true};
test('money preserves exact fen and rejects rounding, infinities and negatives',()=>{
 assert.equal(fen('0.29'),29);assert.equal(yuan(29),'0.29');
 for(const v of [-1,NaN,Infinity,'1.001','1e2','-0.1',null,{},''])assert.throws(()=>fen(v));
});
test('cart merges repeated products before quantity and stock validation',()=>{
 assert.deepEqual(normalizeItems([{product_id:2,quantity:2},{product_id:1,quantity:1},{product_id:2,quantity:3}]),[{product_id:1,quantity:1},{product_id:2,quantity:5}]);
 for(const q of [0,-1,0.5,100,'2',NaN])assert.throws(()=>normalizeItems([{product_id:1,quantity:q}]));
 assert.throws(()=>normalizeItems([{product_id:1,quantity:60},{product_id:1,quantity:50}]));
});
test('all invalid products fail instead of silently creating empty free orders',()=>{
 for(const changes of [{status:0},{is_deleted:1},{stock_qty:0}])assert.throws(()=>priceOrder([{...products[0],...changes}],[{product_id:1,quantity:1}],user,config,opts));
 assert.throws(()=>priceOrder([],[{product_id:1,quantity:1}],user,config,opts));
});
test('stacked benefits never exceed goods price or waste a full voucher',()=>{
 const r=priceOrder(products,[{product_id:1,quantity:1}],user,config,opts);
 assert.equal(r.normal_deduct,'5.00');assert.equal(r.red_deduct,'5.50');assert.equal(r.final_pay_amount,'0.00');
 const cheap=priceOrder([{...products[0],member_price:3}],[{product_id:1,quantity:1}],user,config,opts);
 assert.equal(cheap.used_normal_points,0);assert.equal(cheap.red_deduct,'3.00');
});
test('benefits and referral base exclude delivery fee',()=>{
 const r=priceOrder(products,[{product_id:1,quantity:1}],user,config,{...opts,delivery_type:1});
 assert.equal(r.delivery_fee,'3.00');assert.equal(r.final_pay_amount,'3.00');assert.equal(r.commission_cash_base,'0.00');
});
test('normal customer cannot spend referral balance or receive member price',()=>{
 const r=priceOrder(products,[{product_id:1,quantity:1}],{...user,is_member:0},config,opts);
 assert.equal(r.member_discount,'0.00');assert.equal(r.red_deduct,'0.00');assert.equal(r.final_pay_amount,'7.00');
});
test('fee threshold uses member goods amount before point deductions',()=>{
 const r=priceOrder(products,[{product_id:1,quantity:2}],user,{...config,DELIVERY_FREE_THRESHOLD:'21.00'},{...opts,delivery_type:1});
 assert.equal(r.delivery_fee,'0.00');
});
test('public config and accepted writes exclude administrator credentials',()=>{
 assert.equal(configRevision({b:'2',a:'1'}),configRevision({a:'1',b:'2'}));assert.notEqual(configRevision({a:'1'}),configRevision({a:'2'}));
 assert.equal(publicConfigs([{config_key:'ADMIN_PASSCODE',config_value:'secret'}]).ADMIN_PASSCODE,undefined);
 assert.throws(()=>validateConfigs({ADMIN_PASSCODE:'changed'}));
 assert.throws(()=>validateConfigs({COMMISSION_RATE:'0.11'}));assert.throws(()=>validateConfigs({SHOP_OPEN:'true'}));
 for(const value of ['-1','1.5','10000','abc'])assert.throws(()=>validateConfigs({BATCH_MAX_ORDERS:value}));
 assert.equal(validateConfigs({BATCH_MAX_ORDERS:'100'}).BATCH_MAX_ORDERS,'100');
 assert.deepEqual(validateConfigs({COMMISSION_RATE:'0.03',DELIVERY_AREAS:'钱王新村'}),{COMMISSION_RATE:'0.03',DELIVERY_AREAS:'钱王新村'});
});
test('batch cutoff and dates use China timezone, independent of server timezone',()=>{
 const c={...DEFAULT_CONFIG};
 assert.deepEqual(batchSlots(c,new Date('2026-11-18T07:00:00Z')).map(s=>s.date),['2026-11-18','2026-11-19']);
 assert.deepEqual(batchSlots(c,new Date('2026-11-18T08:00:00Z')).map(s=>s.date),['2026-11-19']);
 assert.equal(batchSlots({...c,SHOP_OPEN:'0'},new Date()).length,0);
});
test('delivery whitelist and complete contacts are enforced before ordering',()=>{
 const now=new Date('2026-11-18T07:00:00Z'),c={...DEFAULT_CONFIG,DELIVERY_AREAS:'钱王新村,锦城小区'};
 const body={delivery_type:1,receiver_name:'王女士',receiver_phone:'13958001122',receiver_address:'钱王新村2幢302',delivery_area:'钱王新村',batch_date:'2026-11-18',batch_time:'16:30'};
 assert.equal(validateFulfillment(body,c,now).date,'2026-11-18');
 for(const changes of [{receiver_name:''},{receiver_phone:'123'},{delivery_area:'外地'},{receiver_address:'其他地址123'},{batch_date:'2026-11-20'},{delivery_type:3}])assert.throws(()=>validateFulfillment({...body,...changes},c,now));
 assert.throws(()=>validateFulfillment(body,{...c,DELIVERY_AREAS:''},now));
});
test('production identity ignores query and development headers',()=>{
 assert.equal(identity({'x-dev-openid':'test'},{NODE_ENV:'production',ALLOW_DEV_AUTH:'true'}),undefined);
 assert.equal(identity({'x-dev-openid':'test'},{NODE_ENV:'development',ALLOW_DEV_AUTH:'true'}),'test');
 assert.equal(identity({openid:'test'},{NODE_ENV:'development'}),undefined);
});
