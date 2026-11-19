const app=getApp();
const {payOrder,sync}=require('../../utils/payment');
const {paymentClock}=require('../../utils/order-clock');
const {copyAddress}=require('../../utils/copy-address');
const titles={10:'待付款',20:'待备餐',25:'可到店取餐',30:'配送中',40:'已完成',50:'已退款',60:'已取消',70:'退款处理中'};
Page({
 data:{orders:[],loading:false,error:'',nextCursor:null,status:'',expandedId:null,busyId:null,refreshAvailable:false,paymentTimers:{},
  filters:[{value:'',label:'全部'},{value:'10,20,25,30,70',label:'进行中'},{value:'40',label:'已完成'},{value:'50,60',label:'取消/退款'}],phone:''},
 onShow(){
  this._visible=true;this._destroyed=false;const view=this._viewSequence=(this._viewSequence||0)+1;
  clearInterval(this.poll);clearInterval(this.clockTimer);this.updateCountdown();this.fetchOrders();
  app.api('/api/config/all').then(c=>{if(this._visible && view===this._viewSequence)this.setData({phone:c.DELIVERY_PERSON_PHONE});}).catch(()=>{});
  this.poll=setInterval(()=>{if(!this.data.loading&&!this.data.busyId)this.fetchOrders(true);},15000);
  this.clockTimer=setInterval(()=>this.updateCountdown(),1000);
 },
 stopWatching(){this._visible=false;this._viewSequence=(this._viewSequence||0)+1;this.sequence=(this.sequence||0)+1;clearInterval(this.poll);clearInterval(this.clockTimer);this.poll=null;this.clockTimer=null;this.setData({loading:false});},
 onHide(){this.stopWatching();},onUnload(){this.stopWatching();this._destroyed=true;},
 clockReading(){try{const performance=wx.getPerformance&&wx.getPerformance();if(performance && typeof performance.now==='function')return performance.now();}catch(error){}return Date.now();},
 serverNow(){return this._clock?this._clock.server+Math.max(0,this.clockReading()-this._clock.received):NaN;},
 updateCountdown(){
  if(this._visible===false || this._destroyed)return;
  const timers={},now=this.serverNow();
  this.data.orders.forEach(order=>{if(order.order_status===10 && order.payment_state==='UNPAID'){const timer=paymentClock(order,now);if(timer)timers[order.id]=timer;}});
  if(JSON.stringify(timers)!==JSON.stringify(this.data.paymentTimers))this.setData({paymentTimers:timers});
 },
 onPullDownRefresh(){this.fetchOrders().finally(()=>wx.stopPullDownRefresh());},
 onReachBottom(){if(this.data.nextCursor&&!this.data.loading)this.fetchOrders(false,true);},
 retryOrders(){return this.fetchOrders();},
 async fetchOrders(quiet=false,append=false){
  if(this._visible===false || this._destroyed || (append && (this.data.loading || !this.data.nextCursor)))return;
  const seq=(this.sequence||0)+1;this.sequence=seq;
  this.setData({loading:true,error:quiet?this.data.error:'',refreshAvailable:quiet?this.data.refreshAvailable:false});
  let path='/api/order/list?status='+encodeURIComponent(this.data.status);
  if(append&&this.data.nextCursor)path+='&before_id='+this.data.nextCursor;
  try{const res=await app.callContainer({path});if(!res||res.code!==0)throw new Error((res&&res.msg)||'加载失败');if(seq!==this.sequence || this._visible===false || this._destroyed)return;
   if(Number.isSafeInteger(res.server_time) && res.server_time>0)this._clock={server:res.server_time,received:this.clockReading()};
   const list=res.data.map(o=>Object.assign({},o,{status_title:titles[o.order_status]||'待核对',legacy:o.payment_state==='LEGACY'}));
   // Do not collapse paginated history while silently refreshing: a manual refresh resets it.
   if(quiet&&this.data.orders.length>30){if(JSON.stringify(list)!==JSON.stringify(this.data.orders.slice(0,30)))this.setData({refreshAvailable:true});this.updateCountdown();return;}
   this.setData({orders:append?this.data.orders.concat(list):list,nextCursor:res.next_cursor,error:''});this.updateCountdown();
  }catch(e){if(seq===this.sequence)this.setData({error:e.message||'网络异常，请重试'});}
  finally{if(seq===this.sequence)this.setData({loading:false});}
 },
 filterOrders(e){this.setData({status:e.currentTarget.dataset.value,orders:[],nextCursor:null,paymentTimers:{}});this.fetchOrders();},
 expand(e){const id=e.currentTarget.dataset.id;this.setData({expandedId:this.data.expandedId===id?null:id});},
 async pay(e){if(this.data.busyId || this._visible===false || this._destroyed)return;const id=e.currentTarget.dataset.id,order=this.data.orders.find(o=>o.id===id);if(!order || order.order_status!==10 || order.payment_state!=='UNPAID')return;const timer=paymentClock(order,this.serverNow());if(timer && timer.expired){this.updateCountdown();wx.showToast({title:'付款时限已到，请查询支付结果或刷新订单',icon:'none'});this.fetchOrders();return;}this.setData({busyId:id});try{const result=await payOrder(id);if(!this._destroyed && this._visible!==false)wx.showToast({title:result.confirmed?'付款已确认':result.refunding?'退款处理中':'结果确认中，请刷新订单',icon:'none'});}catch(error){if(!this._destroyed && this._visible!==false)wx.showToast({title:error.message,icon:'none',duration:3000});}finally{if(!this._destroyed){this.setData({busyId:null});this.fetchOrders();}}},
 async queryPayment(e){const id=e.currentTarget.dataset.id;if(this.data.busyId || this._visible===false || this._destroyed)return;this.setData({busyId:id});try{await sync(id);await this.fetchOrders();}catch(error){if(this._visible!==false && !this._destroyed)wx.showToast({title:error.message,icon:'none'});}finally{if(!this._destroyed)this.setData({busyId:null});}},
 cancel(e){const id=e.currentTarget.dataset.id,order=this.data.orders.find(o=>o.id===id);if(!order||this.data.busyId)return;
  wx.showModal({title:'确认取消订单？',content:order.order_status===10?'订单关闭后将返还已占用积分。':'将申请原路退款，渠道确认退款成功后返还抵扣积分。',success:async r=>{if(!r.confirm || this.data.busyId || this._visible===false || this._destroyed)return;this.setData({busyId:id});try{const result=await app.api('/api/order/cancel','POST',{order_id:id});if(this._visible!==false && !this._destroyed)wx.showToast({title:result.order_status===70?'退款申请处理中':result.order_status===50?'退款已完成':'订单已取消',icon:'none'});await this.fetchOrders();}catch(error){if(this._visible!==false && !this._destroyed)wx.showToast({title:error.message,icon:'none'});}finally{if(!this._destroyed)this.setData({busyId:null});}}});
 },
 confirm(e){if(this.data.busyId || this._visible===false || this._destroyed)return;const id=e.currentTarget.dataset.id;wx.showModal({title:'确认已收到餐品？',content:'确认后订单完成，并按有效货款结算积分和推荐奖励。',success:async r=>{if(!r.confirm || this.data.busyId || this._visible===false || this._destroyed)return;this.setData({busyId:id});try{await app.api('/api/order/complete','POST',{order_id:id});await this.fetchOrders();}catch(error){if(this._visible!==false && !this._destroyed)wx.showToast({title:error.message,icon:'none'});}finally{if(!this._destroyed)this.setData({busyId:null});}}});},
 contact(){if(this.data.phone)wx.makePhoneCall({phoneNumber:this.data.phone});},
 copyPickupAddress(e){const order=this.data.orders.find(o=>o.id===Number(e.currentTarget.dataset.id));if(order && order.delivery_type===2)copyAddress(order.receiver_address);},
 support(e){wx.navigateTo({url:'/pages/support/support?order_id='+e.currentTarget.dataset.id});},
 async reorder(e){const order=this.data.orders.find(o=>o.id===e.currentTarget.dataset.id),view=this._viewSequence;if(!order || this._visible===false || this._destroyed)return;wx.showModal({title:'再来一单',content:'将按当前在售菜品和价格加入购物车，替换原购物车。',success:async r=>{if(!r.confirm || this._visible===false || this._destroyed || view!==this._viewSequence)return;try{const products=await app.api('/api/products'),cart={};if(this._visible===false || this._destroyed || view!==this._viewSequence)return;order.items.forEach(item=>{const p=products.find(p=>p.id===item.product_id&&p.status===1&&p.stock_qty>0);if(p)cart[p.id]={id:p.id,dish:p,quantity:Math.min(item.quantity,p.stock_qty,99)};});if(!Object.keys(cart).length)throw new Error('原订单菜品暂不可售，请重新挑选');wx.setStorageSync('pandou_cart',cart);wx.setStorageSync('pandou_reorder',true);wx.switchTab({url:'/pages/index/index'});}catch(error){if(this._visible!==false && !this._destroyed && view===this._viewSequence)wx.showToast({title:error.message,icon:'none'});}}});},
 navToMenu(){wx.switchTab({url:'/pages/index/index'});}
});
