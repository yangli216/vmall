// miniprogram/pages/admin/admin.js
const app = getApp();
const productImage = require('../../utils/product-image');
const adminPrivacy = require('../../utils/admin-privacy');
const adminConfig = require('../../utils/admin-config');

Page({
  ...productImage.methods,
  onDishImageError: function(e) {
    const id = Number(e.currentTarget.dataset.id);
    const dishes = [...(this.data.dishes || [])];
    const realIndex = id ? dishes.findIndex(d => d.id === id) : Number(e.currentTarget.dataset.index);
    if (realIndex >= 0 && dishes[realIndex]) {
      dishes[realIndex] = Object.assign({}, dishes[realIndex], { imageFailed: true });
      this.setData({ dishes, filteredDishes: this.applyDishFilters(dishes) });
    }
  },
  ...adminPrivacy.methods,
  ...adminConfig.methods,
  data: {
    loading: true, activeTab: 'orders', orderDate: '', orderKeyword: '', orderNextCursor: null, prepSummary: [],
    allOrderDates:false,overduePickupOnly:false,completionBusyId:null,
    activityQueues:null,activityError:'',activityCheckedAt:'',newPaidCount:0,newSupportCount:0,
    orderLoading:false,orderError:'',prepError:'',capacityError:'',batchCapacity:null,orderFilterIndex:0,orderDeliveryIndex:0,orderDeliveryNames:['全部取餐方式','作坊自送','到店自提'],
    orderFilters:[{label:'全部订单',value:''},{label:'待付款',value:'10'},{label:'待备餐',value:'20'},{label:'待取餐',value:'25'},{label:'配送中',value:'30'},{label:'已完成',value:'40'},{label:'退款处理中',value:'70'},{label:'已退款/已取消',value:'50,60'}],
    rawCategories: [
      { id: 1, name: '招牌必吃', sort_order: 50 },
      { id: 2, name: '秘制酱牛肉', sort_order: 40 },
      { id: 3, name: '麻辣鸭副件', sort_order: 30 },
      { id: 4, name: '爽脆下酒菜', sort_order: 20 },
      { id: 5, name: '手工饮品', sort_order: 10 }
    ],
    categoryNames: ['招牌必吃','秘制酱牛肉','麻辣鸭副件','爽脆下酒菜','手工饮品'],
    categoryOptions: [
      { id: 0, name: '全部分类' },
      { id: 1, name: '招牌必吃' },
      { id: 2, name: '秘制酱牛肉' },
      { id: 3, name: '麻辣鸭副件' },
      { id: 4, name: '爽脆下酒菜' },
      { id: 5, name: '手工饮品' }
    ],
    dishes: [],
    filteredDishes: [],
    productCategoryFilter: 0,
    productCategoryIndex: 0,
    productStatusFilter: 'ALL',
    dishCategoryIndex: 0,
    showCategoryModal: false,
    categoryForm: { id: 0, name: '', sort_order: '0' },
    categorySaving: false,
    pendingOrders: [],
    dispatchableCount: 0,
    prepTotalQty: 0,
    members: [], memberTotal: 0, memberNextCursor: null, memberLoading: false, memberError: '',
    memberFilterIsMember: '',
    showAdjustLogsModal: false, adjustLogs: [], adjustLogsLoading: false, adjustLogsMemberName: '',
    showStockModal: false, stockTarget: null, stockInputVal: '', stockSaving: false,
    privacyRequests:[],privacyStatus:'OPEN',privacyNextCursor:null,privacyLoading:false,privacyError:'',privacyBusyId:null,
    supportTickets: [], supportStatus: 'OPEN', supportNextCursor: null, supportLoading: false, supportError: '', supportBusyId: null, refundBusyId: null,
    memberSummary: {
      total_users: 0,
      total_vip_members: 0,
      all_time_consumption: '0.00',
      total_outstanding_red_points: '0.00'
    },
    memberKeyword: '',
    configLoaded:false,configLoading:false,configSaving:false,configDirty:false,configError:'',
    config: {
      MEMBER_ENTRY_MODE: 'CONSUME',
      MEMBER_ENTRY_THRESHOLD: 68,
      RED_PACKET_MAX_DEDUCT_RATIO: '0.50',
      COMMISSION_RATE: '0.03',
      DELIVERY_BASE_FEE: '3.00',
      DELIVERY_FREE_THRESHOLD: '38.00',
      DELIVERY_PERSON_PHONE: '',DELIVERY_PERSON_NAME:'',WORKSHOP_ADDRESS:'',WORKSHOP_LAT:'',WORKSHOP_LNG:'',DELIVERY_MAX_KM:'5',ORDER_EXPIRE_MINUTES:'15',
      WORKSHOP_ANNOUNCEMENT: '', DELIVERY_AREAS: '', BATCH_SCHEDULE_TIME: '16:30', BATCH_CUTOFF_TIME: '16:00', BOOKING_DAYS: '1', SHOP_OPEN: '1',BATCH_MAX_ORDERS:'0'
    },
    redDeductPercent: 50,
    commissionPercent: 3,
    photoBusy:false,photoError:'',photoPreview:'',dishSaving:false,
    showAddModal: false,
    isEditingDish: false,
    dishForm: {
      id: 0,
      title: '',
      origin_price: '',
      member_price: '',
      badge: '今日现捞',
      intro: ''
    },
    showPointsModal: false, pointsSubmitting: false,
    showReferrerModal: false,
    currentMember: null,
    pointsForm: {
      adjust_type: 'NORMAL_POINT',
      amount: '',
      reason: ''
    },
    referrerForm: {
      invite_code: ''
    }
  },

  onLoad: function () {
    this._configUnloaded=false;
    this._privacyUnloaded=false;
    this.checkAdminAuth();
  },
  onShow: function(){this._visible=true;this.startActivityPolling();},
  onHide: function(){this.stopActivityPolling();},
  onUnload: function(){this._configUnloaded=true;this._configSequence=(this._configSequence || 0)+1;this._privacyUnloaded=true;this._privacySequence=(this._privacySequence || 0)+1;this.stopActivityPolling();this._adminAuthorized=false;this._dishEpoch=(this._dishEpoch || 0)+1;this._pendingPhoto=null;},
  stopActivityPolling: function(){
    this._visible=false;this._activityEpoch=(this._activityEpoch || 0)+1;
    if(this._activityTimer){clearTimeout(this._activityTimer);this._activityTimer=null;}
  },
  startActivityPolling: function(){
    if(!this._visible || !this._adminAuthorized || this._activityInFlight || this._activityTimer)return;
    this.pollActivity();
  },
  refreshActivity: function(){
    if(this._activityTimer){clearTimeout(this._activityTimer);this._activityTimer=null;}
    this.startActivityPolling();
  },
  pollActivity: async function(){
    if(!this._visible || !this._adminAuthorized || this._activityInFlight)return;
    const epoch=this._activityEpoch || 0;let more=false;
    this._activityInFlight=true;
    try{
      const result=await app.api('/api/admin/activity'+(this._activityCursor===undefined?'':'?after_revision='+this._activityCursor));
      if(!this._visible || epoch!==(this._activityEpoch || 0))return;
      this._activityCursor=result.cursor;more=result.has_more;
      const events=result.events || [];
      this.setData({activityQueues:result.queues,activityError:'',activityCheckedAt:result.checked_at,
        newPaidCount:(result.reset?0:this.data.newPaidCount)+events.filter(e=>e.kind==='ORDER_PAID').length,
        newSupportCount:(result.reset?0:this.data.newSupportCount)+events.filter(e=>e.kind==='SUPPORT_OPENED').length});
    }catch(error){if(this._visible && epoch===(this._activityEpoch || 0))this.setData({activityError:error.message || '动态检查失败'});}
    finally{
      this._activityInFlight=false;
      if(this._visible && this._adminAuthorized)this._activityTimer=setTimeout(()=>{this._activityTimer=null;this.pollActivity();},epoch!==(this._activityEpoch || 0) || more?0:15000);
    }
  },
  openActivityQueue: function(e){
    const kind=e.currentTarget.dataset.kind;
    if(kind==='privacy'){this.setData({activeTab:'privacy',privacyStatus:'OPEN'});this.loadPrivacyRequests();return;}
    if(kind==='support'){
      this.setData({activeTab:'support',supportStatus:'OPEN',newSupportCount:0});this.loadSupportTickets();return;
    }
    const indexes={prepare:2,pickup:3,overdue:3,delivery:4,refund:6};
    if(indexes[kind]===undefined)return;
    this.setData({activeTab:'orders',allOrderDates:true,overduePickupOnly:kind==='overdue',orderFilterIndex:indexes[kind],orderDeliveryIndex:kind==='pickup'||kind==='overdue'?2:0,orderKeyword:'',newPaidCount:kind==='prepare'?0:this.data.newPaidCount});
    this.loadPendingOrders();
  },

  checkAdminAuth: async function () {
    try {
      const user=await app.api('/api/user/info');
      if(user.is_admin!==1) throw new Error('当前微信未获掌柜授权');
      this._adminAuthorized=true;this.startActivityPolling();
      const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
      this.setData({orderDate:today});
      await this.loadConfigs();
      if(this._configUnloaded)return;
      if(!this.data.configLoaded){this.setData({loading:false,orderError:'请先重新读取营业设置，再查看批次订单'});return;}
      this.loadCategories();this.loadDishes();this.loadPendingOrders();this.loadMembers();
    } catch(error) {wx.showModal({title:'掌柜管理',content:error.message,showCancel:false,success:()=>wx.navigateBack()});}
  },
  openReport:function(){wx.navigateTo({url:'/pages/report/report'});},
  changeAdminTab: function(e) {if(this.data.configSaving)return;const tab=e.currentTarget.dataset.tab;this.setData({activeTab:tab});if(tab==='support')this.loadSupportTickets();if(tab==='privacy')this.loadPrivacyRequests();if(tab==='orders' || tab==='products'){if(!this.data.configLoaded){this.reloadConfigs();return;}if(tab==='orders')this.loadPendingOrders();else{this.loadCategories();this.loadDishes();}}},
  changeSupportStatus: function(e) {this.setData({supportStatus:e.currentTarget.dataset.status});this.loadSupportTickets();},
  loadSupportTickets: async function(append=false) {
    if(append!==true)append=false;
    if(append && (this.data.supportLoading || !this.data.supportNextCursor))return;
    const sequence=this._supportSequence=(this._supportSequence || 0)+1;
    this.setData({supportLoading:true,supportError:''});
    try {
      const result=await app.api('/api/admin/support?status='+this.data.supportStatus+(append?'&before_id='+this.data.supportNextCursor:''));
      if(sequence!==this._supportSequence)return;
      const states={OPEN:'待处理',PROCESSING:'处理中',RESOLVED:'已回复'},categories={QUALITY:'质量问题',MISSING:'缺品/错品',PAYMENT:'支付/退款',OTHER:'其他问题'};
      this.setData({supportTickets:(append?this.data.supportTickets:[]).concat(result.list.map(row=>Object.assign({},row,{status_title:states[row.status],category_title:categories[row.category]}))),supportNextCursor:result.next_cursor});
    }catch(error){if(sequence===this._supportSequence)this.setData({supportError:error.message});}
    finally{if(sequence===this._supportSequence)this.setData({supportLoading:false});}
  },
  moreSupportTickets: function(){this.loadSupportTickets(true);},
  acceptSupportTicket: function(e){this.saveSupportTicket(e.currentTarget.dataset.id,'PROCESSING','');},
  replySupportTicket: function(e){
    if(this.data.supportBusyId)return;
    const id=e.currentTarget.dataset.id;
    wx.showModal({title:'回复处理结果',editable:true,placeholderText:'请填写已协商的处理结果；退款状态以订单为准',success:r=>{if(r.confirm && !this.data.supportBusyId)this.saveSupportTicket(id,'RESOLVED',(r.content || '').trim());}});
  },
  saveSupportTicket: async function(id,status,resolution){
    if(this.data.supportBusyId)return;
    if(status==='RESOLVED' && !resolution)return wx.showToast({title:'请填写处理结果',icon:'none'});
    this.setData({supportBusyId:id});
    try{await app.api('/api/admin/support/handle','POST',{id,status,resolution});wx.showToast({title:status==='RESOLVED'?'回复已保存':'已接单处理'});await this.loadSupportTickets();}
    catch(error){wx.showToast({title:error.message,icon:'none'});}
    finally{this.setData({supportBusyId:null});}
  },
  callSupportCustomer: function(e){wx.makePhoneCall({phoneNumber:e.currentTarget.dataset.phone});},
  openSupportOrder: function(e){const ticket=this.data.supportTickets.find(t=>t.id===Number(e.currentTarget.dataset.id));if(!ticket)return;this.setData({activeTab:'orders',allOrderDates:!ticket.batch_date,overduePickupOnly:false,orderDate:ticket.batch_date || this.data.orderDate,orderKeyword:ticket.order_sn,orderFilterIndex:0,orderDeliveryIndex:0});this.loadPendingOrders();},
  changeOrderDate: function(e) {this.setData({orderDate:e.detail.value,allOrderDates:false,overduePickupOnly:false});this.loadPendingOrders();this.loadDishes();},
  showSelectedDate: function(){this.setData({allOrderDates:false,overduePickupOnly:false});this.loadPendingOrders();},
  onOrderKeyword: function(e) {this.setData({orderKeyword:e.detail.value});},
  clearOrderKeyword: function() {this.setData({orderKeyword:''});this.loadPendingOrders();},
  searchOrders: function() {this.loadPendingOrders();},
  copyOrderAddress: function(e) {
    const addr = e.currentTarget.dataset.address;
    if (!addr) return;
    wx.setClipboardData({ data: addr, success: () => wx.showToast({ title: '地址已复制', icon: 'success' }) });
  },
  copyPrepSummary: function() {
    const list = this.data.prepSummary || [];
    if (!list.length) return wx.showToast({ title: '暂无待备餐数据', icon: 'none' });
    const lines = [`【${this.data.orderDate} ${this.data.config.BATCH_SCHEDULE_TIME} 备餐清单】`, `共 ${this.data.prepTotalQty} 份：`];
    list.forEach(item => lines.push(`- ${item.product_title} × ${item.quantity} 份`));
    wx.setClipboardData({ data: lines.join('\n'), success: () => wx.showToast({ title: '清单已复制', icon: 'success' }) });
  },
  changeOrderFilter: function(e){const index=Number(e.detail.value);if(!this.data.orderFilters[index])return;this.setData({orderFilterIndex:index,overduePickupOnly:false});this.loadPendingOrders();},
  changeOrderDelivery: function(e){const index=Number(e.detail.value);if(!this.data.orderDeliveryNames[index])return;this.setData({orderDeliveryIndex:index,overduePickupOnly:false});this.loadPendingOrders();},
  retryOrders: function(){this.loadPendingOrders();},
  onDishField: function(e) {if(this.data.dishSaving || (e.currentTarget.dataset.field==='cover_img' && (this.data.photoBusy || this._pendingPhoto)))return;this.setData({['dishForm.'+e.currentTarget.dataset.field]:e.detail.value});},
  onDishCategory: function(e) {
    if (this.data.dishSaving) return;
    const idx = Number(e.detail.value);
    const list = this.data.rawCategories || [];
    const target = list[idx];
    this.setData({
      dishCategoryIndex: idx >= 0 ? idx : 0,
      'dishForm.category_id': target ? target.id : (idx + 1)
    });
  },
  loadCategories: async function() {
    try {
      const rows = await app.api('/api/categories');
      if (!Array.isArray(rows) || !rows.length) return;
      const options = [{ id: 0, name: '全部分类' }].concat(rows.map(c => ({ id: c.id, name: c.name })));
      let catIdx = options.findIndex(o => o.id === Number(this.data.productCategoryFilter || 0));
      let catFilter = this.data.productCategoryFilter || 0;
      if (catIdx < 0) { catIdx = 0; catFilter = 0; }
      this.setData({
        rawCategories: rows,
        categoryNames: rows.map(c => c.name),
        categoryOptions: options,
        productCategoryIndex: catIdx,
        productCategoryFilter: catFilter,
        filteredDishes: this.applyDishFilters(this.data.dishes, catFilter, this.data.productStatusFilter)
      });
    } catch (e) {}
  },
  openCategoryModal: function() {
    this.loadCategories();
    this.setData({
      showCategoryModal: true,
      categoryForm: { id: 0, name: '', sort_order: '0' },
      categorySaving: false
    });
  },
  closeCategoryModal: function() {
    if (this.data.categorySaving) return;
    this.setData({ showCategoryModal: false, categoryForm: { id: 0, name: '', sort_order: '0' } });
  },
  onCategoryFieldInput: function(e) {
    const field = e.currentTarget.dataset.field;
    if (!['name', 'sort_order'].includes(field)) return;
    this.setData({ ['categoryForm.' + field]: e.detail.value });
  },
  editCategoryItem: function(e) {
    const cat = e.currentTarget.dataset.cat;
    if (!cat) return;
    this.setData({
      categoryForm: { id: cat.id, name: cat.name, sort_order: String(cat.sort_order !== undefined ? cat.sort_order : 0) }
    });
  },
  cancelEditCategory: function() {
    this.setData({ categoryForm: { id: 0, name: '', sort_order: '0' } });
  },
  saveCategoryForm: async function() {
    if (this.data.categorySaving) return;
    const f = this.data.categoryForm;
    const name = (f.name || '').trim();
    const sortOrder = f.sort_order === '' ? 0 : Number(f.sort_order);
    if (!name || name.length > 30) {
      return wx.showToast({ title: '请填写1至30字的分类名称', icon: 'none' });
    }
    if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 9999) {
      return wx.showToast({ title: '排序权重须为0至9999整数', icon: 'none' });
    }
    this.setData({ categorySaving: true });
    try {
      if (f.id) {
        await app.api('/api/admin/category/update', 'POST', { id: f.id, name, sort_order: sortOrder });
        wx.showToast({ title: '分类已更新', icon: 'success' });
      } else {
        await app.api('/api/admin/category/add', 'POST', { name, sort_order: sortOrder });
        wx.showToast({ title: '分类已新增', icon: 'success' });
      }
      this.setData({ categoryForm: { id: 0, name: '', sort_order: '0' } });
      await this.loadCategories();
      this.loadDishes();
    } catch (err) {
      wx.showToast({ title: err.message || '保存失败', icon: 'none' });
    } finally {
      this.setData({ categorySaving: false });
    }
  },
  confirmDeleteCategory: function(e) {
    const cat = e.currentTarget.dataset.cat;
    if (!cat || this.data.categorySaving) return;
    wx.showModal({
      title: '确认删除分类？',
      content: `确定删除菜品分类「${cat.name}」吗？若该分类下仍有菜品，需先调整菜品分类后再删。`,
      confirmColor: '#DC2626',
      confirmText: '确认删除',
      success: async r => {
        if (!r.confirm) return;
        this.setData({ categorySaving: true });
        try {
          await app.api('/api/admin/category/delete', 'POST', { id: cat.id });
          wx.showToast({ title: '分类已删除', icon: 'success' });
          if (this.data.categoryForm.id === cat.id) {
            this.setData({ categoryForm: { id: 0, name: '', sort_order: '0' } });
          }
          await this.loadCategories();
          this.loadDishes();
        } catch (err) {
          wx.showToast({ title: err.message || '无法删除该分类', icon: 'none', duration: 2800 });
        } finally {
          this.setData({ categorySaving: false });
        }
      }
    });
  },
  adjustStock: function(e) {
    const id=Number(e.currentTarget.dataset.id);
    const target=(this.data.dishes || []).find(d=>d.id===id);
    if(target){this.openStockModal({currentTarget:{dataset:{dish:target}}});return;}
    wx.showModal({title:'调整本批剩余份数',editable:true,placeholderText:'填写新的可售剩余份数（0至9999）',success:async r=>{
      if(!r.confirm)return;
      try{await app.api('/api/admin/product/stock','POST',{product_id:id,batch_date:this.data.orderDate,batch_time:this.data.config.BATCH_SCHEDULE_TIME,available_qty:Number(r.content)});this.loadDishes();}
      catch(error){wx.showToast({title:error.message,icon:'none'});}
    }});
  },
  openStockModal: function(e) {
    const dish = e.currentTarget.dataset.dish;
    if (!dish) return;
    this.setData({
      showStockModal: true,
      stockTarget: dish,
      stockInputVal: String(dish.stock_qty !== undefined ? dish.stock_qty : 0),
      stockSaving: false
    });
  },
  closeStockModal: function() {
    if (this.data.stockSaving) return;
    this.setData({ showStockModal: false, stockTarget: null });
  },
  onStockInput: function(e) {
    this.setData({ stockInputVal: e.detail.value });
  },
  quickAdjustStock: function(e) {
    const delta = Number(e.currentTarget.dataset.delta);
    const cur = parseInt(this.data.stockInputVal, 10) || 0;
    if (delta === -9999) {
      this.setData({ stockInputVal: '0' });
    } else {
      const next = Math.max(0, Math.min(9999, cur + delta));
      this.setData({ stockInputVal: String(next) });
    }
  },
  saveStockModal: async function() {
    if (this.data.stockSaving || !this.data.stockTarget) return;
    const qty = Number(this.data.stockInputVal);
    if (!Number.isInteger(qty) || qty < 0 || qty > 9999) {
      return wx.showToast({ title: '请输入 0 至 9999 的整数', icon: 'none' });
    }
    this.setData({ stockSaving: true });
    try {
      await app.api('/api/admin/product/stock', 'POST', {
        product_id: this.data.stockTarget.id,
        batch_date: this.data.orderDate,
        batch_time: this.data.config.BATCH_SCHEDULE_TIME,
        available_qty: qty
      });
      wx.showToast({ title: '库存已调整', icon: 'success' });
      this.setData({ showStockModal: false, stockTarget: null });
      this.loadDishes();
    } catch (error) {
      wx.showToast({ title: error.message || '调整失败', icon: 'none' });
    } finally {
      this.setData({ stockSaving: false });
    }
  },
  preparePickup: async function(e) {try{await app.api('/api/admin/order/ready','POST',{order_id:e.currentTarget.dataset.id});this.loadPendingOrders();}catch(error){wx.showToast({title:error.message,icon:'none'});}},
  verifyPickup: function(e) {
    if(this.data.completionBusyId)return;
    const id=Number(e.currentTarget.dataset.id),order=this.data.pendingOrders.find(o=>o.id===id);if(!order)return;
    this.setData({completionBusyId:id});
    wx.showModal({title:'核销取餐',content:`订单 ${order.order_sn}，顾客 ${order.receiver_name}，${order.receiver_phone}。请核对餐品并让顾客出示自提码。`,editable:true,placeholderText:'填写顾客出示的4位自提码',success:r=>{
      if(!r.confirm){this.setData({completionBusyId:null});return;}
      const code=(r.content || '').trim();if(!/^\d{4}$/.test(code)){this.setData({completionBusyId:null});wx.showToast({title:'请填写4位自提码',icon:'none'});return;}
      return this.submitCompletion({order_id:id,pickup_code:code},'取餐已完成');
    },fail:()=>this.setData({completionBusyId:null})});
  },
  confirmDelivery: function(e){
    if(this.data.completionBusyId)return;
    const id=Number(e.currentTarget.dataset.id),order=this.data.pendingOrders.find(o=>o.id===id);if(!order)return;
    this.setData({completionBusyId:id});
    wx.showModal({title:'与顾客核实送达',content:`订单 ${order.order_sn}，顾客 ${order.receiver_name}，${order.receiver_phone}。请先联系顾客确认收到餐品，再填写核实方式及结果；确认后将发放订单奖励。`,editable:true,placeholderText:'例如：电话联系顾客，顾客确认已收到餐品',confirmText:'已核实送达',success:r=>{
      if(!r.confirm){this.setData({completionBusyId:null});return;}
      const note=(r.content || '').trim();if(note.length<2 || note.length>255){this.setData({completionBusyId:null});wx.showToast({title:'说明需2至255字',icon:'none'});return;}
      return this.submitCompletion({order_id:id,delivery_confirmed:true,confirmation_note:note},'已记录送达');
    },fail:()=>this.setData({completionBusyId:null})});
  },
  submitCompletion: async function(body,title){
    try{await app.api('/api/admin/order/complete','POST',body);wx.showToast({title});await this.loadPendingOrders();this.refreshActivity();}
    catch(error){wx.showToast({title:error.message,icon:'none'});}
    finally{this.setData({completionBusyId:null});}
  },
  cancelShopOrder: function(e) {const id=e.currentTarget.dataset.id;wx.showModal({title:'取消并申请退款',content:'确认取消该订单？资金与积分将在退款成功后返回。',success:async r=>{if(!r.confirm)return;try{await app.api('/api/admin/order/cancel','POST',{order_id:id});this.loadPendingOrders();}catch(error){wx.showToast({title:error.message,icon:'none'});}}});},
  refundShopOrder: function(e) {
    if(this.data.refundBusyId)return;
    const id=Number(e.currentTarget.dataset.id),order=this.data.pendingOrders.find(o=>o.id===id);
    if(!order)return;
    this.setData({refundBusyId:id});
    wx.showModal({title:'填写售后退款原因',editable:true,placeholderText:'请填写已与顾客协商的退款原因（2至255字）',success:r=>{
      const reason=(r.content || '').trim();
      if(!r.confirm){this.setData({refundBusyId:null});return;}
      if(reason.length<2 || reason.length>255){this.setData({refundBusyId:null});wx.showToast({title:'退款原因需2至255字',icon:'none'});return;}
      wx.showModal({title:'确认整单售后退款',content:`订单 ${order.order_sn}，申请整单退款（订单金额 ¥${order.final_pay_amount}，实际退回以微信为准），返还已用积分并冲回已发奖励；余额不足的奖励从后续同类奖励抵回。已备好或发出的餐品不自动回到可售库存。原因：${reason}`,confirmText:'申请退款',success:async result=>{
        if(!result.confirm){this.setData({refundBusyId:null});return;}
        try{const data=await app.api('/api/admin/order/refund','POST',{order_id:id,reason});wx.showToast({title:data.payment_state==='REFUNDED'?'已确认退款':'退款处理中',icon:'none'});await this.loadPendingOrders();}
        catch(error){wx.showToast({title:error.message,icon:'none'});}
        finally{this.setData({refundBusyId:null});}
      },fail:()=>this.setData({refundBusyId:null})});
    },fail:()=>this.setData({refundBusyId:null})});
  },

  onPullDownRefresh: function () {
    this.refreshActivity();
    if(this.data.activeTab==='settings'){this.reloadConfigs().finally(()=>wx.stopPullDownRefresh());return;}
    if(this.data.activeTab==='support') {this.loadSupportTickets().finally(()=>wx.stopPullDownRefresh());return;}
    if(this.data.activeTab==='privacy') {this.loadPrivacyRequests().finally(()=>wx.stopPullDownRefresh());return;}
    this.loadDishes();
    this.loadPendingOrders();
    this.loadMembers();
    this.loadConfigs(() => {
      wx.stopPullDownRefresh();
    });
  },

  // 获取真实菜品列表 (带精选老卤兜底)
  applyDishFilters: function(dishes, catId, statusFilter) {
    const list = dishes !== undefined ? dishes : (this.data.dishes || []);
    const cat = catId !== undefined ? catId : (this.data.productCategoryFilter || 0);
    const st = statusFilter !== undefined ? statusFilter : (this.data.productStatusFilter || 'ALL');
    return list.filter(d => {
      if (cat && Number(d.category_id) !== Number(cat)) return false;
      if (st === 'ON' && d.status !== 1) return false;
      if (st === 'OFF' && d.status !== 0) return false;
      if (st === 'LOW' && Number(d.stock_qty) > 5) return false;
      return true;
    });
  },
  changeProductCatFilter: function(e) {
    const idx = Number(e.detail.value);
    const opt = (this.data.categoryOptions || [])[idx];
    const catId = opt ? opt.id : 0;
    this.setData({
      productCategoryIndex: idx >= 0 ? idx : 0,
      productCategoryFilter: catId,
      filteredDishes: this.applyDishFilters(this.data.dishes, catId, this.data.productStatusFilter)
    });
  },
  changeProductStatusFilter: function(e) {
    const st = e.currentTarget.dataset.status;
    this.setData({
      productStatusFilter: st,
      filteredDishes: this.applyDishFilters(this.data.dishes, this.data.productCategoryFilter, st)
    });
  },
  loadDishes: async function(cb) {
    const sequence=this._dishesSequence=(this._dishesSequence || 0)+1;
    const date=this.data.orderDate,time=this.data.config.BATCH_SCHEDULE_TIME;
    this.setData({loading:true});
    try {const rows=await app.api('/api/products?batch_date='+date+'&batch_time='+time);if(sequence===this._dishesSequence){const list=Array.isArray(rows)?rows:[];this.setData({dishes:list,filteredDishes:this.applyDishFilters(list)});}}
    catch(error){if(sequence===this._dishesSequence){this.setData({dishes:[],filteredDishes:[]});wx.showToast({title:error.message,icon:'none'});}}
    finally{if(sequence===this._dishesSequence)this.setData({loading:false});if(cb)cb();}
  },
  loadPendingOrders: async function(append) {
    if(append!==true)append=false;
    if(append && (this.data.orderLoading || !this.data.orderNextCursor))return;
    const sequence=this._ordersSequence=(this._ordersSequence || 0)+1;
    const date=this.data.orderDate,time=this.data.config.BATCH_SCHEDULE_TIME,filter=this.data.orderFilters[this.data.orderFilterIndex];
    this.setData({orderLoading:true,orderError:'',prepError:'',capacityError:''});
    if(!append)this.setData({pendingOrders:[],dispatchableCount:0,orderNextCursor:null,prepSummary:[],prepTotalQty:0,batchCapacity:null});
    try {
      let path='/api/admin/orders?keyword='+encodeURIComponent(this.data.orderKeyword);
      if(!this.data.allOrderDates)path+='&batch_date='+date;
      if(this.data.overduePickupOnly)path+='&overdue_pickup=1';
      if(filter && filter.value)path+='&status='+filter.value;
      if(this.data.orderDeliveryIndex)path+='&delivery_type='+this.data.orderDeliveryIndex;
      if(append&&this.data.orderNextCursor)path+='&before_id='+this.data.orderNextCursor;
      const settle=promise=>promise.then(value=>({status:'fulfilled',value}),reason=>({status:'rejected',reason}));
      const [list,summary,capacity]=await Promise.all([
        app.callContainer({path}).then(res=>{if(!res||res.code!==0)throw new Error((res&&res.msg)||'订单加载失败');return res;}),
        this.data.allOrderDates?Promise.resolve([]):app.api('/api/admin/preparation?batch_date='+date+'&batch_time='+time),
        this.data.allOrderDates?Promise.resolve(null):app.api('/api/admin/batch-capacity?batch_date='+date+'&batch_time='+time)
      ].map(settle));
      if(sequence!==this._ordersSequence)return;
      const titles={10:'待付款',20:'待备餐',25:'待取餐',30:'配送中',40:'已完成',50:'已退款',60:'已取消',70:'退款处理中'};
      const sources={CUSTOMER:'顾客确认收货',ADMIN_PICKUP:'掌柜核销取餐',ADMIN_DELIVERY:'掌柜核实送达'};
      if(list.status==='fulfilled'){
        const merged=(append?this.data.pendingOrders:[]).concat(list.value.data.map(o=>Object.assign({},o,{status_title:titles[o.order_status],completion_title:sources[o.completion_source] || ''})));
        const dispatchable=merged.filter(o=>o.order_status===20 && o.delivery_type===1 && o.payment_state==='PAID').length;
        this.setData({pendingOrders:merged,dispatchableCount:dispatchable,orderNextCursor:list.value.next_cursor});
      }
      else this.setData({orderError:list.reason.message || '订单加载失败'});
      if(summary.status==='fulfilled'){
        const sumList=Array.isArray(summary.value)?summary.value:[];
        const totalQty=sumList.reduce((acc,cur)=>acc+(Number(cur.quantity)||0),0);
        this.setData({prepSummary:sumList,prepTotalQty:totalQty});
      }else this.setData({prepError:summary.reason.message || '备餐汇总加载失败'});
      if(capacity.status==='fulfilled')this.setData({batchCapacity:capacity.value});else this.setData({capacityError:capacity.reason.message || '接单名额加载失败'});
    } catch(error){if(sequence===this._ordersSequence)this.setData({orderError:error.message});}
    finally{if(sequence===this._ordersSequence)this.setData({orderLoading:false});}
  },
  moreOrders: function(){if(this.data.orderNextCursor)this.loadPendingOrders(true);},

  // 一键切换上下架/沽清状态
  toggleProductStatus: function (e) {
    const that = this;
    const dishId = Number(e.currentTarget.dataset.id);
    const newStatus = e.detail.value ? 1 : 0;
    const realIndex = (that.data.dishes || []).findIndex(d => d.id === dishId);

    app.callContainer({
      path: '/api/admin/product/toggle',
      method: 'POST',
      data: {
        product_id: dishId,
        status: newStatus
      }
    }).then(res => {
      if (res && res.code === 0) {
        wx.showToast({
          title: newStatus === 1 ? '已恢复在售' : '已置为售罄沽清',
          icon: 'success'
        });
        const dishes = [...that.data.dishes];
        if (realIndex >= 0) dishes[realIndex] = Object.assign({}, dishes[realIndex], { status: newStatus });
        that.setData({ dishes, filteredDishes: that.applyDishFilters(dishes) });
      } else {
        wx.showToast({ title: res.msg || '切换失败', icon: 'none' });
        const dishes = [...that.data.dishes];
        that.setData({ dishes, filteredDishes: that.applyDishFilters(dishes) });
      }
    }).catch(() => {
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
      const dishes = [...that.data.dishes];
      that.setData({ dishes, filteredDishes: that.applyDishFilters(dishes) });
    });
  },

  // 删除菜品
  confirmDeleteDish: function (e) {
    const that = this;
    const id = e.currentTarget.dataset.id;
    const title = e.currentTarget.dataset.title;

    wx.showModal({
      title: '确认删除菜品？',
      content: `确定从菜单中彻底删除「${title}」？删除后前台顾客将无法看到此菜品。`,
      confirmColor: '#DC2626',
      confirmText: '确认删除',
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '正在删除...' });
          app.callContainer({
            path: '/api/admin/product/delete',
            method: 'POST',
            data: { id }
          }).then(apiRes => {
            wx.hideLoading();
            if (apiRes && apiRes.code === 0) {
              wx.showToast({ title: '已成功删除', icon: 'success' });
              that.loadDishes();
            } else {
              wx.showToast({ title: apiRes.msg || '删除失败', icon: 'none' });
            }
          }).catch(() => {
            wx.hideLoading();
            wx.showToast({ title: '网络异常', icon: 'none' });
          });
        }
      }
    });
  },

  // 打开编辑模态框
  openEditModal: function (e) {
    if(this.data.dishSaving)return;this.resetDishPhoto();
    const dish = e.currentTarget.dataset.dish;
    const list = this.data.rawCategories || [];
    const catIdx = list.findIndex(c => c.id === Number(dish.category_id));
    this.setData({
      showAddModal: true,
      isEditingDish: true,
      dishCategoryIndex: catIdx >= 0 ? catIdx : 0,
      photoCloudCover:typeof dish.cover_img==='string' && dish.cover_img.indexOf('cloud://')===0,
      dishForm: {
        id: dish.id,
        title: dish.title,
        origin_price: dish.origin_price,
        member_price: dish.member_price,
        badge: dish.badge || '手工老卤',
        intro: dish.intro || '', category_id:dish.category_id, cover_img:dish.cover_img, stock_qty:dish.default_stock_qty === undefined ? dish.stock_qty : dish.default_stock_qty, specification:dish.specification, storage_note:dish.storage_note
      }
    });
  },

  // 打开新增模态框
  openAddModal: function () {
    if(this.data.dishSaving)return;this.resetDishPhoto();
    const list = this.data.rawCategories || [];
    const defaultCatId = list[0] ? list[0].id : 1;
    this.setData({
      showAddModal: true,
      isEditingDish: false,
      dishCategoryIndex: 0,
      dishForm: {
        id: 0,
        title: '',
        origin_price: '',
        member_price: '',
        badge: '今日现捞',
        intro: '', category_id:defaultCatId, cover_img:'', stock_qty:0, specification:'', storage_note:''
      }
    });
  },

  closeAddModal: function () {
    if(this.data.dishSaving)return;this.resetDishPhoto();
    this.setData({ showAddModal: false });
  },

  onInputFormTitle: function (e) {
    if(this.data.dishSaving)return;
    this.setData({ 'dishForm.title': e.detail.value });
  },
  onInputFormOriginPrice: function (e) {
    if(this.data.dishSaving)return;
    const val = e.detail.value;
    if (!this.data.isEditingDish) {
      const origin = parseFloat(val) || 0;
      const member = origin > 0 ? (origin * 0.88).toFixed(2) : '';
      this.setData({
        'dishForm.origin_price': val,
        'dishForm.member_price': member
      });
    } else {
      this.setData({ 'dishForm.origin_price': val });
    }
  },
  onInputFormMemberPrice: function (e) {
    if(this.data.dishSaving)return;
    this.setData({ 'dishForm.member_price': e.detail.value });
  },
  onInputFormBadge: function (e) {
    if(this.data.dishSaving)return;
    this.setData({ 'dishForm.badge': e.detail.value });
  },
  onInputFormIntro: function (e) {
    if(this.data.dishSaving)return;
    this.setData({ 'dishForm.intro': e.detail.value });
  },

  // 提交新增或修改菜品
  submitDishForm: function () {
    if(this.data.dishSaving)return;
    if(this.data.photoBusy || this._pendingPhoto){wx.showToast({title:'请先完成图片上传或放弃新照片',icon:'none'});return;}
    const that = this;
    const f = this.data.dishForm;
    if (!f.title || !f.origin_price) {
      wx.showToast({ title: '请填写名称与价格', icon: 'none' });
      return;
    }

    const isEdit = this.data.isEditingDish;
    const epoch=this._dishEpoch;this.setData({dishSaving:true});
    wx.showLoading({ title: isEdit ? '正在保存修改...' : '正在发布上架...' });

    const payload = {
      id: f.id,
      category_id: Number(f.category_id || 1), cover_img:f.cover_img || '', stock_qty:Number(f.stock_qty || 0), specification:f.specification || '', storage_note:f.storage_note || '',
      title: f.title,
      intro: f.intro || '临天八弄纯手工老卤，鲜卤现捞',
      origin_price: parseFloat(f.origin_price),
      member_price: parseFloat(f.member_price || (parseFloat(f.origin_price) * 0.88).toFixed(2)),
      badge: f.badge || '手工老卤'
    };

    const apiPath = isEdit ? '/api/admin/product/update' : '/api/admin/product/add';

    app.callContainer({
      path: apiPath,
      method: 'POST',
      data: payload
    }).then(res => {
      wx.hideLoading();
      if(epoch!==that._dishEpoch)return;that.setData({dishSaving:false});
      if (res && res.code === 0) {
        that.closeAddModal();
        wx.showToast({ title: isEdit ? '修改保存成功！' : '上架成功！', icon: 'success' });
        that.loadDishes();
      } else {
        wx.showToast({ title: (res && res.msg) || '操作失败', icon: 'none' });
      }
    }).catch(() => {
      wx.hideLoading();
      if(epoch!==that._dishEpoch)return;that.setData({dishSaving:false});
      wx.showToast({ title: '请求异常', icon: 'none' });
    });
  },

  // 单独一单发车
  dispatchSingleOrder: function (e) {
    const that = this;
    const orderId = e.currentTarget.dataset.id;
    const order=this.data.pendingOrders.find(o=>o.id===Number(orderId));if(!order)return;
    wx.showLoading({ title: '正在派发...' });

    app.callContainer({
      path: '/api/admin/order/dispatch',
      method: 'POST',
      data: { order_id: orderId, batch_date: order.batch_date, batch_time: order.batch_time }
    }).then(res => {
      wx.hideLoading();
      if (res && res.code === 0) {
        wx.showToast({ title: '该单已发车！', icon: 'success' });
        that.loadPendingOrders();
      } else {
        wx.showToast({ title: res.msg || '派发失败', icon: 'none' });
      }
    }).catch(() => {
      wx.hideLoading();
      wx.showToast({ title: '派发请求失败', icon: 'none' });
    });
  },

  // 调度一键全单发车
  dispatchAllOrders: function () {
    if(this.data.allOrderDates)return;
    const that = this;
    wx.showModal({
      title: '确认一键全单发车？',
      content: `仅处理所选日期 ${this.data.orderDate}、${this.data.config.BATCH_SCHEDULE_TIME} 批次的已付款待备餐自送订单。自提及其他日期订单不受影响。`,
      confirmText: '立即发车',
      confirmColor: '#059669',
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '正在派发全部订单...' });
          app.callContainer({
            path: '/api/admin/order/dispatch',
            method: 'POST',
            data: {batch_date:this.data.orderDate,batch_time:this.data.config.BATCH_SCHEDULE_TIME}
          }).then(apiRes => {
            wx.hideLoading();
            if (apiRes && apiRes.code === 0) {
              wx.showToast({ title: apiRes.msg || '全单发车成功！', icon: 'success' });
              that.loadPendingOrders();
            } else {
              wx.showToast({ title: apiRes.msg || '调度失败', icon: 'none' });
            }
          }).catch(() => {
            wx.hideLoading();
            wx.showToast({ title: '发车调度异常', icon: 'none' });
          });
        }
      }
    });
  },

  // ==================== 掌柜会员管理专属模块 ====================

  // 加载会员列表
  loadMembers: async function (cb, append = false) {
    if (append && (this.data.memberLoading || !this.data.memberNextCursor)) return;
    const sequence = this._memberSequence = (this._memberSequence || 0) + 1;
    const kw = (this.data.memberKeyword || '').trim();
    const isMemberFilter = this.data.memberFilterIsMember;
    let url = '/api/admin/members?keyword=' + encodeURIComponent(kw);
    if (isMemberFilter === '0' || isMemberFilter === '1') url += '&is_member=' + isMemberFilter;
    if (append) url += '&before_id=' + this.data.memberNextCursor;
    this.setData({memberLoading:true, memberError:''});
    try {
      const result = await app.api(url);
      if (sequence !== this._memberSequence) return;
      this.setData({members:(append ? this.data.members : []).concat(result.list),
        memberSummary:result.summary, memberTotal:result.total, memberNextCursor:result.next_cursor});
    } catch(error) {
      if (sequence === this._memberSequence) this.setData({memberError:error.message});
    } finally {
      if (sequence === this._memberSequence) this.setData({memberLoading:false});
      if (cb) cb();
    }
  },
  moreMembers: function () { this.loadMembers(undefined, true); },
  changeMemberFilter: function (e) {
    const filter = String(e.currentTarget.dataset.filter || '');
    if (filter === this.data.memberFilterIsMember) return;
    this.setData({ memberFilterIsMember: filter });
    this.loadMembers();
  },
  openAdjustLogsModal: async function (e) {
    const member = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.member;
    const userId = member ? member.id : '';
    this.setData({
      showAdjustLogsModal: true,
      adjustLogsLoading: true,
      adjustLogs: [],
      adjustLogsMemberName: member ? (member.nickname || '该客官') : '全部客官'
    });
    try {
      const rows = await app.api('/api/admin/member/adjust-logs' + (userId ? '?user_id=' + userId : ''));
      this.setData({ adjustLogs: Array.isArray(rows) ? rows : [] });
    } catch (err) {
      wx.showToast({ title: err.message || '流水加载失败', icon: 'none' });
    } finally {
      this.setData({ adjustLogsLoading: false });
    }
  },
  closeAdjustLogsModal: function () {
    this.setData({ showAdjustLogsModal: false });
  },

  onInputMemberKeyword: function (e) {
    this.setData({ memberKeyword: e.detail.value });
  },

  searchMembers: function () {
    this.loadMembers();
  },

  clearMemberSearch: function () {
    this.setData({ memberKeyword: '' });
    this.loadMembers();
  },

  // 掌柜一键开通/撤销会员身份
  toggleMemberStatus: function (e) {
    const that = this;
    const member = e.currentTarget.dataset.member;
    const targetStatus = member.is_member === 1 ? 0 : 1;
    const actionTxt = targetStatus === 1 ? '开通尊享会员(菜品会员价)' : '撤销会员身份(清空红包)';

    wx.showModal({
      title: '确认调整会员身份？',
      content: `确定为顾客【${member.nickname}】${actionTxt}吗？`,
      confirmText: '确定变更',
      confirmColor: targetStatus === 1 ? '#D9480F' : '#DC2626',
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '处理中...' });
          app.callContainer({
            path: '/api/admin/member/update-status',
            method: 'POST',
            data: {
              user_id: member.id,
              is_member: targetStatus
            }
          }).then(apiRes => {
            wx.hideLoading();
            if (apiRes && apiRes.code === 0) {
              wx.showToast({ title: apiRes.msg || '调整成功', icon: 'success' });
              that.loadMembers();
            } else {
              wx.showToast({ title: apiRes.msg || '操作失败', icon: 'none' });
            }
          }).catch(() => {
            wx.hideLoading();
            wx.showToast({ title: '网络异常', icon: 'none' });
          });
        }
      }
    });
  },

  // 打开积分调整模态框
  openPointsModal: function (e) {
    const member = e.currentTarget.dataset.member;
    this.setData({
      currentMember: member,
      showPointsModal: true,
      pointsForm: {
        adjust_type: 'NORMAL_POINT',
        amount: '',
        reason: '老客回馈/线下消费补录'
      }
    });
  },

  closePointsModal: function () {
    if(this.data.pointsSubmitting)return;
    this.setData({ showPointsModal: false, currentMember: null });
  },

  onSelectPointsType: function (e) {
    const t = e.currentTarget.dataset.type;
    this.setData({ 'pointsForm.adjust_type': t });
  },

  onInputPointsAmount: function (e) {
    this.setData({ 'pointsForm.amount': e.detail.value });
  },

  onInputPointsReason: function (e) {
    this.setData({ 'pointsForm.reason': e.detail.value });
  },

  // 提交人工积分/红包调整
  submitAdjustPoints: async function () {
    if(this.data.pointsSubmitting || !this.data.currentMember)return;
    const form = this.data.pointsForm;
    const member = this.data.currentMember;
    const amt = Number(form.amount);

    if (isNaN(amt) || amt === 0) {
      wx.showToast({ title: '请输入有效变动数值(可填负数)', icon: 'none' });
      return;
    }
    if (form.adjust_type === 'NORMAL_POINT' && !Number.isInteger(amt)) {
      wx.showToast({ title: '普通积分变动须为整数', icon: 'none' });
      return;
    }
    if (!form.reason || !form.reason.trim()) {
      wx.showToast({ title: '请输入调整原因备注', icon: 'none' });
      return;
    }

    const payload={user_id:member.id,adjust_type:form.adjust_type,amount:amt,reason:form.reason.trim()};
    const fingerprint=JSON.stringify(payload), pending=wx.getStorageSync('pandou_pending_adjustment');
    const requestId=pending && pending.fingerprint===fingerprint ? pending.requestId : `adjust_${Date.now()}_${Math.random().toString(36).slice(2,12)}`;
    wx.setStorageSync('pandou_pending_adjustment',{fingerprint,requestId});
    payload.request_id=requestId;
    this.setData({pointsSubmitting:true});
    wx.showLoading({ title: '正在提交调整...', mask:true });
    try {
      await app.api('/api/admin/member/adjust-points','POST',payload);
      wx.removeStorageSync('pandou_pending_adjustment');
      this.setData({showPointsModal:false,currentMember:null});
      wx.showToast({title:'资产调整已完成',icon:'success'});this.loadMembers();
    } catch(error) { wx.showToast({title:error.message || '结果未确认，请重试同一笔调整',icon:'none'}); }
    finally {wx.hideLoading();this.setData({pointsSubmitting:false});}
  },

  // 打开补录推荐人模态框
  openReferrerModal: function (e) {
    const member = e.currentTarget.dataset.member;
    this.setData({
      currentMember: member,
      showReferrerModal: true,
      referrerForm: {
        invite_code: member.referrer_code || ''
      }
    });
  },

  closeReferrerModal: function () {
    this.setData({ showReferrerModal: false, currentMember: null });
  },

  onInputReferrerCode: function (e) {
    this.setData({ 'referrerForm.invite_code': e.detail.value });
  },

  // 提交补录推荐人
  submitBindReferrer: function () {
    const that = this;
    const member = that.data.currentMember;
    const code = (that.data.referrerForm.invite_code || '').trim();

    if (!code) {
      wx.showToast({ title: '请输入推荐人邀请码', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在绑定...' });
    app.callContainer({
      path: '/api/admin/member/bind-referrer',
      method: 'POST',
      data: {
        user_id: member.id,
        referrer_invite_code: code
      }
    }).then(res => {
      wx.hideLoading();
      if (res && res.code === 0) {
        wx.showToast({ title: '绑定成功！', icon: 'success' });
        that.closeReferrerModal();
        that.loadMembers();
      } else {
        wx.showToast({ title: res.msg || '绑定失败', icon: 'none' });
      }
    }).catch(() => {
      wx.hideLoading();
      wx.showToast({ title: '网络异常', icon: 'none' });
    });
  }
});
