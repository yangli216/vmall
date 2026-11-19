const app = getApp();
const categories = [
  {value:'QUALITY',label:'餐品质量问题'}, {value:'MISSING',label:'缺品或错品'},
  {value:'PAYMENT',label:'支付或退款问题'}, {value:'OTHER',label:'其他问题'}
];
const statusTitles = {OPEN:'待掌柜处理',PROCESSING:'掌柜处理中',RESOLVED:'掌柜已回复'};
Page({
  data:{orderId:0,order:null,categories,categoryIndex:0,description:'',rows:[],nextCursor:null,
    loading:false,submitting:false,error:'',phone:'',hasActive:false},
  onLoad(options) {
    const id = Number(options.order_id);
    if (!Number.isSafeInteger(id) || id <= 0) { this.setData({error:'订单无效，请返回订单页重新进入'}); return; }
    this.setData({orderId:id}); this.refresh();
  },
  onPullDownRefresh(){this.refresh().finally(()=>wx.stopPullDownRefresh());},
  onReachBottom(){if(this.data.nextCursor && !this.data.loading)this.loadTickets(true);},
  async refresh() {
    if(!this.data.orderId)return;
    this.setData({error:'',loading:true});
    try {
      const [order, config] = await Promise.all([app.api('/api/order/detail?id='+this.data.orderId),app.api('/api/config/all')]);
      this.setData({order,phone:config.DELIVERY_PERSON_PHONE});
      await this.loadTickets();
    } catch(error) {this.setData({error:error.message});}
    finally {this.setData({loading:false});}
  },
  async loadTickets(append=false) {
    const sequence=this._sequence=(this._sequence || 0)+1;
    this.setData({loading:true});
    try {
      const result=await app.api('/api/support/my?order_id='+this.data.orderId+(append?'&before_id='+this.data.nextCursor:''));
      if(sequence!==this._sequence)return;
      const rows=(append?this.data.rows:[]).concat(result.list.map(row=>Object.assign({},row,{status_title:statusTitles[row.status],category_title:(categories.find(c=>c.value===row.category)||{}).label || '订单问题'})));
      this.setData({rows,nextCursor:result.next_cursor,error:'',hasActive:rows.some(row=>row.status!=='RESOLVED')});
    } catch(error){if(sequence===this._sequence)this.setData({error:error.message});}
    finally {if(sequence===this._sequence)this.setData({loading:false});}
  },
  changeCategory(e){if(!this.data.submitting)this.setData({categoryIndex:Number(e.detail.value)});},
  onDescription(e){if(!this.data.submitting)this.setData({description:e.detail.value});},
  async submit() {
    if(this.data.submitting || this.data.loading || !this.data.order || this.data.hasActive)return;
    const description=this.data.description.trim(),category=this.data.categories[this.data.categoryIndex];
    if(!description || !category)return wx.showToast({title:'请选择类型并填写问题说明',icon:'none'});
    const payload={order_id:this.data.orderId,category:category.value,description};
    const fingerprint=JSON.stringify(payload),pending=wx.getStorageSync('pandou_pending_support');
    const requestId=pending && pending.fingerprint===fingerprint?pending.requestId:`support_${Date.now()}_${Math.random().toString(36).slice(2,12)}`;
    wx.setStorageSync('pandou_pending_support',{fingerprint,requestId});payload.request_id=requestId;
    this.setData({submitting:true});
    try {
      await app.api('/api/support/create','POST',payload);wx.removeStorageSync('pandou_pending_support');
      this.setData({description:''});wx.showToast({title:'问题已提交',icon:'success'});await this.loadTickets();
    } catch(error){wx.showToast({title:error.message,icon:'none'});if(error.code===409)await this.loadTickets();}
    finally {this.setData({submitting:false});}
  },
  contact(){if(this.data.phone)wx.makePhoneCall({phoneNumber:this.data.phone});}
});
