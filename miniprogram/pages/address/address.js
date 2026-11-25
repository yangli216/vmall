// miniprogram/pages/address/address.js
const app = getApp();
const addressUtil = require('../../utils/address');

Page({
  data: {
    mode: 'manage', // 'manage' | 'select'
    activeId: '',
    addressList: [],
    deliveryAreas: [],
    shopConfig: {},
    isEditing: false,
    formRangeHint: '',
    formOutOfRange: false,
    form: { id: '', name: '', phone: '', area: '', detail: '', latitude: null, longitude: null, is_default: false }
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
      if (cfg && typeof cfg === 'object') {
        const areas = cfg.DELIVERY_AREAS
          ? String(cfg.DELIVERY_AREAS).split(/[,，\n]/).map(x => x.trim()).filter(Boolean)
          : [];
        this.setData({ shopConfig: cfg, deliveryAreas: areas });
        this.refreshList();
      }
    } catch (e) {}
  },

  refreshList() {
    const cfg = this.data.shopConfig || {};
    const hasConfig = Object.keys(cfg).length > 0;
    const list = addressUtil.getAddressList().map(item => {
      const area = item.area || '';
      const detail = item.detail || '';
      const displayDetail = detail && area && !detail.includes(area) ? `${area} ${detail}` : detail;
      let inRange = true;
      let distanceText = '';
      let rangeWarning = '';
      if (hasConfig && detail) {
        const check = addressUtil.checkDeliveryRange(item, cfg);
        inRange = check.ok;
        if (check.distanceKm !== null) {
          distanceText = `距作坊约 ${check.distanceKm.toFixed(1)} km`;
        }
        if (!check.ok) rangeWarning = check.reason;
      }
      return Object.assign({}, item, { displayDetail, inRange, distanceText, rangeWarning });
    });
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
      if (Object.keys(this.data.shopConfig || {}).length > 0 && target.inRange === false) {
        wx.showToast({ title: target.rangeWarning || '当前地址不在自送范围内，请定位或更换地址', icon: 'none', duration: 2600 });
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
      detail,
      latitude: target.latitude ?? null,
      longitude: target.longitude ?? null
    });

    wx.showToast({ title: '已选用该配送地址', icon: 'success', duration: 1200 });
    setTimeout(() => {
      wx.navigateBack();
    }, 150);
  },

  async importFromWechat() {
    try {
      const record = await addressUtil.importFromWechat(this.data.deliveryAreas);
      this.refreshList();
      if (this.data.mode === 'select') {
        if (!record.matchedWhitelist) {
          this.setData({
            isEditing: true,
            form: Object.assign({}, record, { area: '' })
          });
          wx.showToast({ title: '已导入信息，请选择可自送小区', icon: 'none', duration: 2500 });
          return;
        }
        this.selectAndReturn(record);
      } else {
        wx.showToast({
          title: record.matchedWhitelist ? '已导入微信地址' : '已导入（注意补充配送小区）',
          icon: record.matchedWhitelist ? 'success' : 'none'
        });
      }
    } catch (err) {
      const msg = (err && err.errMsg) || (err && err.message) || '';
      if (/cancel/i.test(msg)) return;
      if (err && err.code === 'INVALID_PHONE' && err.draft) {
        this.setData({
          isEditing: true,
          form: {
            id: '',
            name: err.draft.name || '',
            phone: err.draft.phone || '',
            area: err.draft.area || (this.data.deliveryAreas[0] || ''),
            detail: err.draft.detail || '',
            is_default: this.data.addressList.length === 0
          }
        });
        wx.showToast({ title: '已填入地址，请补充11位手机号', icon: 'none', duration: 2500 });
        return;
      }
      if (/auth deny|authorize/i.test(msg)) {
        wx.showModal({
          title: '未授权获取收货地址',
          content: '请在小程序设置中开启收货地址权限，或直接手动新增地址。',
          confirmText: '去设置',
          success: r => {
            if (r.confirm && typeof wx.openSetting === 'function') wx.openSetting({});
          }
        });
        return;
      }
      wx.showToast({ title: (err && err.message) || '导入失败，请手动新增或地图定位', icon: 'none', duration: 2500 });
    }
  },

  openCreateForm() {
    const defPhone = (app.globalData && app.globalData.userInfo && app.globalData.userInfo.phone) || '';
    const defName = (app.globalData && app.globalData.userInfo && app.globalData.userInfo.nickname) || '';
    this.setData({
      isEditing: true,
      formRangeHint: '',
      formOutOfRange: false,
      form: {
        id: '',
        name: defName && defName !== '食客' && defName !== '潘小兜客官' ? defName : '',
        phone: defPhone,
        area: this.data.deliveryAreas[0] || '',
        detail: '',
        latitude: null,
        longitude: null,
        is_default: this.data.addressList.length === 0
      }
    });
  },

  openEditForm(e) {
    const id = e.currentTarget.dataset.id;
    const target = this.data.addressList.find(a => a.id === id);
    if (!target) return;
    let formRangeHint = '';
    let formOutOfRange = false;
    if (Object.keys(this.data.shopConfig || {}).length > 0 && target.detail) {
      const check = addressUtil.checkDeliveryRange(target, this.data.shopConfig);
      if (check.distanceKm !== null) {
        formRangeHint = check.ok
          ? `📍 当前定位距作坊约 ${check.distanceKm.toFixed(1)} 公里，在自送范围内`
          : `⚠️ ${check.reason}`;
      } else if (!check.ok) {
        formRangeHint = `⚠️ ${check.reason}`;
      }
      formOutOfRange = !check.ok;
    }
    this.setData({
      isEditing: true,
      formRangeHint,
      formOutOfRange,
      form: Object.assign({ latitude: null, longitude: null }, target)
    });
  },

  cancelForm() {
    this.setData({ isEditing: false, formRangeHint: '', formOutOfRange: false });
  },

  onFormInput(e) {
    const field = e.currentTarget.dataset.field;
    if (!['name', 'phone', 'area', 'detail'].includes(field)) return;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  clearField(e) {
    const field = e.currentTarget.dataset.field;
    if (!['name', 'phone', 'area', 'detail'].includes(field)) return;
    const updates = { [`form.${field}`]: '' };
    if (field === 'detail') {
      updates['form.latitude'] = null;
      updates['form.longitude'] = null;
      updates.formRangeHint = '';
      updates.formOutOfRange = false;
    }
    this.setData(updates);
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

      let formRangeHint = '📍 已获取定位坐标，请补充楼幢门牌号';
      let formOutOfRange = false;
      if (Object.keys(this.data.shopConfig || {}).length > 0) {
        const check = addressUtil.checkDeliveryRange({
          area: matchedArea,
          detail: rawAddr,
          latitude: res.latitude,
          longitude: res.longitude
        }, this.data.shopConfig);
        if (check.distanceKm !== null) {
          formRangeHint = check.ok
            ? `📍 已定位（距作坊约 ${check.distanceKm.toFixed(1)} 公里，在自送范围内）`
            : `⚠️ ${check.reason}`;
        } else if (!check.ok) {
          formRangeHint = `⚠️ ${check.reason}`;
        }
        formOutOfRange = !check.ok;
      }

      this.setData({
        'form.area': matchedArea,
        'form.detail': rawAddr,
        'form.latitude': res.latitude,
        'form.longitude': res.longitude,
        formRangeHint,
        formOutOfRange
      });
      wx.showToast({ title: formOutOfRange ? '当前定位超出自送范围' : '已定位，请补充楼幢门牌号', icon: 'none', duration: 2200 });
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

    if (this.data.mode === 'select' && Object.keys(this.data.shopConfig || {}).length > 0) {
      const check = addressUtil.checkDeliveryRange({
        area,
        detail,
        latitude: f.latitude,
        longitude: f.longitude
      }, this.data.shopConfig);
      if (!check.ok) {
        return wx.showToast({ title: check.reason, icon: 'none', duration: 2600 });
      }
    }

    try {
      const saved = addressUtil.saveAddress({
        id: f.id || undefined,
        name,
        phone,
        area,
        detail,
        latitude: f.latitude ?? null,
        longitude: f.longitude ?? null,
        is_default: Boolean(f.is_default)
      });
      this.refreshList();
      this.setData({ isEditing: false, formRangeHint: '', formOutOfRange: false });
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
