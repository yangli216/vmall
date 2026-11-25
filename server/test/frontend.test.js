const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');
function loadPage(name,app,wx={},runtime={}) {
 let page;const storage=new Map();
 const wxApi={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k),showToast:()=>{},showLoading:()=>{},hideLoading:()=>{},switchTab:()=>{},...wx};
 const filename=path.join(__dirname,`../../miniprogram/pages/${name}/${name}.js`);
 const context=vm.createContext({getApp:()=>app,Page:p=>{page=p;},wx:wxApi,setTimeout,clearTimeout,clearInterval,setInterval,...runtime});
 function miniRequire(request,from=filename){
  if(request.endsWith('/payment'))return {payOrder:async()=>({confirmed:true}),sync:async()=>({})};
  const file=path.resolve(path.dirname(from),request)+'.js',module={exports:{}};
  vm.runInContext('(function(require,module,exports){'+fs.readFileSync(file,'utf8')+'\n})',context)(r=>miniRequire(r,file),module,module.exports);return module.exports;
 }
 context.require=miniRequire;vm.runInContext(fs.readFileSync(filename,'utf8'),context);
 page.setData=function(data,cb){for(const [key,value] of Object.entries(data)){const parts=key.replace(/\[(\d+)\]/g,'.$1').split('.');let target=this.data;for(const part of parts.slice(0,-1))target=target[part]||(target[part]={});target[parts[parts.length-1]]=value;}if(cb)cb();};return {page,storage};
}
test('order list retains every active order and preserves pagination cursor',async()=>{
 const {page}=loadPage('order',{callContainer:async()=>({code:0,data:[{id:3,order_status:10},{id:2,order_status:20},{id:1,order_status:25}],next_cursor:1})});
 await page.fetchOrders();assert.deepEqual(Array.from(page.data.orders,o=>o.id),[3,2,1]);assert.equal(page.data.nextCursor,1);
});
test('customer orders stop polling and ignore late list/config responses while hidden, then resume without duplicate timers',async()=>{
 const requests=[],configs=[],timers=new Map();let timerId=0;
 const {page}=loadPage('order',{callContainer:()=>new Promise(resolve=>requests.push(resolve)),api:()=>new Promise(resolve=>configs.push(resolve))},{},{setInterval:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearInterval:id=>timers.delete(id)});
 page.onShow();assert.equal(timers.size,2);page.onShow();assert.equal(timers.size,2);
 requests[1]({code:0,data:[{id:2,order_status:20}],next_cursor:null});configs[1]({DELIVERY_PERSON_PHONE:'new'});await new Promise(setImmediate);
 requests[0]({code:0,data:[{id:1,order_status:10}],next_cursor:1});configs[0]({DELIVERY_PERSON_PHONE:'old'});await new Promise(setImmediate);
 assert.equal(page.data.orders[0].id,2);assert.equal(page.data.phone,'new');
 const late=page.fetchOrders();page.onHide();assert.equal(timers.size,0);assert.equal(page.data.loading,false);
 requests[2]({code:0,data:[{id:99,order_status:10}],next_cursor:99});await late;assert.equal(page.data.orders[0].id,2);
 await page.fetchOrders();assert.equal(requests.length,3);
 page.onShow();assert.equal(timers.size,2);requests[3]({code:0,data:[{id:3,order_status:25}],next_cursor:null});configs[2]({DELIVERY_PERSON_PHONE:'current'});await new Promise(setImmediate);
 assert.equal(page.data.orders[0].id,3);page.onUnload();assert.equal(timers.size,0);
});
test('customer countdown expires from server time without locally cancelling orders or collapsing loaded history',async()=>{
 let elapsed=100,requests=0;const notices=[],server=Date.parse('2026-11-19T07:59:58Z');
 const first=Array.from({length:30},(_,i)=>({id:100-i,order_status:10,payment_state:'UNPAID',expires_at:'2026-11-19 16:00:00'}));
 const {page}=loadPage('order',{callContainer:async()=>{requests++;return {code:0,data:first,next_cursor:71,server_time:server};}},{getPerformance:()=>({now:()=>elapsed}),showToast:notice=>notices.push(notice)});
 await page.fetchOrders();assert.equal(page.data.paymentTimers[100].remaining,'0:02');
 // A silent refresh of a longer list must preserve its older page while updating the clock.
 page.data.orders.push({id:1,order_status:40,payment_state:'PAID'});await page.fetchOrders(true);assert.equal(page.data.orders.length,31);
 elapsed+=2000;page.updateCountdown();assert.equal(page.data.paymentTimers[100].expired,true);assert.equal(page.data.orders[0].order_status,10);assert.equal(page.data.orders[0].payment_state,'UNPAID');
 // An already-queued tap after the deadline cannot start another payment.
 await page.pay({currentTarget:{dataset:{id:100}}});assert.match(notices[0].title,/付款时限已到/);assert.equal(page.data.busyId,null);assert.equal(requests,3);
});
test('customer cancellation confirmation cannot submit twice, and a late reorder cannot replace a cart after leaving',async()=>{
 const dialogs=[],writes=[];let release,products;
 const {page,storage}=loadPage('order',{api:(path,method,body)=>{
  if(path==='/api/products')return new Promise(resolve=>products=resolve);
  writes.push(body);return new Promise(resolve=>release=resolve);
 },callContainer:async()=>({code:0,data:[],next_cursor:null})},{showModal:dialog=>dialogs.push(dialog)});
 page.data.orders=[{id:1,order_status:10,items:[{product_id:2,quantity:1}]}];
 page.cancel({currentTarget:{dataset:{id:1}}});page.cancel({currentTarget:{dataset:{id:1}}});
 const cancel=dialogs[0].success({confirm:true});await dialogs[1].success({confirm:true});assert.equal(writes.length,1);
 release({order_status:60});await cancel;
 page.data.orders=[{id:1,order_status:40,items:[{product_id:2,quantity:1}]}];
 await page.reorder({currentTarget:{dataset:{id:1}}});const reorder=dialogs[2].success({confirm:true});page.onHide();products([{id:2,status:1,stock_qty:5}]);await reorder;assert.equal(storage.has('pandou_cart'),false);
});
test('checkout ignores stale calculation responses and disables payment on latest failure',async()=>{
 const pending=[];const {page}=loadPage('index',{api:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))});
 page.data.slots=[{date:'2026-11-19',time:'16:30'}];page.data.cartList=[{id:1,quantity:1}];
 const old=page.calculateBill(),latest=page.calculateBill();pending[1].resolve({final_pay_amount:'12.00'});await latest;pending[0].resolve({final_pay_amount:'1.00'});await old;
 assert.equal(page.data.calcResult.final_pay_amount,'12.00');assert.equal(page.data.calcReady,true);
 const failed=page.calculateBill();assert.equal(page.data.calcReady,false);pending[2].reject(new Error('售罄'));await failed;assert.equal(page.data.calcReady,false);assert.equal(page.data.calcError,'售罄');
});
test('empty or failed menus do not turn into purchasable demo data',async()=>{
 const {page}=loadPage('index',{api:async()=>[]});await page.fetchProductList();assert.equal(page.data.allDishes.length,0);
 const failed=loadPage('index',{api:async()=>{throw new Error('断网');}}).page;await failed.fetchProductList();assert.equal(failed.data.allDishes.length,0);assert.equal(failed.data.calcReady,false);assert.equal(failed.data.productError,'断网');
});
test('changing batches invalidates pending prices and ignores stock responses for an older batch',async()=>{
 const requests=[];const {page}=loadPage('index',{api:path=>new Promise(resolve=>requests.push({path,resolve}))});
 page.data.slots=[{date:'2026-11-19',time:'16:30'},{date:'2026-11-20',time:'16:30'}];page.data.cartList=[{id:1,quantity:1}];
 const price=page.calculateBill(),oldStock=page.fetchProductList();page.data.slotIndex=1;const newStock=page.fetchProductList();
 requests[0].resolve({final_pay_amount:'1.00'});await price;assert.equal(page.data.calcReady,false);
 requests[2].resolve([{id:1,title:'新批',stock_qty:5,status:1}]);await newStock;
 requests[1].resolve([{id:1,title:'旧批',stock_qty:0,status:1}]);await oldStock;
 assert.equal(page.data.allDishes[0].title,'新批');assert.equal(page.data.allDishes[0].stock_qty,5);
});
test('an order submission freezes quantity, benefits and contact inputs until it completes',()=>{
 const {page}=loadPage('index',{});page.data.submitting=true;page.data.receiverName='原联系人';page.data.useNormalPoints=false;page.data.cartCount=1;
 page.onContactInput({currentTarget:{dataset:{field:'receiverName'}},detail:{value:'新联系人'}});
 page.toggleNormalPoints({detail:{value:true}});page.decreaseCart({currentTarget:{dataset:{dish:{id:1}}}});
 assert.equal(page.data.receiverName,'原联系人');assert.equal(page.data.useNormalPoints,false);assert.equal(page.data.cartCount,1);
});
test('editing a product preserves category, photo and default batch capacity',()=>{
 const {page}=loadPage('admin',{});page.openEditModal({currentTarget:{dataset:{dish:{id:2,title:'鸭翅',origin_price:20,member_price:18,category_id:3,cover_img:'https://example.com/a.jpg',stock_qty:2,default_stock_qty:10}}}});
 assert.equal(page.data.dishForm.category_id,3);assert.equal(page.data.dishForm.cover_img,'https://example.com/a.jpg');assert.equal(page.data.dishForm.stock_qty,10);
});
test('merchant settings require a successful read, retain failed drafts and retry the same revision while preventing duplicate saves',async()=>{
 const base={...require('../dist/services/config').DEFAULT_CONFIG},a='a'.repeat(64),b='b'.repeat(64),requests=[];let readFails=true,release;
 const {page}=loadPage('admin',{api:async(path,method,body)=>{
  requests.push({path,body});if(path==='/api/admin/config'){if(readFails)throw new Error('读取失败');return {configs:{...base},revision:a};}
  return new Promise((resolve,reject)=>release={resolve,reject});
 }});
 await page.saveAllConfigs();assert.equal(requests.length,0);await page.loadConfigs();assert.equal(page.data.configLoaded,false);assert.equal(page.data.configError,'读取失败');assert.throws(()=>page.applyConfigs({configs:{},revision:a}),/完整读取/);await page.saveAllConfigs();assert.equal(requests.length,1);
 readFails=false;await page.loadConfigs();assert.equal(page.data.configLoaded,true);
 page.onConfigInput({currentTarget:{dataset:{field:'WORKSHOP_ADDRESS'}},detail:{value:'新的自提门牌'}});page.onConfigInput({currentTarget:{dataset:{field:'MEMBER_ENTRY_THRESHOLD'}},detail:{value:'68'}});
 assert.equal(page.data.configDirty,true);await page.loadConfigs();assert.equal(requests.length,2);assert.equal(page.data.config.WORKSHOP_ADDRESS,'新的自提门牌');
 const save=page.saveAllConfigs();await page.saveAllConfigs();assert.equal(requests.length,3);assert.equal(page.data.configSaving,true);
 page.onConfigInput({currentTarget:{dataset:{field:'WORKSHOP_ADDRESS'}},detail:{value:'保存期间的旧输入'}});assert.equal(page.data.config.WORKSHOP_ADDRESS,'新的自提门牌');
 release.reject(new Error('响应丢失'));await save;assert.equal(page.data.configDirty,true);assert.equal(page.data.configSaving,false);assert.equal(page.data.config.WORKSHOP_ADDRESS,'新的自提门牌');
 const retry=page.saveAllConfigs();assert.equal(requests[3].body.expected_revision,requests[2].body.expected_revision);assert.equal(requests[3].body.configs.MEMBER_ENTRY_THRESHOLD,'68');assert.equal(requests[3].body.configs.DELIVERY_PERSON_NAME,base.DELIVERY_PERSON_NAME);assert.equal(requests[3].body.configs.ORDER_EXPIRE_MINUTES,'15');
 release.resolve({configs:{...base,WORKSHOP_ADDRESS:'新的自提门牌'},revision:b});await retry;assert.equal(page.data.configDirty,false);assert.equal(page._configRevision,b);assert.equal(requests.length,4);
});
test('settings ignore older reads and unload responses, and only discard a draft after explicit reload confirmation',async()=>{
 const pending=[],dialogs=[],base={...require('../dist/services/config').DEFAULT_CONFIG};
 const {page}=loadPage('admin',{api:()=>new Promise(resolve=>pending.push(resolve))},{showModal:dialog=>dialogs.push(dialog)});
 const older=page.loadConfigs(),latest=page.loadConfigs();pending[1]({configs:{...base,WORKSHOP_ADDRESS:'最新地址'},revision:'b'.repeat(64)});await latest;pending[0]({configs:{...base,WORKSHOP_ADDRESS:'旧地址'},revision:'a'.repeat(64)});await older;assert.equal(page.data.config.WORKSHOP_ADDRESS,'最新地址');
 page.onConfigInput({currentTarget:{dataset:{field:'WORKSHOP_ADDRESS'}},detail:{value:'尚未保存'}});
 const cancelled=page.reloadConfigs();dialogs[0].success({confirm:false});await cancelled;assert.equal(pending.length,2);assert.equal(page.data.config.WORKSHOP_ADDRESS,'尚未保存');
 const reload=page.reloadConfigs();dialogs[1].success({confirm:true});await new Promise(setImmediate);assert.equal(pending.length,3);
 page.onUnload();pending[2]({configs:base,revision:'c'.repeat(64)});await reload;assert.equal(page.data.config.WORKSHOP_ADDRESS,'尚未保存');
});
test('copying a pickup address uses the order snapshot and handles missing addresses and clipboard failure without false success',()=>{
 const copies=[],notices=[];
 const {page}=loadPage('order',{}, {setClipboardData:options=>copies.push(options),showToast:notice=>notices.push(notice)});
 page.data.config={WORKSHOP_ADDRESS:'新门店地址'};page.data.orders=[{id:1,delivery_type:2,receiver_address:'旧订单取餐地址'},{id:2,delivery_type:1,receiver_address:'私人配送地址'},{id:3,delivery_type:2,receiver_address:''}];
 page.copyPickupAddress({currentTarget:{dataset:{id:1}}});assert.equal(copies[0].data,'旧订单取餐地址');page.copyPickupAddress({currentTarget:{dataset:{id:2}}});assert.equal(copies.length,1);
 copies[0].fail();assert.match(notices[0].title,/复制失败/);page.copyPickupAddress({currentTarget:{dataset:{id:3}}});assert.equal(copies.length,1);assert.match(notices[1].title,/暂未提供/);
});
test('member search ignores stale responses and loads later pages without replacing the first page',async()=>{
 const requests=[];const {page}=loadPage('admin',{api:path=>new Promise(resolve=>requests.push({path,resolve}))});
 page.data.memberKeyword='旧搜索';const old=page.loadMembers();page.data.memberKeyword='新搜索';const current=page.loadMembers();
 requests[1].resolve({list:[{id:5}],total:2,next_cursor:5,summary:{total_users:10}});await current;
 requests[0].resolve({list:[{id:99}],total:1,next_cursor:null,summary:{}});await old;
 assert.deepEqual(Array.from(page.data.members,u=>u.id),[5]);assert.equal(page.data.memberTotal,2);
 const more=page.loadMembers(undefined,true);assert.match(requests[2].path,/before_id=5/);
 requests[2].resolve({list:[{id:4}],total:2,next_cursor:null,summary:{total_users:10}});await more;
 assert.deepEqual(Array.from(page.data.members,u=>u.id),[5,4]);assert.equal(page.data.memberNextCursor,null);
});
test('referral pagination preserves totals, clamps changed benefit rules and reports failures without inventing empty records',async()=>{
 let broken=false;
 const {page}=loadPage('promote',{api:async path=>{
  if(broken)throw new Error('暂时断网');
  if(path==='/api/user/info')return {invite_code:'PXD-ONE',is_member:1};
  if(path==='/api/config/all')return {COMMISSION_RATE:'0.03',RED_PACKET_MAX_DEDUCT_RATIO:'0.10'};
  return {list:[{id:path.includes('before_id')?4:5}],next_cursor:path.includes('before_id')?null:5,summary:{total_referred:2}};
 }});
 await page.loadReferrals();assert.equal(page.data.summary.total_referred,2);assert.equal(page.data.simRedDeduct,10);assert.equal(page.data.simEarnCommission,'2.70');
 await page.loadReferrals(undefined,true);assert.deepEqual(Array.from(page.data.referrals,u=>u.id),[5,4]);
 broken=true;await page.loadReferrals();assert.equal(page.data.error,'暂时断网');assert.equal(page.data.referrals.length,2);
});
test('builds without an explicitly configured cloud target cannot silently call production',async()=>{
 const actualRuntime=require('../../miniprogram/config/runtime');
 assert.equal(actualRuntime.selectRuntime('unknown-build').cloudEnvId,'');
 const runtime={selectRuntime:version=>({runtimeVersion:version,cloudEnvId:version==='release'?'explicit-release-env':'',serviceName:'pandou',allowLocalDev:false})};
 for(const version of ['develop','trial','release','']) {
  let app,cloudCalls=0,cloudInits=0,localCalls=0,stored=0;
  const wx={getAccountInfoSync:()=>({miniProgram:{envVersion:version}}),
   cloud:{init:()=>{cloudInits++;},callContainer:options=>{cloudCalls++;options.success({data:{code:0,data:[]}});}},
   request:()=>{localCalls++;},getStorageSync:()=>'',setStorageSync:()=>{stored++;}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../miniprogram/app.js'),'utf8'),{App:value=>{app=value;},wx,require:name=>name==='./config/runtime'?runtime:{captureReferral:()=>{}},console});
  app.onLaunch();
  if(version==='release'){await app.api('/api/products');assert.equal(cloudCalls,1);assert.equal(cloudInits,1);}
  else {await assert.rejects(()=>app.api('/api/products'),/服务暂未开放/);assert.equal(cloudCalls,0);assert.equal(cloudInits,0);}
  assert.equal(localCalls,0);assert.equal(stored,0);assert.equal(app.globalData.allowLocalDev,false);
 }
});
test('local identity switching clears cached identity and referral intent, while normal builds cannot switch',async()=>{
 const routes=[],navigations=[],app={globalData:{allowLocalDev:true,runtimeVersion:'develop',devOpenid:'wx_dev_local_customer',userInfo:{id:1}},
  api:async url=>{routes.push(url);return {accounts:[{openid:'wx_dev_local_member',label:'测试会员'}]};}};
 const {page,storage}=loadPage('member',app,{reLaunch:options=>navigations.push(options.url)});
 const event={currentTarget:{dataset:{openid:'wx_dev_local_member'}}};
 await page.switchTestAccount(event);assert.equal(routes.length,0);
 page.data.localDevelopment=true;storage.set('pandou_pending_referrer','old-referral');
 await page.switchTestAccount(event);
 assert.equal(app.globalData.devOpenid,'wx_dev_local_member');assert.equal(app.globalData.userInfo,null);
 assert.equal(storage.get('pandou_local_user_openid'),'wx_dev_local_member');assert.equal(storage.has('pandou_pending_referrer'),false);
 assert.deepEqual(navigations,['/pages/member/member']);
});
test('a lost adjustment response retains the same request id for a safe retry',async()=>{
 const requests=[];let first=true;
 const {page,storage}=loadPage('admin',{api:async(path,method,body)=>{
  if(path==='/api/admin/member/adjust-points'){requests.push(body);if(first){first=false;throw new Error('响应丢失');}return {};}
  return {list:[],total:0,summary:{},next_cursor:null};
 }});
 page.data.currentMember={id:7};page.data.pointsForm={adjust_type:'NORMAL_POINT',amount:'5',reason:'测试调整'};
 await page.submitAdjustPoints();assert.equal(page.data.showPointsModal,false);assert.ok(storage.has('pandou_pending_adjustment'));
 await page.submitAdjustPoints();assert.equal(requests.length,2);assert.equal(requests[0].request_id,requests[1].request_id);assert.equal(storage.has('pandou_pending_adjustment'),false);
});
test('support submissions preserve a retry key after a lost response and show active handling progress',async()=>{
 const requests=[];let first=true;
 const {page,storage}=loadPage('support',{api:async(path,method,body)=>{
  if(path==='/api/support/create'){requests.push(body);if(first){first=false;throw new Error('响应丢失');}return {id:1};}
  return {list:[{id:1,category:'QUALITY',status:'OPEN'}],next_cursor:null};
 }});
 page.data.orderId=3;page.data.order={order_sn:'test'};page.data.description='包装破损，需要掌柜协助';
 await page.submit();assert.ok(storage.has('pandou_pending_support'));assert.equal(page.data.description,'包装破损，需要掌柜协助');
 await page.submit();assert.equal(requests.length,2);assert.equal(requests[0].request_id,requests[1].request_id);assert.equal(page.data.hasActive,true);assert.equal(page.data.rows[0].status_title,'待掌柜处理');assert.equal(storage.has('pandou_pending_support'),false);
 await page.submit();assert.equal(requests.length,2);
});
test('after-sales refund requires a reason and amount confirmation and blocks duplicate taps',async()=>{
 const modals=[],requests=[],toasts=[];let resolveRefund;
 const {page}=loadPage('admin',{
  api:async(path,method,body)=>{if(path==='/api/admin/order/refund'){requests.push(body);return new Promise(resolve=>{resolveRefund=resolve;});}return [];},
  callContainer:async()=>({code:0,data:[],next_cursor:null})
 },{showModal:options=>modals.push(options),showToast:options=>toasts.push(options.title)});
 page.data.pendingOrders=[{id:7,order_sn:'PXD-REFUND',final_pay_amount:'12.00'}];
 const event={currentTarget:{dataset:{id:7}}};
 page.refundShopOrder(event);page.refundShopOrder(event);assert.equal(modals.length,1);assert.equal(requests.length,0);
 modals[0].success({confirm:true,content:'质量问题已协商'});assert.equal(modals.length,2);assert.match(modals[1].content,/12.00/);assert.equal(requests.length,0);
 const submitted=modals[1].success({confirm:true});page.refundShopOrder(event);assert.equal(requests.length,1);assert.equal(requests[0].reason,'质量问题已协商');
 resolveRefund({payment_state:'REFUNDING'});await submitted;
 assert.ok(toasts.includes('退款处理中'));assert.equal(toasts.includes('已确认退款'),false);assert.equal(page.data.refundBusyId,null);
 page.refundShopOrder(event);assert.equal(modals.length,2); // Refreshed list no longer contains a refundable order.
});
test('merchant orders ignore stale batch responses, prevent duplicate pagination and retain rows when summaries fail',async()=>{
 const calls=[];
 const request=path=>new Promise((resolve,reject)=>calls.push({path,resolve,reject}));
 const {page}=loadPage('admin',{api:request,callContainer:({path})=>request(path)});
 page.data.orderDate='2026-11-19';const old=page.loadPendingOrders();
 page.data.orderDate='2026-11-20';page.data.orderFilterIndex=2;page.data.orderDeliveryIndex=2;const current=page.loadPendingOrders();
 assert.match(calls[3].path,/batch_date=2026-11-20/);assert.match(calls[3].path,/status=20/);assert.match(calls[3].path,/delivery_type=2/);
 calls[3].resolve({code:0,data:[{id:22,order_status:20}],next_cursor:22});calls[4].resolve([{product_id:2,quantity:3}]);calls[5].resolve({used_orders:2,max_orders:10});await current;
 calls[0].resolve({code:0,data:[{id:11,order_status:20}],next_cursor:null});calls[1].resolve([{product_id:1,quantity:9}]);calls[2].resolve({used_orders:9,max_orders:10});await old;
 assert.deepEqual(Array.from(page.data.pendingOrders,o=>o.id),[22]);assert.equal(page.data.prepSummary[0].product_id,2);assert.equal(page.data.batchCapacity.used_orders,2);
 const more=page.loadPendingOrders(true);await page.loadPendingOrders(true);assert.equal(calls.length,9);assert.match(calls[6].path,/before_id=22/);
 calls[6].resolve({code:0,data:[{id:21,order_status:20}],next_cursor:null});calls[7].reject(new Error('备餐汇总断网'));calls[8].reject(new Error('接单名额断网'));await more;
 assert.deepEqual(Array.from(page.data.pendingOrders,o=>o.id),[22,21]);assert.equal(page.data.orderError,'');assert.equal(page.data.prepError,'备餐汇总断网');assert.equal(page.data.capacityError,'接单名额断网');assert.equal(page.data.orderLoading,false);
});
test('foreground activity never overlaps requests, ignores hidden responses and resumes from the last accepted cursor',async()=>{
 const requests=[],timers=new Map();let timerId=0;
 const {page}=loadPage('admin',{api:path=>new Promise((resolve,reject)=>requests.push({path,resolve,reject}))},{},{setTimeout:(fn,delay)=>{timers.set(++timerId,{fn,delay});return timerId;},clearTimeout:id=>timers.delete(id)});
 const flush=()=>new Promise(setImmediate);
 const tick=()=>{const [id,timer]=timers.entries().next().value;timers.delete(id);timer.fn();return timer.delay;};
 page.onShow();assert.equal(requests.length,0);
 page._adminAuthorized=true;page.refreshActivity();page.refreshActivity();assert.equal(requests.length,1);
 page.onHide();page.onShow();assert.equal(requests.length,1);
 requests[0].resolve({cursor:5,events:[{kind:'ORDER_PAID'}],queues:{to_prepare:1}});await flush();
 assert.equal(page.data.activityQueues,null);assert.equal(page._activityCursor,undefined);assert.equal(tick(),0);
 requests[1].resolve({cursor:10,events:[],queues:{to_prepare:2},checked_at:'now'});await flush();
 assert.equal(page._activityCursor,10);assert.equal(page.data.newPaidCount,0);assert.equal(tick(),15000);assert.match(requests[2].path,/after_revision=10/);
 requests[2].resolve({cursor:11,has_more:true,events:[{kind:'ORDER_PAID'},{kind:'SUPPORT_OPENED'}],queues:{to_prepare:3},checked_at:'now'});await flush();
 assert.equal(page.data.newPaidCount,1);assert.equal(page.data.newSupportCount,1);assert.equal(tick(),0);
 requests[3].reject(new Error('网络中断'));await flush();assert.equal(page._activityCursor,11);assert.equal(page.data.activityError,'网络中断');assert.equal(page.data.activityQueues.to_prepare,3);
 assert.equal(tick(),15000);requests[4].resolve({cursor:1,reset:true,events:[],queues:{to_prepare:0}});await flush();assert.equal(page.data.newPaidCount,0);assert.equal(page.data.newSupportCount,0);
 page.onHide();assert.equal(timers.size,0);page.onUnload();assert.equal(page._adminAuthorized,false);
});
test('merchant delivery and pickup dialogs name the order, require evidence and block duplicate completion',async()=>{
 const modals=[],requests=[];let release;
 const {page}=loadPage('admin',{api:async(path,method,body)=>{requests.push({path,body});await new Promise(resolve=>{release=resolve;});}},{showModal:options=>modals.push(options)});
 page.loadPendingOrders=async()=>{};
 page.data.pendingOrders=[{id:3,order_sn:'PXD-COMPLETE',receiver_name:'张女士',receiver_phone:'13958001122'}];
 const event={currentTarget:{dataset:{id:3}}};
 page.confirmDelivery(event);page.confirmDelivery(event);assert.equal(modals.length,1);assert.match(modals[0].content,/张女士/);assert.equal(requests.length,0);
 modals[0].success({confirm:true,content:' '});assert.equal(page.data.completionBusyId,null);assert.equal(requests.length,0);
 page.confirmDelivery(event);const done=modals[1].success({confirm:true,content:' 电话联系顾客确认收到 '});page.verifyPickup(event);assert.equal(modals.length,2);
 assert.equal(requests[0].body.delivery_confirmed,true);assert.equal(requests[0].body.confirmation_note,'电话联系顾客确认收到');release();await done;
 page.verifyPickup(event);assert.match(modals[2].content,/PXD-COMPLETE/);assert.match(modals[2].content,/13958001122/);
 modals[2].success({confirm:true,content:'wrong'});assert.equal(requests.length,1);assert.equal(page.data.completionBusyId,null);
 page.verifyPickup(event);const pickup=modals[3].success({confirm:true,content:'1234'});assert.equal(requests[1].body.pickup_code,'1234');release();await pickup;assert.equal(page.data.completionBusyId,null);
});
test('all-date overdue queues omit per-batch summaries and a date selection restores batch mode',async()=>{
 const calls=[];const {page}=loadPage('admin',{callContainer:async({path})=>{calls.push(path);return {code:0,data:[],next_cursor:null};},api:async path=>{calls.push(path);return [];}});
 page.openActivityQueue({currentTarget:{dataset:{kind:'overdue'}}});await new Promise(setImmediate);
 assert.equal(calls.length,1);assert.match(calls[0],/overdue_pickup=1/);assert.doesNotMatch(calls[0],/batch_date/);assert.equal(page.data.allOrderDates,true);assert.equal(page.data.batchCapacity,null);
 page.changeOrderDate({detail:{value:'2026-11-20'}});await new Promise(setImmediate);
 assert.equal(page.data.allOrderDates,false);assert.equal(page.data.overduePickupOnly,false);assert.match(calls[1],/batch_date=2026-11-20/);assert.ok(calls.some(p=>p.includes('/preparation?')));
 page.data.allOrderDates=true;page.data.overduePickupOnly=true;page.showSelectedDate();await new Promise(setImmediate);assert.equal(page.data.allOrderDates,false);assert.equal(page.data.overduePickupOnly,false);
});
test('referral intake parses shared links and QR scenes, rejects malformed input and supports hot launches',()=>{
 const {referralFrom}=require('../../miniprogram/utils/referral');
 for(const options of [{referrer:'PXD-ABC'},{scene:'ref%3DPXD-ABC'},{scene:'PXD-ABC'}])assert.equal(referralFrom(options),'PXD-ABC');
 for(const options of [{scene:'%BAD'},{scene:'ref=PXD-ABC&other=1'},{referrer:'../bad'},{referrer:'x'.repeat(33)},{referrer:1},null])assert.equal(referralFrom(options),'');
 const {page,storage}=loadPage('index',{});page.onLoad({scene:'ref%3DPXD-ABC'});assert.equal(storage.get('pandou_pending_referrer'),'PXD-ABC');
 page.onLoad({scene:'bad%ZZ'});assert.equal(storage.get('pandou_pending_referrer'),'PXD-ABC');
 let app;const saved=[];
 const capture=options=>{const code=referralFrom(options);if(code)saved.push(code);};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../miniprogram/app.js'),'utf8'),{App:v=>{app=v;},require:name=>name==='./config/runtime'?{}:{captureReferral:capture}});
 app.onShow({query:{scene:'ref%3DPXD-HOT'}});assert.deepEqual(saved,['PXD-HOT']);
});
test('poster generation wires canvas export, deduplicates taps and reports album success only after the save callback',async()=>{
 const requests=[],saved=[],toasts=[],modals=[],files=[],unlinked=[],draws=[];let release,settings=0;
 const canvas={getContext:()=>({fillRect:()=>{},fillText:(...args)=>draws.push(args),drawImage:()=>draws.push('code')}),createImage:()=>{const img={};Object.defineProperty(img,'src',{set:()=>queueMicrotask(()=>img.onload())});return img;}};
 const query={in(){return this;},select(){return this;},fields(){return this;},exec(callback){callback([{node:canvas}]);}};
 const {page}=loadPage('promote',{globalData:{runtimeVersion:'trial'},api:(path,method,body)=>{requests.push({path,body});return new Promise(resolve=>{release=resolve;});}},{
  env:{USER_DATA_PATH:'/local-test'},createSelectorQuery:()=>query,
  getFileSystemManager:()=>({writeFile:options=>{files.push(options);options.success();},unlink:options=>{unlinked.push(options.filePath);}}),
  canvasToTempFilePath:options=>options.success({tempFilePath:'/temp/exported-poster.png'}),saveImageToPhotosAlbum:options=>saved.push(options),showToast:options=>toasts.push(options.title),showModal:options=>modals.push(options),openSetting:()=>{settings++;}
 });
 page.data.isMember=true;page.data.myReferralCode='PXD-TEST';
 const generating=page.generatePoster();await page.generatePoster();assert.equal(requests.length,1);assert.equal(requests[0].path,'/api/referral/code');assert.equal(requests[0].body.version,'trial');assert.equal(requests[0].body.invite_code,undefined);
 release({invite_code:'PXD-TEST',version:'trial',mime:'image/png',base64:'dGVzdA=='});await generating;
 assert.equal(page.data.posterPath,'/temp/exported-poster.png');assert.equal(page.data.posterGenerating,false);assert.equal(files.length,1);assert.equal(unlinked[0],files[0].filePath);assert.equal(canvas.width,750);assert.equal(canvas.height,1160);
 assert.ok(draws.some(row=>Array.isArray(row)&&/体验版/.test(row[0])));assert.ok(draws.includes('code'));
 page.savePoster();page.savePoster();assert.equal(saved.length,1);assert.equal(toasts.length,0);assert.equal(saved[0].filePath,page.data.posterPath);
 saved[0].fail({errMsg:'saveImageToPhotosAlbum:fail auth deny'});saved[0].complete();assert.equal(toasts.length,0);modals[0].success({confirm:true});assert.equal(settings,1);
 page.savePoster();saved[1].success();saved[1].complete();assert.deepEqual(toasts,['海报已保存到相册']);assert.equal(page.data.posterSaving,false);
 page.savePoster();saved[2].fail({errMsg:'saveImageToPhotosAlbum:fail cancel'});saved[2].complete();assert.equal(toasts[toasts.length-1],'已取消保存');
 assert.equal(page.onShareAppMessage().path,'/pages/index/index?referrer=PXD-TEST');page.data.isMember=false;assert.equal(page.onShareTimeline().query,'');
});
test('poster failures preserve a retry action, while unloading discards late image responses',async()=>{
 let release,calls=0;
 const {page}=loadPage('promote',{globalData:{runtimeVersion:'release'},api:()=>new Promise(resolve=>{release=resolve;})},{createSelectorQuery:()=>{calls++;throw new Error('should not render');}});
 page.data.isMember=true;page.data.myReferralCode='PXD-TEST';
 const bad=page.generatePoster();release({invite_code:'PXD-OTHER',version:'release',mime:'image/png',base64:'dGVzdA=='});await bad;
 assert.match(page.data.posterError,/邀请信息已变化/);assert.equal(page.data.posterPath,'');assert.equal(page.data.posterGenerating,false);assert.equal(calls,0);
 const late=page.generatePoster();page.onUnload();release({invite_code:'PXD-TEST',version:'release',mime:'image/png',base64:'dGVzdA=='});await late;assert.equal(calls,0);assert.equal(page.data.posterPath,'');
});
function realSetData(page){page.setData=function(patch){for(const [key,value] of Object.entries(patch)){const parts=key.split('.');let obj=this.data;while(parts.length>1)obj=obj[parts.shift()];obj[parts[0]]=value;}};}
test('product photos retain the old cover on failure, reuse upload ids and ignore responses from a closed form',async()=>{
 const pending=[],saves=[],toasts=[];
 const {page}=loadPage('admin',{api:(...args)=>new Promise((resolve,reject)=>pending.push({args,resolve,reject})),callContainer:args=>new Promise(resolve=>saves.push({args,resolve}))},{showToast:e=>toasts.push(e.title)});realSetData(page);
 const edit=()=>page.openEditModal({currentTarget:{dataset:{dish:{id:2,title:'鸭翅',origin_price:20,member_price:18,category_id:3,cover_img:'https://example.com/old.jpg',stock_qty:10}}}});edit();
 page._pendingPhoto={request_id:'photo_retry_same_id',base64:'fixture',path:'local-photo'};page.setData({photoPreview:'local-photo'});
 const first=page.uploadDishPhoto();page.submitDishForm();assert.equal(saves.length,0);page.uploadDishPhoto();assert.equal(pending.length,1);
 pending[0].reject(new Error('断网'));await first;assert.equal(page.data.dishForm.cover_img,'https://example.com/old.jpg');assert.equal(page.data.photoError,'断网');page.submitDishForm();assert.equal(saves.length,0);
 const retry=page.uploadDishPhoto();assert.equal(pending[0].args[2].request_id,pending[1].args[2].request_id);pending[1].resolve({file_id:'cloud://test.bucket/products/one.jpg'});await retry;
 assert.equal(page.data.dishForm.cover_img,'cloud://test.bucket/products/one.jpg');assert.equal(page._pendingPhoto,null);
 page._pendingPhoto={request_id:'photo_old_form_id',base64:'fixture'};const stale=page.uploadDishPhoto();page.closeAddModal();page.openAddModal();
 pending[2].resolve({file_id:'cloud://test.bucket/products/wrong.jpg'});await stale;assert.equal(page.data.dishForm.cover_img,'');
 edit();page.loadDishes=()=>{};page.submitDishForm();page.submitDishForm();page.closeAddModal();page.onInputFormTitle({detail:{value:'错误修改'}});
 assert.equal(saves.length,1);assert.equal(page.data.showAddModal,true);assert.equal(page.data.dishForm.title,'鸭翅');
 saves[0].resolve({code:0});await new Promise(r=>setImmediate(r));assert.equal(page.data.showAddModal,false);assert.equal(page.data.dishSaving,false);
});
test('photo selection bounds compression attempts and blocks oversized files before base64 allocation',async()=>{
 let reads=0,selected=0;const compressions=[];
 const {page}=loadPage('admin',{api:async()=>{throw new Error('云存储未配置');}},{
  chooseMedia:o=>{selected++;o.success({tempFiles:[{tempFilePath:'camera.jpg'}]});},getImageInfo:o=>o.success({width:4000,height:2000}),
  compressImage:o=>{compressions.push(o);o.success({tempFilePath:'small.jpg'});},
  getFileSystemManager:()=>({stat:o=>o.success({stats:{size:3*1024*1024}}),readFile:()=>{reads++;}})
 });realSetData(page);page.openAddModal();await page.chooseDishPhoto();assert.equal(reads,0);assert.equal(compressions[0].compressedWidth,1600);assert.equal(compressions[0].compressedHeight,800);assert.equal(compressions.length,4);assert.match(page.data.photoError,/64KB/);assert.equal(page.data.photoBusy,false);assert.equal(selected,1);
});
test('photo uploads compress to fit the cloud gateway budget before encoding and sending',async()=>{
 const attempts=[],uploads=[];let reads=0;
 const {page}=loadPage('admin',{api:async(path,method,body)=>{uploads.push({path,method,body});return {file_id:'cloud://test.bucket/products/photo.jpg'};}},{
  chooseMedia:o=>o.success({tempFiles:[{tempFilePath:'original.jpg'}]}),getImageInfo:o=>o.success({width:4000,height:2000}),
  compressImage:o=>{attempts.push(o);o.success({tempFilePath:'candidate-'+attempts.length+'.jpg'});},
  getFileSystemManager:()=>({stat:o=>o.success({stats:{size:attempts.length===1?150*1024:64*1024}}),readFile:o=>{reads++;assert.equal(o.filePath,'candidate-2.jpg');o.success({data:Buffer.alloc(64*1024).toString('base64')});}})
 });realSetData(page);page.openAddModal();await page.chooseDishPhoto();
 assert.equal(attempts.length,2);assert.ok(attempts.every(o=>o.src==='original.jpg'));assert.equal(reads,1);assert.equal(uploads.length,1);
 assert.ok(Buffer.byteLength(JSON.stringify(uploads[0].body))<90*1024);assert.equal(page.data.photoError,'');assert.match(page.data.dishForm.cover_img,/^cloud:\/\//);
});
test('privacy requests keep a lost-response id, show reviewed progress and discard responses after leaving',async()=>{
 const requests=[],toasts=[];
 const {page}=loadPage('privacy',{api:(...args)=>new Promise((resolve,reject)=>requests.push({args,resolve,reject}))},{showToast:e=>toasts.push(e.title)});page._alive=true;
 page.data.description='请核对后处理账号注销';page.data.kindIndex=3;page.data.reviewConfirmed=true;
 const first=page.submitRequest();page.submitRequest();assert.equal(requests.length,1);assert.equal(requests[0].args[2].kind,'CLOSE_ACCOUNT');
 page.editDescription({detail:{value:'提交期间不变'}});assert.equal(page.data.description,'请核对后处理账号注销');
 requests[0].reject(new Error('断网'));await first;assert.equal(page.data.description,'请核对后处理账号注销');assert.equal(page.data.hasActive,false);
 const retry=page.submitRequest();assert.equal(requests[1].args[2].request_id,requests[0].args[2].request_id);requests[1].resolve({id:7});await new Promise(r=>setImmediate(r));
 assert.equal(page.data.hasActive,true);assert.ok(toasts.includes('申请已提交，待核实处理'));
 requests[2].resolve({list:[{id:7,kind:'CLOSE_ACCOUNT',description:'请核对后处理账号注销',status:'OPEN'}],next_cursor:null});await retry;
 assert.equal(page.data.rows[0].status_title,'待掌柜处理');assert.equal(page.data.rows[0].kind_title,'申请注销账号');
 const late=page.loadRequests();page.onUnload();requests[3].resolve({list:[{id:99,status:'RESOLVED'}],next_cursor:null});await late;assert.equal(page.data.rows[0].id,7);
});
test('clearing saved contacts invalidates the existing menu memory and only removes local contact caches',()=>{
 const shared=new Map([['pandou_contact',{receiverName:'旧联系人',receiverPhone:'13958001122',destAddress:'旧地址',deliveryArea:'小区'}],['pandou_pending_checkout',{fingerprint:'含地址的旧结算'}],['pandou_cart',{1:2}],['pandou_user_openid','local-test-user']]);let modal;
 const storage={getStorageSync:k=>shared.get(k),setStorageSync:(k,v)=>shared.set(k,v),removeStorageSync:k=>shared.delete(k)};
 const {page:menu}=loadPage('index',{},storage);menu.onLoad({});menu.data.calcReady=true;assert.equal(menu.data.receiverName,'旧联系人');
 const {page}=loadPage('privacy',{},Object.assign({showModal:o=>{modal=o;}},storage));page._alive=true;page.clearContact();modal.success({confirm:false});assert.ok(shared.has('pandou_contact'));
 page.clearContact();modal.success({confirm:true});assert.equal(shared.has('pandou_contact'),false);assert.equal(shared.has('pandou_pending_checkout'),false);assert.ok(shared.has('pandou_cart'));assert.equal(shared.get('pandou_user_openid'),'local-test-user');
 menu.syncSavedContact();assert.equal(menu.data.receiverName,'');assert.equal(menu.data.receiverPhone,'');assert.equal(menu.data.destAddress,'');assert.equal(menu.data.calcReady,false);assert.equal(menu.requestId,null);
});
test('privacy profile clearing and merchant replies need explicit confirmation and preserve unrelated state',async()=>{
 const calls=[],modals=[];
 const {page}=loadPage('privacy',{api:async(...args)=>{calls.push(args);return {};}},{showModal:o=>modals.push(o)});page._alive=true;page.data.user={nickname:'原昵称',phone:'13958001122',is_member:1,normal_points:12,red_packet_points:'3.00'};
 page.clearProfile();page.clearProfile();assert.equal(modals.length,1);modals[0].success({confirm:false});assert.equal(calls.length,0);assert.equal(page.data.profileBusy,false);
 page.clearProfile();await modals[1].success({confirm:true});assert.equal(calls[0][0],'/api/user/clear-profile');assert.equal(page.data.user.phone,'');assert.equal(page.data.user.is_member,1);assert.equal(page.data.user.normal_points,12);
 const adminCalls=[],dialogs=[];
 const adminPage=loadPage('admin',{api:(...args)=>{adminCalls.push(args);return Promise.resolve({});}},{showModal:o=>dialogs.push(o)}).page;
 adminPage.data.privacyRequests=[{id:8,status:'OPEN',kind:'CLOSE_ACCOUNT'}];adminPage.loadPrivacyRequests=async()=>{};
 adminPage.replyPrivacyRequest({currentTarget:{dataset:{id:8}}});adminPage.replyPrivacyRequest({currentTarget:{dataset:{id:8}}});assert.equal(dialogs.length,1);
 dialogs[0].success({confirm:true,content:'尚未注销，先核对交易及权益'});assert.equal(adminCalls.length,0);assert.equal(dialogs.length,2);
 await dialogs[1].success({confirm:true});assert.equal(adminCalls[0][0],'/api/admin/privacy/handle');assert.equal(adminCalls[0][2].confirm_actual_result,true);assert.equal(adminCalls[0][2].status,'RESOLVED');assert.equal(adminPage.data.privacyBusyId,null);
});
test('report dates and detail types ignore stale results, preserve failed pagination and stop updates after unload',async()=>{
 const pending=[];const {page}=loadPage('report',{api:path=>new Promise((resolve,reject)=>pending.push({path,resolve,reject}))});page._alive=true;page.data.date='2026-03-31';
 const old=page.refresh();page.data.date='2026-04-01';const current=page.refresh();
 pending[2].resolve({date:'2026-04-01',cash:{payer_net:null},benefits:[]});pending[3].resolve({list:[{id:7}],next_cursor:7});await current;
 pending[0].resolve({date:'2026-03-31',cash:{payer_net:'0.00'},benefits:[]});pending[1].resolve({list:[{id:99}],next_cursor:null});await old;
 assert.equal(page.data.summary.date,'2026-04-01');assert.equal(page.data.summary.cash.payer_net,null);assert.equal(page.data.rows[0].id,7);
 const more=page.loadDetails(true);page.loadDetails(true);assert.equal(pending.length,5);pending[4].reject(new Error('分页断网'));await more;assert.equal(page.data.rows[0].id,7);assert.equal(page.data.nextCursor,7);
 const stale=page.loadDetails();page.changeKind({currentTarget:{dataset:{kind:'REFUND'}}});pending[6].resolve({list:[{id:6}],next_cursor:null});await new Promise(r=>setImmediate(r));pending[5].resolve({list:[{id:8}],next_cursor:8});await stale;
 assert.equal(page.data.rows[0].id,6);assert.equal(page.data.nextCursor,null);
 const late=page.loadSummary();page.onUnload();pending[7].resolve({date:'wrong',benefits:[]});await late;assert.equal(page.data.summary.date,'2026-04-01');
});
test('member recommendations support sharing to WeChat friends and timeline with referral code',()=>{
 const toasts=[],copied=[];
 const {page}=loadPage('member',{},{showToast:o=>toasts.push(o.title),setClipboardData:o=>{copied.push(o.data);o.success();}});
 page.data.isMember=true;page.data.userInfo={invite_code:'VIP888'};
 assert.equal(page.onShareAppMessage().path,'/pages/index/index?referrer=VIP888');
 assert.equal(page.onShareTimeline().query,'referrer=VIP888');
 page.copyReferralCode();assert.deepEqual(copied,['VIP888']);assert.ok(toasts.includes('邀请码已复制'));
 page.showTimelineGuide();assert.equal(page.data.showTimelineGuide,true);
 page.closeTimelineGuide();assert.equal(page.data.showTimelineGuide,false);
 page.data.isMember=false;page.data.userInfo={invite_code:''};
 assert.equal(page.onShareAppMessage().path,'/pages/index/index');
 assert.equal(page.onShareTimeline().query,'');
});
test('index page attaches member referral code to onShareAppMessage and onShareTimeline',()=>{
 const {page}=loadPage('index',{});
 page.data.isMember=true;page.data.myReferralCode='REF123';
 assert.equal(page.onShareAppMessage().path,'/pages/index/index?referrer=REF123');
 assert.equal(page.onShareTimeline().query,'referrer=REF123');
 page.data.isMember=false;page.data.myReferralCode='REF123';
 assert.equal(page.onShareAppMessage().path,'/pages/index/index');
 assert.equal(page.onShareTimeline().query,'');
});
test('promote page timeline guide dialog toggles and binds pending referral for new guests',async()=>{
 const bound=[];
 const {page,storage}=loadPage('promote',{api:async(path,method,body)=>{
  if(path==='/api/user/info')return {invite_code:'PXD-GUEST',is_member:0};
  if(path==='/api/config/all')return {COMMISSION_RATE:'0.03',RED_PACKET_MAX_DEDUCT_RATIO:'0.5'};
  if(path.startsWith('/api/referral/my'))return {summary:{},list:[],next_cursor:null};
  if(path==='/api/user/bind-referrer'){bound.push(body.invite_code);return {};}
  return {};
 }});
 storage.set('pandou_pending_referrer','INVITE999');
 page.showTimelineGuide();assert.equal(page.data.showTimelineGuide,true);
 page.closeTimelineGuide();assert.equal(page.data.showTimelineGuide,false);
 await page.loadReferrals();
 assert.deepEqual(bound,['INVITE999']);
 assert.equal(storage.has('pandou_pending_referrer'),false);
});
test('address management utility handles CRUD, WeChat import and synchronization to contact storage',async()=>{
 const storage=new Map();
 const wxApi={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k),chooseAddress:options=>{
  options.success({userName:'李女士',telNumber:'13812345678',provinceName:'浙江省',cityName:'杭州市',countyName:'临安区',detailInfo:'锦城街道钱王街88号'});
 }};
 const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
 const context=vm.createContext({wx:wxApi,module:{exports:{}},require:()=>({})});
 const file=path.join(__dirname,'../../miniprogram/utils/address.js');
 vm.runInContext(fs.readFileSync(file,'utf8'),context);
 const addrUtil=context.module.exports;

 assert.equal(addrUtil.getAddressList().length, 0);
 const first=addrUtil.saveAddress({name:'张先生',phone:'13900001111',area:'锦城街道',detail:'临天路10弄',is_default:true});
 assert.equal(first.name,'张先生');
 assert.equal(first.is_default,true);
 assert.equal(storage.get('pandou_contact').receiverName,'张先生');

 const second=addrUtil.saveAddress({name:'王阿姨',phone:'13711112222',area:'锦城街道',detail:'钱王大街200号',is_default:true});
 assert.equal(second.is_default,true);
 const list=addrUtil.getAddressList();
 assert.equal(list.find(a=>a.id===first.id).is_default,false);
 assert.equal(storage.get('pandou_contact').receiverName,'王阿姨');

 addrUtil.setDefaultAddress(first.id);
 assert.equal(addrUtil.getDefaultAddress().id,first.id);

 const imported=await addrUtil.importFromWechat();
 assert.equal(imported.name,'李女士');
 assert.equal(imported.is_default,true);
 assert.equal(storage.get('pandou_contact').receiverName,'李女士');

 addrUtil.deleteAddress(imported.id);
 assert.equal(addrUtil.getDefaultAddress().is_default,true);
});
test('member registration supports WeChat profile authorization and address management',async()=>{
 const calls=[],toasts=[];
 const {page}=loadPage('member',{api:async(path,method,body)=>{
  calls.push({path,method,body});
  if(path==='/api/user/info')return {nickname:'临安老客',avatar_url:'',is_member:0,total_consumption:'0.00'};
  if(path==='/api/config/all')return {MEMBER_ENTRY_MODE:'FREE',MEMBER_ENTRY_THRESHOLD:'68.00'};
  if(path==='/api/user/update-profile')return {msg:'ok'};
  if(path==='/api/user/activate-free')return {msg:'ok'};
  return {};
 }},{showToast:o=>toasts.push(o.title),chooseAddress:o=>o.success({userName:'王先生',telNumber:'13500001111',provinceName:'浙江省',cityName:'杭州市',countyName:'临安区',detailInfo:'春天花园1幢'})});

 await page.loadData();
 page.openRegisterModal();
 assert.equal(page.data.showProfileModal,true);
 page.onChooseAvatar({detail:{avatarUrl:'https://thirdwx.qlogo.cn/mmopen/avatar.jpg'}});
 page.onNicknameChange({detail:{value:'西径居士'}});
 page.onPhoneInput({detail:{value:'13958001122'}});
 assert.equal(page.data.editAvatarUrl,'https://thirdwx.qlogo.cn/mmopen/avatar.jpg');
 assert.equal(page.data.editNickname,'西径居士');

 await page.submitProfileAndRegister();
 assert.ok(calls.some(c=>c.path==='/api/user/update-profile'&&c.body.nickname==='西径居士'));
 assert.ok(calls.some(c=>c.path==='/api/user/activate-free'));
 assert.equal(page.data.showProfileModal,false);

 page.openAddressManager();
 assert.equal(page.data.showAddressModal,true);
 await page.importWechatAddress();
 assert.ok(page.data.addressList.length>0);
 assert.equal(page.data.addressList[0].name,'王先生');
 page.closeAddressManager();
 assert.equal(page.data.showAddressModal,false);
});
test('index checkout rapidly selects maintained address and recalculates bills',()=>{
 const storage=new Map([['pandou_addresses',[{id:'addr_1',name:'赵六',phone:'13966667777',area:'临安锦城',detail:'锦城小区5幢101',is_default:true}]]]);
 const {page}=loadPage('index',{},{getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k),showToast:()=>{}});
 page.data.deliveryAreas=['锦城小区'];
 page.openAddressPicker();
 assert.equal(page.data.showAddressPicker,true);
 assert.equal(page.data.addressList.length,1);

 page.selectAddress({currentTarget:{dataset:{id:'addr_1'}}});
 assert.equal(page.data.receiverName,'赵六');
 assert.equal(page.data.receiverPhone,'13966667777');
 assert.equal(page.data.destAddress,'锦城小区5幢101');
 assert.equal(page.data.deliveryArea,'锦城小区');
 assert.equal(page.data.showAddressPicker,false);
});

