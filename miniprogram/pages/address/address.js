// miniprogram/pages/address/address.js
const app = getApp();
const addressUtil = require('../../utils/address');

Page({
  data: {
    mode: 'manage', // 'manage' | 'select'
    activeId: '',
    addressList: [],
    deliveryAreas: [],
    isEditing: false,
    form: { id: '', name: '', phone: '', area: '', detail: '', is_default: false }
  },

  onLoad(options) {
    const mode = options && options.mode === 'select' ? 'select' : 'manage';
    const activeId = (options && options.activeId) || '';
    this.setData({ mode, activeId });
    this.loadDeliveryAreas();
  },

  onShow() {
    this.refreshList();
  },

  async loadDeliveryAreas() {
    try {
      const cfg = await app.api('/api/config/all');
      if (cfg && cfg.DELIVERY_AREAS) {
        const areas = String(cfg.DELIVERY_AREAS)
          .split(/[,，\n]/)
          .map(x => x.trim())
          .filter(Boolean);
        this.setData({ deliveryAreas: areas });
      }
    } catch (e) {}
  },

  refreshList() {
    const list = addressUtil.getAddressList();
    let activeId = this.data.activeId;
    if (this.data.mode === 'select' && !activeId) {
      const contact = wx.getStorageSync(addressUtil.CONTACT_KEY);
      if (contact && contact.destAddress) {
        const hit = list.find(a => a.detail === contact.destAddress && a.name === contact.receiverName);
        if (hit) activeId = hit.id;
      }
    }
    this.setData({ addressList: list, activeId });
  },

  // 列表卡片点击
  onCardTap(e) {
    const id = e.currentTarget.dataset.id;
    const target = this.data.addressList.find(a => a.id === id);
    if (!target) return;

    if (this.data.mode === 'select') {
      if (!target.detail || !target.phone || !/^1[3-9]\d{9}$/.test(target.phone)) {
        wx.showToast({ title: '请先完善该地址的门牌和手机号', icon: 'none' });
        this.openEditForm({ currentTarget: { dataset: { id } } });
        return;
      }
      this.selectAndReturn(target);
    } else {
      addressUtil.setDefaultAddress(id);
      this.refreshList();
      wx.showToast({ title: '已设为默认地址', icon: 'success' });
    }
  },

  selectAndReturn(target) {
    const areas = this.data.deliveryAreas || [];
    const matchedArea = areas.find(a =>
      (target.area && target.area.includes(a)) || (target.detail && target.detail.includes(a))
    ) || target.area || '';
    const detail = matchedArea && target.detail && !target.detail.includes(matchedArea)
      ? `${matchedArea} ${target.detail}`
      : (target.detail || '');

    addressUtil.syncToContact({
      name: target.name,
      phone: target.phone,
      area: matchedArea,
      detail
    });

    wx.showToast({ title: '已选用该配送地址', icon: 'success', duration: 1200 });
    setTimeout(() => {
      wx.navigateBack();
    }, 150);
  },

  async importFromWechat() {
    try {
      const record = await addressUtil.importFromWechat();
      this.refreshList();
      if (this.data.mode === 'select') {
        this.selectAndReturn(record);
      } else {
        wx.showToast({ title: '已导入微信地址', icon: 'success' });
      }
    } catch (err) {
      if (!/cancel/i.test((err && err.errMsg) || (err && err.message) || '')) {
        wx.showToast({ title: '未获取到微信地址', icon: 'none' });
      }
    }
  },

  openCreateForm() {
    const defPhone = (app.globalData && app.globalData.userInfo && app.globalData.userInfo.phone) || '';
    const defName = (app.globalData && app.globalData.userInfo && app.globalData.userInfo.nickname) || '';
    this.setData({
      isEditing: true,
      form: {
        id: '',
        name: defName && defName !== '食客' && defName !== '潘小兜客官' ? defName : '',
        phone: defPhone,
        area: this.data.deliveryAreas[0] || '',
        detail: '',
        is_default: this.data.addressList.length === 0
      }
    });
  },

  openEditForm(e) {
    const id = e.currentTarget.dataset.id;
    const target = this.data.addressList.find(a => a.id === id);
    if (!target) return;
    this.setData({
      isEditing: true,
      form: Object.assign({}, target)
    });
  },

  cancelForm() {
    this.setData({ isEditing: false });
  },

  onFormInput(e) {
    const field = e.currentTarget.dataset.field;
    if (!['name', 'phone', 'area', 'detail'].includes(field)) return;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  clearField(e) {
    const field = e.currentTarget.dataset.field;
    if (!['name', 'phone', 'area', 'detail'].includes(field)) return;
    this.setData({ [`form.${field}`]: '' });
  },

  pickWhitelistArea(e) {
    const area = e.currentTarget.dataset.area || '';
    this.setData({ 'form.area': area });
  },

  onDefaultSwitch(e) {
    this.setData({ 'form.is_default': Boolean(e.detail.value) });
  },

  async locateOnMap() {
    try {
      const res = await addressUtil.chooseLocation();
      const poiName = res.name || '';
      const rawAddr = res.detail || res.cleanAddress || '';
      const matchedArea = (this.data.deliveryAreas || []).find(a =>
        (rawAddr + ' ' + poiName).includes(a)
      ) || poiName || this.data.form.area || '';

      this.setData({
        'form.area': matchedArea,
        'form.detail': rawAddr
      });
      wx.showToast({ title: '已定位，请补充楼幢门牌号', icon: 'none', duration: 2200 });
    } catch (err) {
      if (!/cancel/i.test((err && err.message) || (err && err.errMsg) || '')) {
        wx.showToast({ title: '定位未完成或未授权', icon: 'none' });
      }
    }
  },

  saveForm() {
    const f = this.data.form;
    const name = (f.name || '').trim();
    const phone = (f.phone || '').trim();
    const area = (f.area || '').trim();
    let detail = (f.detail || '').trim();

    if (!name) return wx.showToast({ title: '请填写收货人姓名', icon: 'none' });
    if (!/^1[3-9]\d{9}$/.test(phone)) return wx.showToast({ title: '请填写11位有效手机号', icon: 'none' });
    if (!detail) return wx.showToast({ title: '请填写详细楼幢门牌号', icon: 'none' });

    if (area && !detail.includes(area)) {
      detail = `${area} ${detail}`;
    }

    try {
      const saved = addressUtil.saveAddress({
        id: f.id || undefined,
        name,
        phone,
        area,
        detail,
        is_default: Boolean(f.is_default)
      });
      this.refreshList();
      this.setData({ isEditing: false });
      if (this.data.mode === 'select') {
        this.selectAndReturn(saved);
      } else {
        wx.showToast({ title: '地址已保存', icon: 'success' });
      }
    } catch (err) {
      wx.showToast({ title: err.message || '保存失败', icon: 'none' });
    }
  },

  deleteCurrent() {
    const id = this.data.form.id;
    if (!id) return;
    wx.showModal({
      title: '确认删除地址？',
      content: '删除后无法恢复。',
      confirmColor: '#DC2626',
      success: r => {
        if (r.confirm) {
          addressUtil.deleteAddress(id);
          this.refreshList();
          this.setData({ isEditing: false });
          wx.showToast({ title: '已删除', icon: 'none' });
        }
      }
    });
  }
});
