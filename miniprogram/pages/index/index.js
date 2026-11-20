const app = getApp();
const { payOrder } = require('../../utils/payment');
const {captureReferral} = require('../../utils/referral');
const addressUtil = require('../../utils/address');
Page({
  data: {
    deliveryType: 2, destAddress: '', receiverName: '', receiverPhone: '', deliveryArea: '',
    currentBatchText: '正在加载可预约批次', slots: [], slotIndex: 0, fullBatchText:'', deliveryAreas: [], config: {},
    categories: [{ id: 0, name: '全部卤味' }, { id: 1, name: '招牌必吃', iconNormal:'/images/category/cat_1.png',iconActive:'/images/category/cat_1_active.png' },
      { id: 2, name: '秘制酱牛肉',iconNormal:'/images/category/cat_2.png',iconActive:'/images/category/cat_2_active.png' },
      { id: 3, name: '麻辣鸭副件',iconNormal:'/images/category/cat_3.png',iconActive:'/images/category/cat_3_active.png' },
      { id: 4, name: '爽脆下酒菜',iconNormal:'/images/category/cat_4.png',iconActive:'/images/category/cat_4_active.png' },{id:5,name:'手工饮品'}],
    currentCatId: 0, allDishes: [], dishes: [], cart: {}, cartList: [], cartCount: 0, cartTotal: '0.00', isDrawerOpen: false,
    orderRemark: '', isMember: false, myReferralCode: '', userNormalPoints: 0, userRedPoints: '0.00', useNormalPoints: false, useRedPoints: false,
    inputRedAmount: '0.00', loadingProducts: true, productError: '', calcError: '', calcReady: false, calculating: false, submitting: false,
    redLimitPercent: 50, calcResult: {}, contactFormOpen: false,
    showAddressPicker: false, addressList: [],
    showContactModal: false, tempReceiverName: '', tempReceiverPhone: ''
  },
  onLoad(options) {
    captureReferral(options);
    this.syncSavedContact(true);
    const saved = wx.getStorageSync('pandou_cart');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) this.data.cart = saved;
  },
  onShow() { this.syncSavedContact();if(wx.getStorageSync('pandou_reorder')) { this.data.cart=wx.getStorageSync('pandou_cart') || {}; wx.removeStorageSync('pandou_reorder'); } this.refresh(); },
  syncSavedContact(force=false) {
    const revision=wx.getStorageSync('pandou_contact_revision') || '';
    if(!force && revision===this._contactRevision)return;
    this._contactRevision=revision;
    const contact=wx.getStorageSync('pandou_contact'),fields={};
    ['receiverName','receiverPhone','destAddress','deliveryArea'].forEach(key=>{fields[key]=contact && typeof contact[key]==='string'?contact[key]:'';});
    this.requestId=null;this.setData(fields);this.invalidateBill();
  },
  onPullDownRefresh() { this.refresh().finally(() => wx.stopPullDownRefresh()); },
  async refresh() {
    if (this.data.submitting) return;
    const sequence = this.refreshSequence = (this.refreshSequence || 0) + 1;
    this.productSequence = (this.productSequence || 0) + 1;
    this.invalidateBill();
    this.setData({ loadingProducts: true, productError: '' });
    try {
      const results = await Promise.all([app.api('/api/batches'), app.api('/api/user/info')]);
      if (sequence !== this.refreshSequence) return;
      const business = results[0], user = results[1], previous = this.data.slots[this.data.slotIndex];
      let slotIndex = previous ? business.slots.findIndex(s => s.date === previous.date && s.time === previous.time) : 0;
      if (slotIndex < 0) slotIndex = 0;
      const fullBatchText=(business.full_batch_labels || []).join('、');
      this.setData({ slots: business.slots, slotIndex,fullBatchText, currentBatchText: business.slots[slotIndex] ? business.slots[slotIndex].label : fullBatchText ? '可预约批次已接满' : '当前暂无可预约批次',
        config: business.config, deliveryAreas: business.delivery_areas, redLimitPercent: Math.round(Number(business.config.RED_PACKET_MAX_DEDUCT_RATIO) * 100),
        isMember: user.is_member === 1, myReferralCode: user.invite_code || '', userNormalPoints: user.normal_points, userRedPoints: user.red_packet_points,
        inputRedAmount: user.red_packet_points });
      const pending = wx.getStorageSync('pandou_pending_referrer');
      if (pending) {
        try { await app.api('/api/user/bind-referrer', 'POST', { invite_code: pending }); wx.removeStorageSync('pandou_pending_referrer'); wx.showToast({ title: '已绑定推荐好友', icon: 'success' }); }
        catch (error) { if ([400,403,409].includes(error.code)) wx.removeStorageSync('pandou_pending_referrer'); wx.showToast({ title: error.message, icon: 'none' }); }
      }
      if (sequence !== this.refreshSequence) return;
      await this.fetchProductList();
    } catch (error) {
      if (sequence !== this.refreshSequence) return;
      this.setData({ loadingProducts: false, productError: error.message, allDishes: [], dishes: [] });
    }
  },
  async fetchProductList() {
    const sequence = this.productSequence = (this.productSequence || 0) + 1;
    this.invalidateBill();
    this.setData({loadingProducts:true});
    const slot = this.data.slots[this.data.slotIndex];
    const query = slot ? `?batch_date=${slot.date}&batch_time=${slot.time}` : '';
    try {
      const list = await app.api('/api/products' + query);
      if (sequence !== this.productSequence) return;
      this.setData({ allDishes: list, loadingProducts: false, productError: '' });
      this.filterDishes();
      const cart = {};
      Object.keys(this.data.cart).forEach(id => {
        const dish = list.find(p => p.id === Number(id)), old = this.data.cart[id];
        if (dish && dish.status === 1 && dish.stock_qty > 0 && old && Number.isSafeInteger(old.quantity) && old.quantity > 0) cart[id] = { id: dish.id, dish, quantity: Math.min(old.quantity, dish.stock_qty, 99) };
      });
      this.updateCartState(cart);
    } catch (error) { if (sequence === this.productSequence) this.setData({ loadingProducts: false, productError: error.message, allDishes: [], dishes: [], calcReady: false }); }
  },
  invalidateBill() { this.calcSequence = (this.calcSequence || 0) + 1; this.setData({calcReady:false, calculating:false, calcResult:{}}); },
  changeSlot(e) { if(this.data.submitting)return; const index = Number(e.detail.value); if(!this.data.slots[index])return; this.setData({ slotIndex: index, currentBatchText: this.data.slots[index].label }); this.fetchProductList(); },
  filterDishes() { this.setData({ dishes: this.data.currentCatId === 0 ? this.data.allDishes : this.data.allDishes.filter(p => p.category_id === this.data.currentCatId) }); },
  selectCategory(e) { this.setData({ currentCatId: Number(e.currentTarget.dataset.id) }); this.filterDishes(); },
  changeDelType(e) { if(this.data.submitting)return; this.invalidateBill(); this.setData({ deliveryType: Number(e.currentTarget.dataset.type) }); if (this.data.isDrawerOpen) this.calculateBill(); },
  updateCartState(cart) {
    this.invalidateBill();
    let count = 0, total = 0;
    const list = Object.keys(cart).map(id => cart[id]);
    list.forEach(item => { count += item.quantity; total += Math.round(Number(this.data.isMember ? item.dish.member_price : item.dish.origin_price) * 100) * item.quantity; });
    this.setData({ cart, cartList: list, cartCount: count, cartTotal: (total / 100).toFixed(2), calcReady: false });
    wx.setStorageSync('pandou_cart', cart);
    this.requestId = null;
    if (!count) this.setData({ isDrawerOpen: false }); else if (this.data.isDrawerOpen) this.calculateBill();
  },
  addToCart(e) {
    if (this.data.submitting || this.data.loadingProducts) return;
    const dish = e.currentTarget.dataset.dish, cart = Object.assign({}, this.data.cart), quantity = (cart[dish.id] ? cart[dish.id].quantity : 0) + 1;
    if (!this.data.slots.length || this.data.productError) return wx.showToast({ title: '当前不可下单，请刷新后再试', icon: 'none' });
    if (dish.status !== 1 || quantity > dish.stock_qty || quantity > 99) return wx.showToast({ title: '剩余份数不足', icon: 'none' });
    cart[dish.id] = { id: dish.id, dish, quantity }; this.updateCartState(cart);
  },
  decreaseCart(e) { if(this.data.submitting)return; const id = e.currentTarget.dataset.dish.id, cart = Object.assign({}, this.data.cart); if (!cart[id]) return; cart[id] = Object.assign({}, cart[id], { quantity: cart[id].quantity - 1 }); if (!cart[id].quantity) delete cart[id]; this.updateCartState(cart); },
  clearCart() { if(this.data.submitting)return; wx.showModal({ title: '清空购物车', content: '确认清空已选菜品？', success: r => { if (r.confirm && !this.data.submitting) this.updateCartState({}); } }); },
  openCheckoutSheet() {
    if (!this.data.cartCount || !this.data.slots.length) return wx.showToast({ title: '请先选择批次和菜品', icon: 'none' });
    if (this.data.deliveryType === 1 && !this.data.destAddress) {
      const def = addressUtil.getDefaultAddress();
      if (def) {
        const address = def.detail || '';
        const matchedArea = this.data.deliveryAreas.find(a => address.includes(a) || (def.area && def.area.includes(a))) || def.area || '';
        this.setData({
          destAddress: address,
          receiverName: def.name || '',
          receiverPhone: def.phone || '',
          deliveryArea: matchedArea
        });
        this.saveContact();
      }
    }
    this.setData({ isDrawerOpen: true });
    this.calculateBill();
  },
  closeCheckoutSheet() { if (!this.data.submitting) this.setData({ isDrawerOpen: false }); },
  editAddress() {
    if (this.data.submitting) return;
    if (this.data.deliveryType === 2) { this.setData({ isDrawerOpen: this.data.cartCount > 0 }); return; }
    const list = addressUtil.getAddressList();
    if (list.length > 0) {
      this.openAddressPicker();
    } else {
      this.importAddressFromWechat();
    }
  },
  openAddressPicker() {
    if (this.data.submitting) return;
    const list = addressUtil.getAddressList();
    this.setData({ addressList: list, showAddressPicker: true });
  },
  closeAddressPicker() {
    this.setData({ showAddressPicker: false });
  },
  openContactModal() {
    if (this.data.submitting) return;
    this.setData({
      showContactModal: true,
      tempReceiverName: this.data.receiverName || '',
      tempReceiverPhone: this.data.receiverPhone || ''
    });
  },
  closeContactModal() {
    this.setData({ showContactModal: false });
  },
  onTempNameInput(e) {
    this.setData({ tempReceiverName: e.detail.value });
  },
  onTempPhoneInput(e) {
    this.setData({ tempReceiverPhone: e.detail.value });
  },
  saveContactModal() {
    const name = (this.data.tempReceiverName || '').trim();
    const phone = (this.data.tempReceiverPhone || '').trim();
    if (!name) return wx.showToast({ title: '请填写联系人姓名', icon: 'none' });
    if (!/^1[3-9]\d{9}$/.test(phone)) return wx.showToast({ title: '请填写11位有效手机号', icon: 'none' });
    this.setData({
      receiverName: name,
      receiverPhone: phone,
      showContactModal: false
    });
    this.saveContact();
    this.invalidateBill();
    wx.showToast({ title: '联系信息已更新', icon: 'success' });
  },
  preventTouchMove() {},
  stopBubble() {},
  selectAddress(e) {
    if (this.data.submitting) return;
    const id = e.currentTarget.dataset.id;
    const target = this.data.addressList.find(a => a.id === id);
    if (!target) return;
    const address = target.detail || '';
    const matchedArea = this.data.deliveryAreas.find(a => address.includes(a) || (target.area && target.area.includes(a))) || target.area || '';
    this.setData({
      destAddress: address,
      receiverName: target.name || '',
      receiverPhone: target.phone || '',
      deliveryArea: matchedArea,
      showAddressPicker: false
    });
    this.requestId = null;
    this.saveContact();
    this.invalidateBill();
    wx.showToast({ title: '已选择地址', icon: 'success' });
  },
  async importAddressFromWechat() {
    if (this.data.submitting) return;
    try {
      const record = await addressUtil.importFromWechat();
      const list = addressUtil.getAddressList();
      const address = record.detail || '';
      const matchedArea = this.data.deliveryAreas.find(a => address.includes(a)) || record.area || '';
      this.setData({
        addressList: list,
        destAddress: address,
        receiverName: record.name,
        receiverPhone: record.phone,
        deliveryArea: matchedArea,
        showAddressPicker: false
      });
      this.requestId = null;
      this.saveContact();
      this.invalidateBill();
      wx.showToast({ title: '已导入微信地址', icon: 'success' });
    } catch (err) {
      if (!/cancel/i.test(err.errMsg || '')) {
        wx.showToast({ title: '未获取到微信地址', icon: 'none' });
      }
    }
  },
  onContactInput(e) { if(this.data.submitting)return; const field = e.currentTarget.dataset.field; if (!['receiverName','receiverPhone','destAddress'].includes(field)) return; this.setData({ [field]: e.detail.value }); this.requestId = null; this.saveContact(); },
  onAreaChange(e) { if(this.data.submitting)return; this.setData({ deliveryArea: this.data.deliveryAreas[Number(e.detail.value)] }); this.requestId = null; this.saveContact(); },
  saveContact() { wx.setStorageSync('pandou_contact', { receiverName: this.data.receiverName, receiverPhone: this.data.receiverPhone, destAddress: this.data.destAddress, deliveryArea: this.data.deliveryArea }); },
  toggleNormalPoints(e) { if(this.data.submitting)return; this.setData({ useNormalPoints: e.detail.value }); this.calculateBill(); },
  toggleRedPoints(e) { if(this.data.submitting)return; this.setData({ useRedPoints: e.detail.value }); this.calculateBill(); },
  onRedAmountChange(e) { if(this.data.submitting)return; this.setData({ inputRedAmount: e.detail.value }); this.calculateBill(); },
  onRemarkInput(e) { if(this.data.submitting)return; this.setData({ orderRemark: e.detail.value }); this.requestId = null; },
  payload() {
    const slot = this.data.slots[this.data.slotIndex];
    return { items: this.data.cartList.map(item => ({ product_id: item.id, quantity: item.quantity })), delivery_type: this.data.deliveryType,
      batch_date: slot && slot.date, batch_time: slot && slot.time, use_normal_points: this.data.useNormalPoints, use_red_packet_points: this.data.useRedPoints,
      custom_red_amount: this.data.inputRedAmount || '0.00' };
  },
  async calculateBill() {
    if(this.data.submitting)return;
    const seq = (this.calcSequence || 0) + 1; this.calcSequence = seq; this.requestId = null;
    this.setData({ calcReady: false, calculating: true, calcError: '' });
    try {
      const result = await app.api('/api/order/calculate', 'POST', this.payload());
      if (this.calcSequence === seq) this.setData({ calcReady: true, calculating: false, calcResult: result });
    } catch (error) { if (this.calcSequence === seq) this.setData({ calcReady: false, calculating: false, calcError: error.message }); }
  },
  async submitOrderPay() {
    if (this.data.submitting || !this.data.calcReady) return;
    const receiverName = (this.data.receiverName || '').trim() || (this.data.deliveryType === 2 ? '自提顾客' : '');
    const receiverPhone = (this.data.receiverPhone || '').trim();
    if (this.data.deliveryType === 1) {
      if (!this.data.destAddress || !receiverName || !/^1[3-9]\d{9}$/.test(receiverPhone)) {
        wx.showToast({ title: '请选择或完善配送地址', icon: 'none' });
        this.openAddressPicker();
        return;
      }
      if (!this.data.deliveryArea || !this.data.destAddress.includes(this.data.deliveryArea)) {
        return wx.showToast({ title: '收货地址需在配送支持的小区内', icon: 'none' });
      }
    } else {
      if (!/^1[3-9]\d{9}$/.test(receiverPhone)) {
        return wx.showToast({ title: '请填写提货有效手机号', icon: 'none' });
      }
    }
    const payload = Object.assign(this.payload(), {
      receiver_name: receiverName,
      receiver_phone: receiverPhone,
      receiver_address: this.data.deliveryType === 1 ? this.data.destAddress : (this.data.config.WORKSHOP_ADDRESS || ''),
      delivery_area: this.data.deliveryArea || '',
      order_remark: this.data.orderRemark || '',
      expected_pay_amount: this.data.calcResult.final_pay_amount
    });
    // Preserve the same key for a retry after a lost response, including across app restarts.
    const fingerprint = JSON.stringify(payload), pending = wx.getStorageSync('pandou_pending_checkout');
    this.requestId = pending && pending.fingerprint === fingerprint ? pending.requestId : `order_${Date.now()}_${Math.random().toString(36).slice(2,12)}`;
    wx.setStorageSync('pandou_pending_checkout', { fingerprint, requestId: this.requestId });
    payload.request_id = this.requestId;
    this.setData({ submitting: true }); wx.showLoading({ title: '正在创建订单' });
    let created = false;
    try {
      const order = await app.api('/api/order/create', 'POST', payload); created = true;
      wx.removeStorageSync('pandou_pending_checkout');
      wx.hideLoading();
      this.updateCartState({});
      const result = await payOrder(order.order_id);
      wx.showToast({ title: result.confirmed ? '付款已确认，等待备餐' : result.refunding ? '订单已取消，退款处理中' : '支付结果确认中，请查看订单', icon: 'none' });
    } catch (error) {
      wx.hideLoading(); wx.showToast({ title: error.message, icon: 'none', duration: 3000 });
      if (!created && error.code === 409) {
        this.setData({submitting:false}); this.invalidateBill(); await this.refresh();
      }
    }
    finally {
      this.setData({ submitting: false });
      if (created) wx.switchTab({ url: '/pages/order/order' });
    }
  },
  showDishDetail(e) { const p=e.currentTarget.dataset.dish; wx.showModal({ title:p.title, content:`${p.specification || '份量见菜品名称'}\n${p.intro || ''}\n${p.storage_note || '保存及食用方式请咨询掌柜'}\n本批剩余：${p.stock_qty}份`,showCancel:false }); },
  onImageError(e) { this.setData({ [`dishes[${e.currentTarget.dataset.index}].cover_img`]: '' }); },
  showRules() { wx.navigateTo({url:'/pages/rules/rules'}); },
  copyShopAddress(){require('../../utils/copy-address').copyAddress(this.data.config.WORKSHOP_ADDRESS);},
  navToMember() { wx.switchTab({ url: '/pages/member/member' }); },
  onShareAppMessage() {
    const code = this.data.isMember && this.data.myReferralCode;
    return {
      title: '潘小兜老卤 · 预约现做，会员享菜品专属价',
      path: code ? `/pages/index/index?referrer=${encodeURIComponent(code)}` : '/pages/index/index'
    };
  },
  onShareTimeline() {
    const code = this.data.isMember && this.data.myReferralCode;
    return {
      title: '潘小兜老卤 · 预约现做，新鲜现卤到店自提或周边自送',
      query: code ? `referrer=${encodeURIComponent(code)}` : ''
    };
  }
});