test('index checkout autofills default address and guides address selection on submit without address', async () => {
 const storage=new Map([['pandou_addresses',[{id:'addr_default',name:'李掌柜',phone:'13800000000',area:'青山湖小区',detail:'青山湖小区10幢202',is_default:true}]]]);
 let toastMsg = '';
 const {page}=loadPage('index',{},{
   getStorageSync:k=>storage.get(k),
   setStorageSync:(k,v)=>storage.set(k,v),
   removeStorageSync:k=>storage.delete(k),
   showToast:(opt)=>{ toastMsg = opt.title; }
 });
 page.data.cartCount = 2;
 page.data.slots = [{date:'2026-11-20',time:'16:30'}];
 page.data.deliveryAreas = ['青山湖小区'];
 page.data.deliveryType = 1;
 page.data.destAddress = '';

 // Opening sheet auto-populates default address
 page.openCheckoutSheet();
 assert.equal(page.data.destAddress, '青山湖小区10幢202');
 assert.equal(page.data.receiverName, '李掌柜');
 assert.equal(page.data.receiverPhone, '13800000000');
 assert.equal(page.data.deliveryArea, '青山湖小区');

 // If address was cleared and submit is called, it pops toast and opens address picker
 page.data.destAddress = '';
 page.data.calcReady = true;
 await page.submitOrderPay();
 assert.equal(toastMsg, '请选择或完善配送地址');
 assert.equal(page.data.showAddressPicker, true);

 // Contact modal allows editing recipient and phone via dedicated dialog
 page.openContactModal();
 assert.equal(page.data.showContactModal, true);
 assert.equal(page.data.tempReceiverName, '李掌柜');
 assert.equal(page.data.tempReceiverPhone, '13800000000');

 page.onTempNameInput({ detail: { value: '杨力' } });
 page.onTempPhoneInput({ detail: { value: '13738027508' } });
 page.saveContactModal();

 assert.equal(page.data.showContactModal, false);
 assert.equal(page.data.receiverName, '杨力');
 assert.equal(page.data.receiverPhone, '13738027508');
 assert.equal(storage.get('pandou_contact').receiverName, '杨力');
 assert.equal(storage.get('pandou_contact').receiverPhone, '13738027508');

 // Delivery modal allows unified modification of recipient, phone and address together
 page.data.deliveryType = 1;
 page.openDeliveryModal();
 assert.equal(page.data.showDeliveryModal, true);
 page.onEditNameInput({ detail: { value: '陈女士' } });
 page.onEditPhoneInput({ detail: { value: '13912345678' } });
 page.onEditAddressInput({ detail: { value: '青山湖小区18幢601' } });
 page.saveUnifiedDelivery();

 assert.equal(page.data.showDeliveryModal, false);
 assert.equal(page.data.receiverName, '陈女士');
 assert.equal(page.data.receiverPhone, '13912345678');
 assert.ok(page.data.destAddress.includes('青山湖小区18幢601'));
 assert.equal(storage.get('pandou_contact').receiverName, '陈女士');
 assert.equal(storage.get('pandou_contact').receiverPhone, '13912345678');
});

