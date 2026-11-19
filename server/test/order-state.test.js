const {test}=require('node:test');const assert=require('node:assert/strict');
const db=require('../dist/db');const {DEFAULT_CONFIG}=require('../dist/services/config');
const {recordPaid,recordRefund,releaseBenefits,complete,create}=require('../dist/services/orders');
const {chinaDate}=require('../dist/domain/batches');
function store(extra={}) {
 const state={users:[{id:1,openid:'buyer',is_member:1,normal_points:100,red_packet_points:7,total_consume_amount:0,member_opt_out:0},{id:2,openid:'ref',is_member:1,normal_points:0,red_packet_points:0,total_consume_amount:0}],
 order:{id:1,user_id:1,order_sn:'PXD1',order_status:10,payment_state:'UNPAID',pay_amount:12,delivery_fee:0,paid_goods_amount:0,delivery_type:1,referrer_id:2,commission_rate:0.03,transaction_id:null,used_normal_points:0,used_red_packet_points:0,stock_reserved:1,benefits_released:0,batch_date:chinaDate(),batch_time:'16:30',refund_sn:'RFPXD1'},
 products:[{id:1,title:'卤味',cover_img:'',origin_price:12,member_price:12,status:1,stock_qty:1,is_deleted:0}],stock:1,flows:[],commissions:[],items:[{product_id:1,quantity:1}],existing:[],...extra};
 const conn={execute:async(sql,p=[])=>{
  assert.equal((sql.match(/\?/g)||[]).length,p.length,`SQL placeholder mismatch: ${sql}`);
  const q=sql.replace(/\s+/g,' ').trim();
  if(q.startsWith('SELECT * FROM t_order WHERE id'))return [[{...state.order}]];
  if(q.startsWith('SELECT * FROM t_user WHERE id'))return [[{...state.users.find(u=>u.id===p[0])}]];
  if(q.startsWith('SELECT config_key'))return [Object.entries(DEFAULT_CONFIG).map(([config_key,config_value])=>({config_key,config_value}))];
  if(q.startsWith('SELECT revision FROM t_activity_cursor'))return [[{revision:state.revision || 0}]];
  if(q.startsWith('UPDATE t_activity_cursor SET revision=')){state.revision=p[0];return [{affectedRows:1}];}
  if(q.startsWith('INSERT INTO t_admin_activity')){(state.events ||= []).push(p);return [{affectedRows:1}];}
  if(q.startsWith('INSERT IGNORE INTO t_batch_capacity'))return [{affectedRows:0}];
  if(q.startsWith('SELECT reserved_orders FROM t_batch_capacity'))return [[{reserved_orders:state.capacity || 0}]];
  if(q.startsWith('UPDATE t_batch_capacity SET reserved_orders=reserved_orders+1')){state.capacity=(state.capacity || 0)+1;return [{affectedRows:1}];}
  if(q.startsWith('SELECT normal_points_debt AS debt')||q.startsWith('SELECT red_packet_debt AS debt'))return [[{debt:0}]];
  if(q.startsWith('SELECT normal_points AS balance')||q.startsWith('SELECT red_packet_points AS balance')){const f=q.includes('normal_points')?'normal_points':'red_packet_points';return [[{balance:state.users.find(u=>u.id===p[0])[f]}]];}
  if(q.startsWith('UPDATE t_user SET normal_points = ?')||q.startsWith('UPDATE t_user SET red_packet_points = ?')){const f=q.includes('normal_points')?'normal_points':'red_packet_points';state.users.find(u=>u.id===p[1])[f]=Number(p[0]);return [{affectedRows:1}];}
  if(q.startsWith('INSERT INTO t_account_flow')){state.flows.push(p);return [{insertId:state.flows.length}];}
  if(q.startsWith('SELECT product_id,quantity FROM t_order_item'))return [state.items];
  if(q.startsWith('SELECT id,referrer_user_id,reward_red_points FROM t_commission_flow'))return [[]];
  if(q.startsWith('UPDATE t_batch_stock SET available_qty=available_qty+')){state.stock+=p[0];return [{affectedRows:1}];}
  if(q.startsWith('UPDATE t_order SET benefits_released')){Object.assign(state.order,{benefits_released:1,stock_reserved:0});return [{affectedRows:1}];}
  if(q.startsWith("UPDATE t_order SET order_status=20")){Object.assign(state.order,{order_status:20,payment_state:'PAID',transaction_id:p[0],paid_goods_amount:Number(p[1]),payer_paid_amount:Number(p[2])});return [{affectedRows:1}];}
  if(q.startsWith("UPDATE t_order SET order_status=70")){Object.assign(state.order,{order_status:70,payment_state:'REFUNDING',transaction_id:p[0],refund_sn:p[1],payer_paid_amount:Number(p[2])});return [{affectedRows:1}];}
  if(q.startsWith('UPDATE t_user SET total_consume_amount=total_consume_amount+')){state.users.find(u=>u.id===p[1]).total_consume_amount+=Number(p[0]);return [{affectedRows:1}];}
  if(q.startsWith('UPDATE t_user SET total_consume_amount=GREATEST')){const u=state.users.find(u=>u.id===p[1]);u.total_consume_amount=Math.max(0,u.total_consume_amount-Number(p[0]));return [{affectedRows:1}];}
  if(q.startsWith("UPDATE t_user SET is_member=0"))return [{affectedRows:0}];
  if(q.startsWith("UPDATE t_order SET order_status=50")){Object.assign(state.order,{order_status:50,payment_state:'REFUNDED',payer_refund_amount:p[0]===null?null:Number(p[0])});return [{affectedRows:1}];}
  if(q.startsWith('SELECT is_member FROM t_user'))return [[{is_member:state.users.find(u=>u.id===p[0]).is_member}]];
  if(q.startsWith('INSERT INTO t_commission_flow')){state.commissions.push(p);return [{insertId:state.commissions.length}];}
  if(q.startsWith('UPDATE t_order SET order_status=40')){Object.assign(state.order,{order_status:40,earned_normal_points:p[0],completed_by:p[1],completion_source:p[2],completion_note:p[3]});return [{affectedRows:1}];}
  if(q.startsWith('SELECT * FROM t_order WHERE user_id'))return [state.existing.filter(o=>o.user_id===p[0]&&o.request_id===p[1])];
  if(q.startsWith('SELECT * FROM t_product'))return [state.products.filter(o=>o.id===p[0])];
  if(q.startsWith('INSERT IGNORE INTO t_batch_stock'))return [{affectedRows:0}];
  if(q.startsWith('SELECT available_qty'))return [[{available_qty:state.stock}]];
  if(q.startsWith('UPDATE t_batch_stock SET available_qty=available_qty-')){assert.ok(state.stock>=p[0]);state.stock-=p[0];return [{affectedRows:1}];}
  if(q.startsWith('INSERT INTO t_order (')){const o={id:3,order_sn:p[0],user_id:p[1],pay_amount:p[16],request_id:p[17],request_hash:p[18]};state.existing.push(o);return [{insertId:3}];}
  if(q.startsWith('INSERT INTO t_order_item'))return [{insertId:3}];
  throw new Error('Unhandled SQL: '+q);
 }};
 return {state,conn};
}
const payment={trade_state:'SUCCESS',trade_type:'JSAPI',appid:'wx',mchid:'m',out_trade_no:'PXD1',transaction_id:'T1',payer:{openid:'buyer'},amount:{total:1200,payer_total:1200,currency:'CNY'}};
const provider={config:{appid:'wx',mchid:'m'}};
test('duplicate verified payment is booked once and does not make referral rewards spendable',async()=>{
 const {state,conn}=store();await recordPaid(conn,{...state.order},payment,provider);await recordPaid(conn,{...state.order},payment,provider);
 assert.equal(state.users[0].total_consume_amount,12);assert.equal(state.users[0].normal_points,100);assert.equal(state.users[1].red_packet_points,0);assert.equal(state.commissions.length,0);
 assert.equal(state.events.length,1);assert.equal(state.events[0][1],'ORDER_PAID');assert.equal(state.revision,1);
});
test('completion of unpaid, refunded or still-preparing orders is rejected',async()=>{
 for(const [status,payState] of [[10,'UNPAID'],[50,'REFUNDED'],[20,'PAID']]) {
 const {state,conn}=store();Object.assign(state.order,{order_status:status,payment_state:payState});db.withTransaction=fn=>fn(conn);
 await assert.rejects(()=>complete(1,{id:1,is_admin:0}));assert.equal(state.flows.length,0);
 }
});
test('valid delivery completion credits points and referral exactly once',async()=>{
 const {state,conn}=store();Object.assign(state.order,{order_status:30,payment_state:'PAID',paid_goods_amount:12});db.withTransaction=fn=>fn(conn);
 await complete(1,{id:1,is_admin:0});await complete(1,{id:1,is_admin:0});
 assert.equal(state.order.order_status,40);assert.equal(state.users[0].normal_points,112);assert.equal(state.users[1].red_packet_points,0.36);assert.equal(state.commissions.length,1);
 assert.equal(state.order.completion_source,'CUSTOMER');assert.equal(state.order.completed_by,1);
});
test('merchant delivery completion requires explicit customer confirmation and preserves evidence on retry',async()=>{
 const {state,conn}=store();Object.assign(state.order,{order_status:30,payment_state:'PAID',paid_goods_amount:12});db.withTransaction=fn=>fn(conn);
 for(const evidence of [undefined,{confirmed:false,note:'电话核实已收到'},{confirmed:'true',note:'电话核实已收到'},{confirmed:true,note:' '},{confirmed:true,note:'字'.repeat(256)}])await assert.rejects(()=>complete(1,{id:2,is_admin:1},undefined,evidence),/核实送达/);
 assert.equal(state.flows.length,0);
 await complete(1,{id:2,is_admin:1},undefined,{confirmed:true,note:'  电话核实顾客已收到  '});
 await complete(1,{id:2,is_admin:1},undefined,{confirmed:true,note:'重试不能覆盖凭据'});
 assert.equal(state.order.completion_source,'ADMIN_DELIVERY');assert.equal(state.order.completed_by,2);assert.equal(state.order.completion_note,'电话核实顾客已收到');
 assert.equal(state.users[0].normal_points,112);assert.equal(state.commissions.length,1);
});
test('pickup completion requires ready status, administrator and correct code',async()=>{
 const {state,conn}=store();Object.assign(state.order,{delivery_type:2,order_status:25,payment_state:'PAID',pickup_code:'1234',paid_goods_amount:0});db.withTransaction=fn=>fn(conn);
 await assert.rejects(()=>complete(1,{id:1,is_admin:0},'1234'));
 await assert.rejects(()=>complete(1,{id:2,is_admin:1},'9999'));
 await complete(1,{id:2,is_admin:1},'1234');assert.equal(state.order.order_status,40);
 assert.equal(state.order.completion_source,'ADMIN_PICKUP');assert.equal(state.order.completed_by,2);
});
test('inactive referrer receives no reward',async()=>{
 const {state,conn}=store();state.users[1].is_member=0;Object.assign(state.order,{order_status:30,payment_state:'PAID',paid_goods_amount:12});db.withTransaction=fn=>fn(conn);
 await complete(1,{id:1,is_admin:0});assert.equal(state.commissions.length,0);assert.equal(state.users[1].red_packet_points,0);
});
test('refund success restores reserved benefits and stock once',async()=>{
 const {state,conn}=store();Object.assign(state.order,{order_status:70,payment_state:'REFUNDING',transaction_id:'T1',used_normal_points:100,used_red_packet_points:5,paid_goods_amount:12});state.stock=0;state.users[0].normal_points=0;state.users[0].red_packet_points=2;state.users[0].total_consume_amount=12;
 const result={out_trade_no:'PXD1',out_refund_no:'RFPXD1',transaction_id:'T1',amount:{total:1200,refund:1200},status:'SUCCESS'};
 await recordRefund(conn,{...state.order},result,provider);await recordRefund(conn,{...state.order},result,provider);
 assert.equal(state.users[0].normal_points,100);assert.equal(state.users[0].red_packet_points,7);assert.equal(state.stock,1);assert.equal(state.users[0].total_consume_amount,0);assert.equal(state.flows.length,2);
});
test('late payment on a cancelled order is queued for refund without rebooking or double-releasing benefits',async()=>{
 const {state,conn}=store();Object.assign(state.order,{order_status:60,benefits_released:1,stock_reserved:0});
 await recordPaid(conn,{...state.order},payment,provider);
 assert.equal(state.order.order_status,70);assert.equal(state.order.payment_state,'REFUNDING');assert.equal(state.users[0].total_consume_amount,0);
 await releaseBenefits(conn,{...state.order});assert.equal(state.flows.length,0);assert.equal(state.stock,1);
});
test('free order creation is idempotent and reserves one stock and exact benefits',async()=>{
 const {state,conn}=store();db.withTransaction=fn=>fn(conn);
 const date=chinaDate(new Date(Date.now()+86400000));
 const body={request_id:'test_request_123456789',items:[{product_id:1,quantity:1}],delivery_type:2,receiver_name:'测试',receiver_phone:'13958001122',batch_date:date,batch_time:'16:30',use_normal_points:true,use_red_packet_points:true,custom_red_amount:'7.00',expected_pay_amount:'1.00'};
 // 50% red cap leaves 1 yuan; a zero-yuan order is achieved with a 10-yuan member price and 5+5 deductions.
 state.products[0].member_price=10;body.custom_red_amount='5.00';body.expected_pay_amount='0.00';
 const a=await create(1,body),b=await create(1,body);
 assert.equal(a.order_id,b.order_id);assert.equal(state.stock,0);assert.equal(state.capacity,1);assert.equal(state.existing.length,1);assert.equal(state.users[0].normal_points,0);assert.equal(state.users[0].red_packet_points,2);
 await assert.rejects(()=>create(1,{...body,receiver_name:'不同联系人'}),/请求号/);
});
test('payer cash preserves channel discounts and invalid refund cash is rejected before releasing benefits',async()=>{
 const {state,conn}=store();const discounted={...payment,amount:{...payment.amount,payer_total:900}};
 await recordPaid(conn,{...state.order},discounted,provider);assert.equal(state.order.payer_paid_amount,9);assert.equal(state.order.paid_goods_amount,9);
 Object.assign(state.order,{order_status:70,payment_state:'REFUNDING'});
 for(const payer_refund of [-1,901,1.5,'900'])await assert.rejects(()=>recordRefund(conn,{...state.order},{out_trade_no:'PXD1',out_refund_no:'RFPXD1',transaction_id:'T1',amount:{total:1200,refund:1200,payer_refund},status:'SUCCESS'},provider));
 assert.equal(state.order.benefits_released,0);assert.equal(state.flows.length,0);
 await recordRefund(conn,{...state.order},{out_trade_no:'PXD1',out_refund_no:'RFPXD1',transaction_id:'T1',amount:{total:1200,refund:1200,payer_refund:900},status:'SUCCESS'},provider);
 assert.equal(state.order.payer_refund_amount,9);
});