test('admin workbench supports member filter, integer point validation, adjust logs and safe dish filtering/editing', async () => {
 const requests = [], toasts = [], copies = [];
 const { page } = loadPage('admin', {
  api: async (path, method, body) => {
   requests.push({ path, method, body });
   if (path.startsWith('/api/admin/members')) return { list: [{ id: 1, is_member: 1 }], total: 1, next_cursor: null, summary: { total_users: 1 } };
   if (path.startsWith('/api/admin/member/adjust-logs')) return [{ id: 9, account_type: 'NORMAL_POINT', amount: '10', before_val: '0', after_val: '10', reason: '老客回馈' }];
   if (path === '/api/admin/product/stock') return { ok: true };
   return [];
  },
  callContainer: async opts => { requests.push({ path: opts.path, method: opts.method, body: opts.data }); return { code: 0, data: [] }; }
 }, {
  showToast: o => toasts.push(o.title),
  setClipboardData: o => { copies.push(o.data); if (o.success) o.success(); }
 });

 // Member filter passes is_member param
 page.changeMemberFilter({ currentTarget: { dataset: { filter: '1' } } });
 await new Promise(setImmediate);
 assert.match(requests[0].path, /is_member=1/);

 // Integer check prevents fractional normal point submission
 page.data.currentMember = { id: 5, nickname: '老张' };
 page.data.pointsForm = { adjust_type: 'NORMAL_POINT', amount: '12.5', reason: '测试小数拦截' };
 await page.submitAdjustPoints();
 assert.ok(toasts.some(t => /整数/.test(t)));
 assert.equal(requests.filter(r => r.path === '/api/admin/member/adjust-points').length, 0);

 // Adjust logs loader fetches audit rows
 await page.openAdjustLogsModal({ currentTarget: { dataset: { member: { id: 5, nickname: '老张' } } } });
 assert.equal(page.data.showAdjustLogsModal, true);
 assert.equal(page.data.adjustLogs.length, 1);
 assert.equal(page.data.adjustLogs[0].reason, '老客回馈');

 // Editing existing product does NOT overwrite custom member_price when origin_price changes
 page.openEditModal({ currentTarget: { dataset: { dish: { id: 2, title: '老卤牛肉', origin_price: '50.00', member_price: '39.90', category_id: 2, stock_qty: 10 } } } });
 page.onInputFormOriginPrice({ detail: { value: '55.00' } });
 assert.equal(page.data.dishForm.origin_price, '55.00');
 assert.equal(page.data.dishForm.member_price, '39.90');

 // Adding new product auto-calculates 88% member_price
 page.openAddModal();
 page.onInputFormOriginPrice({ detail: { value: '100' } });
 assert.equal(page.data.dishForm.member_price, '88.00');

 // Filtered product toggle updates the right dish by id, not filtered index
 page.data.dishes = [
  { id: 10, title: '招牌鸡爪', category_id: 1, status: 1, stock_qty: 20 },
  { id: 20, title: '卤鸭脖', category_id: 3, status: 1, stock_qty: 3 }
 ];
 page.changeProductStatusFilter({ currentTarget: { dataset: { status: 'LOW' } } });
 assert.deepEqual(Array.from(page.data.filteredDishes, d => d.id), [20]);
 page.toggleProductStatus({ currentTarget: { dataset: { id: 20, index: 0 } }, detail: { value: false } });
 await new Promise(setImmediate);
 assert.equal(page.data.dishes[0].status, 1);
 assert.equal(page.data.dishes[1].status, 0);

 // Stock modal quick adjust and save
 page.data.orderDate = '2026-11-25';
 page.openStockModal({ currentTarget: { dataset: { dish: page.data.dishes[1] } } });
 assert.equal(page.data.stockInputVal, '3');
 page.quickAdjustStock({ currentTarget: { dataset: { delta: 10 } } });
 assert.equal(page.data.stockInputVal, '13');
 await page.saveStockModal();
 const stockReq = requests.find(r => r.path === '/api/admin/product/stock');
 assert.equal(stockReq.body.product_id, 20);
 assert.equal(stockReq.body.available_qty, 13);

 // Prep summary copy
 page.data.prepSummary = [{ product_id: 1, product_title: '五香牛肉', quantity: 4 }];
 page.data.prepTotalQty = 4;
 page.copyPrepSummary();
 assert.match(copies[0], /五香牛肉 × 4 份/);
 assert.match(copies[0], /共 4 份/);
});

test('report translates SIGN_IN flows and shifts dates cleanly', async () => {
 const requests = [];
 const { page } = loadPage('report', {
  api: async path => {
   requests.push(path);
   if (path.includes('/daily')) return { date: path.slice(-10), cash: {}, benefits: [{ account_type: 'NORMAL_POINT', event_type: 'SIGN_IN', amount: '10', unit: '分', records: 1 }] };
   return { list: [], next_cursor: null };
  }
 });
 page.onLoad();
 await new Promise(setImmediate);
 assert.equal(page.data.summary.benefits[0].event_title, '每日签到赠送');

 const beforeDate = page.data.date;
 page.shiftDate({ currentTarget: { dataset: { delta: -1 } } });
 await new Promise(setImmediate);
 assert.notEqual(page.data.date, beforeDate);
 assert.ok(requests.some(p => p.includes('date=' + page.data.date)));

 page.goToday();
 assert.equal(page.data.date, beforeDate);
});

test('admin manages product categories dynamically and index page syncs remote categories', async () => {
 let remoteCategories = [
  { id: 1, name: '招牌必吃', sort_order: 50 },
  { id: 6, name: '凉拌小菜', sort_order: 60 }
 ];
 const adminCalls = [], modals = [];
 const { page: adminPage } = loadPage('admin', {
  api: async (path, method, body) => {
   adminCalls.push({ path, method, body });
   if (path === '/api/categories') return remoteCategories;
   if (path === '/api/admin/category/add') {
    const item = { id: 7, name: body.name, sort_order: body.sort_order };
    remoteCategories = [item, ...remoteCategories];
    return item;
   }
   if (path === '/api/admin/category/update') {
    remoteCategories = remoteCategories.map(c => c.id === body.id ? { ...c, name: body.name, sort_order: body.sort_order } : c);
    return {};
   }
   if (path === '/api/admin/category/delete') {
    remoteCategories = remoteCategories.filter(c => c.id !== body.id);
    return {};
   }
   return [];
  }
 }, { showModal: o => modals.push(o) });

 adminPage.openCategoryModal();
 await new Promise(setImmediate);
 assert.equal(adminPage.data.rawCategories.length, 2);
 assert.equal(adminPage.data.categoryOptions[2].name, '凉拌小菜');

 // Selecting non-sequential category id 6 maps accurately when editing product
 adminPage.openEditModal({ currentTarget: { dataset: { dish: { id: 9, title: '拌黄瓜', origin_price: '12.00', member_price: '10.00', category_id: 6, stock_qty: 5 } } } });
 assert.equal(adminPage.data.dishCategoryIndex, 1);
 assert.equal(adminPage.data.dishForm.category_id, 6);

 // Add category
 adminPage.onCategoryFieldInput({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '新品卤味' } });
 adminPage.onCategoryFieldInput({ currentTarget: { dataset: { field: 'sort_order' } }, detail: { value: '99' } });
 await adminPage.saveCategoryForm();
 assert.ok(adminCalls.some(c => c.path === '/api/admin/category/add' && c.body.name === '新品卤味' && c.body.sort_order === 99));
 assert.equal(adminPage.data.rawCategories[0].id, 7);

 // Update category
 adminPage.editCategoryItem({ currentTarget: { dataset: { cat: { id: 7, name: '新品卤味', sort_order: 99 } } } });
 adminPage.onCategoryFieldInput({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '精选新品' } });
 await adminPage.saveCategoryForm();
 assert.ok(adminCalls.some(c => c.path === '/api/admin/category/update' && c.body.id === 7 && c.body.name === '精选新品'));

 // Delete category
 adminPage.confirmDeleteCategory({ currentTarget: { dataset: { cat: { id: 7, name: '精选新品' } } } });
 await modals[0].success({ confirm: true });
 assert.ok(adminCalls.some(c => c.path === '/api/admin/category/delete' && c.body.id === 7));

 // Index page dynamically renders remote categories while preserving built-in icons for id 1..4
 const { page: indexPage } = loadPage('index', {
  api: async path => {
   if (path === '/api/batches') return { slots: [], config: { RED_PACKET_MAX_DEDUCT_RATIO: '0.50' }, delivery_areas: [] };
   if (path === '/api/user/info') return { is_member: 1, normal_points: 10, red_packet_points: '0.00' };
   if (path === '/api/categories') return remoteCategories;
   return [];
  }
 });
 await indexPage.refresh();
 assert.equal(indexPage.data.categories[0].name, '全部卤味');
 assert.equal(indexPage.data.categories[1].iconNormal, '/images/category/cat_1.png');
 assert.equal(indexPage.data.categories[2].name, '凉拌小菜');
 assert.equal(indexPage.data.categories[2].iconNormal, undefined);
});



