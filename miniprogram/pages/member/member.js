const app = getApp();
const addressUtil = require('../../utils/address');

Page({
  data: {
    loading: false,
    userInfo: { nickname: '食客', normal_points: 0, red_packet_points: '0.00' },
    isMember: false,
    progressPercent: 0,
    config: { MEMBER_ENTRY_MODE: 'CONSUME', MEMBER_ENTRY_THRESHOLD: '68.00', COMMISSION_RATE: '0.03' },
    error: '',
    localDevelopment: false,
    switchingTestAccount: false,
    showTimelineGuide: false,

    // 每日签到
    signInInfo: { is_signed_today: false, continuous_days: 0, reward_points: 10 },
    signingIn: false,

    // 微信资料授权与会员注册弹窗
    showProfileModal: false,
    editAvatarUrl: '',
    editNickname: '',
    editPhone: '',
    profileSubmitting: false,

    // 配送地址管理
    showAddressModal: false,
    showAddressEditModal: false,
    addressList: [],
    defaultAddressSummary: '',
    addressForm: { id: '', name: '', phone: '', area: '', detail: '', is_default: false },
    addressSaving: false
  },

  onShow() {
    this.setData({
      localDevelopment: app.globalData.allowLocalDev === true && app.globalData.runtimeVersion === 'develop'
    });
    this.loadData();
    this.refreshAddressSummary();
    if (app.globalData && app.globalData.openAddressManager) {
      app.globalData.openAddressManager = false;
      this.openAddressManager();
    }
  },

  onPullDownRefresh() {
    Promise.all([this.loadData(), Promise.resolve(this.refreshAddressSummary())])
      .finally(() => wx.stopPullDownRefresh());
  },

  refreshAddressSummary() {
    const list = addressUtil.getAddressList();
    const def = addressUtil.getDefaultAddress();
    let summary = '暂无已保存地址，支持微信一键导入';
    if (def) {
      summary = `${def.name} ${def.phone ? def.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : ''} · ${def.detail}`;
    }
    this.setData({ addressList: list, defaultAddressSummary: summary });
  },

  async switchTestAccount(event) {
    if (!this.data.localDevelopment || this.data.switchingTestAccount) return;
    this.setData({ switchingTestAccount: true });
    try {
      const result = await app.api('/api/dev/accounts');
      const openid = event && event.currentTarget && event.currentTarget.dataset.openid;
      const account = result.accounts.find(x => x.openid === openid);
      if (!account) return;
      wx.setStorageSync('pandou_local_user_openid', account.openid);
      app.globalData.devOpenid = account.openid;
      app.globalData.userInfo = null;
      wx.removeStorageSync('pandou_pending_referrer');
      wx.reLaunch({ url: '/pages/member/member' });
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' });
    } finally {
      this.setData({ switchingTestAccount: false });
    }
  },

  async loadData() {
    this.setData({ loading: true, error: '' });
    try {
      const [u, c, signRes] = await Promise.all([
        app.api('/api/user/info'),
        app.api('/api/config/all'),
        app.api('/api/user/signin-status').catch(() => null)
      ]);
      const threshold = Number(c.MEMBER_ENTRY_THRESHOLD), total = Number(u.total_consumption);
      this.setData({
        userInfo: u,
        isMember: u.is_member === 1,
        config: c,
        progressPercent: threshold > 0 ? Math.min(100, Math.floor(total / threshold * 100)) : 100,
        signInInfo: signRes || this.data.signInInfo
      });
    } catch (error) {
      this.setData({ error: error.message });
      wx.showToast({ title: error.message, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  async handleDailySignIn() {
    if (this.data.signingIn || this.data.signInInfo.is_signed_today) return;
    this.setData({ signingIn: true });
    try {
      const res = await app.api('/api/user/signin', 'POST', {});
      wx.showToast({
        title: `🎉 签到成功 +${res.points_earned || 10}分`,
        icon: 'success',
        duration: 2500
      });
      this.setData({
        'signInInfo.is_signed_today': true,
        'signInInfo.continuous_days': res.continuous_days,
        'userInfo.normal_points': res.total_normal_points
      });
      this.loadData();
    } catch (err) {
      wx.showToast({
        title: err.message || '签到失败',
        icon: 'none'
      });
    } finally {
      this.setData({ signingIn: false });
    }
  },

  // 打开会员注册/微信资料授权弹窗
  openRegisterModal() {
    const u = this.data.userInfo || {};
    this.setData({
      showProfileModal: true,
      editAvatarUrl: u.avatar_url || '',
      editNickname: (u.nickname && u.nickname !== '潘小兜客官' && u.nickname !== '食客') ? u.nickname : '',
      editPhone: u.phone || ''
    });
  },

  closeProfileModal() {
    if (this.data.profileSubmitting) return;
    this.setData({ showProfileModal: false });
  },

  // 微信原生选择头像
  onChooseAvatar(e) {
    const avatarUrl = e && e.detail && e.detail.avatarUrl;
    if (avatarUrl) {
      this.setData({ editAvatarUrl: avatarUrl });
    }
  },

  onNicknameChange(e) {
    this.setData({ editNickname: (e.detail.value || '').trim() });
  },

  onNicknameBlur(e) {
    this.setData({ editNickname: (e.detail.value || '').trim() });
  },

  onPhoneInput(e) {
    this.setData({ editPhone: (e.detail.value || '').trim() });
  },

  // 提交个人资料并注册/激活会员
  async submitProfileAndRegister() {
    if (this.data.profileSubmitting) return;
    const nickname = this.data.editNickname || '临安街坊';
    const avatarUrl = this.data.editAvatarUrl || '';
    const phone = this.data.editPhone || '';

    if (phone && !/^1[3-9]\d{9}$/.test(phone)) {
      return wx.showToast({ title: '请输入正确的11位手机号', icon: 'none' });
    }

    this.setData({ profileSubmitting: true });
    try {
      const payload = { nickname };
      if (avatarUrl) payload.avatar_url = avatarUrl;
      if (phone) payload.phone = phone;

      await app.api('/api/user/update-profile', 'POST', payload);

      // 如果当前是非会员且支持免费激活，则一键开通
      if (!this.data.isMember && this.data.config.MEMBER_ENTRY_MODE === 'FREE') {
        await app.api('/api/user/activate-free', 'POST');
      }

      wx.showToast({ title: '保存成功', icon: 'success' });
      this.setData({ showProfileModal: false });
      await this.loadData();
    } catch (err) {
      wx.showToast({ title: err.message || '保存失败', icon: 'none' });
    } finally {
      this.setData({ profileSubmitting: false });
    }
  },

  // 快捷免费开通会员
  async activateFreeMember() {
    this.openRegisterModal();
  },

  confirmExitMember() {
    wx.showModal({
      title: '确认退出会员？',
      content: `退出后恢复原价，停止推荐奖励；现有红包余额 ¥${this.data.userInfo.red_packet_points} 将清零，普通积分保留。请先处理完进行中的订单，退出后不会自动再次入会。`,
      confirmText: '确认退出',
      success: async r => {
        if (!r.confirm) return;
        try {
          await app.api('/api/user/exit-member', 'POST', { confirm_clear_red: true });
          await this.loadData();
        } catch (error) {
          wx.showToast({ title: error.message, icon: 'none' });
        }
      }
    });
  },

  // ---------------- 配送地址自行维护 ----------------
  openAddressManager() {
    this.refreshAddressSummary();
    this.setData({ showAddressModal: true });
  },

  closeAddressManager() {
    this.setData({ showAddressModal: false });
  },

  async importWechatAddress() {
    try {
      const record = await addressUtil.importFromWechat();
      wx.showToast({ title: '已从微信导入地址', icon: 'success' });
      this.refreshAddressSummary();
    } catch (err) {
      if (!/cancel/i.test(err.errMsg || '')) {
        wx.showToast({ title: '未获取到微信地址', icon: 'none' });
      }
    }
  },

  async chooseLocationForAddAddress() {
    try {
      const res = await addressUtil.chooseLocation();
      const poiName = res.name || '';
      const address = res.detail || res.cleanAddress || '';
      const u = this.data.userInfo || {};
      this.setData({
        showAddressEditModal: true,
        addressForm: {
          id: '',
          name: u.name || u.nickname || '',
          phone: u.phone || '',
          area: poiName || res.area || '临安锦城',
          detail: address,
          is_default: this.data.addressList.length === 0
        }
      });
      wx.showToast({ title: '已定位，请补充门牌号', icon: 'none', duration: 2500 });
    } catch (err) {
      if (!/cancel/i.test((err && err.message) || (err && err.errMsg) || '')) {
        wx.showToast({ title: '定位未完成或未授权', icon: 'none' });
      }
    }
  },

  async chooseLocationForForm() {
    try {
      const res = await addressUtil.chooseLocation();
      const poiName = res.name || '';
      const address = res.detail || res.cleanAddress || '';
      this.setData({
        'addressForm.area': poiName || res.area || this.data.addressForm.area || '临安锦城',
        'addressForm.detail': address
      });
      wx.showToast({ title: '已定位，请补充门牌号', icon: 'none', duration: 2500 });
    } catch (err) {
      if (!/cancel/i.test((err && err.message) || (err && err.errMsg) || '')) {
        wx.showToast({ title: '定位未完成或未授权', icon: 'none' });
      }
    }
  },

  openAddAddressModal() {
    this.setData({
      showAddressEditModal: true,
      addressForm: { id: '', name: '', phone: this.data.userInfo.phone || '', area: '临安锦城', detail: '', is_default: this.data.addressList.length === 0 }
    });
  },

  openEditAddressModal(e) {
    const id = e.currentTarget.dataset.id;
    const target = this.data.addressList.find(a => a.id === id);
    if (!target) return;
    this.setData({
      showAddressEditModal: true,
      addressForm: Object.assign({}, target)
    });
  },

  closeAddressEditModal() {
    if (this.data.addressSaving) return;
    this.setData({ showAddressEditModal: false });
  },

  onAddressFormInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`addressForm.${field}`]: e.detail.value });
  },

  onAddressDefaultSwitch(e) {
    this.setData({ ['addressForm.is_default']: Boolean(e.detail.value) });
  },

  saveAddressRecord() {
    if (this.data.addressSaving) return;
    try {
      this.setData({ addressSaving: true });
      addressUtil.saveAddress(this.data.addressForm);
      wx.showToast({ title: '地址已保存', icon: 'success' });
      this.setData({ showAddressEditModal: false });
      this.refreshAddressSummary();
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' });
    } finally {
      this.setData({ addressSaving: false });
    }
  },

  onDeleteAddress(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '确认删除地址？',
      content: '删除后无法恢复，可重新从微信导入或手动新建。',
      success: r => {
        if (r.confirm) {
          addressUtil.deleteAddress(id);
          wx.showToast({ title: '地址已删除', icon: 'none' });
          this.refreshAddressSummary();
        }
      }
    });
  },

  onSetDefaultAddress(e) {
    const id = e.currentTarget.dataset.id;
    addressUtil.setDefaultAddress(id);
    wx.showToast({ title: '已设为默认地址', icon: 'success' });
    this.refreshAddressSummary();
  },

  // ---------------- 其他操作 ----------------
  contactShop() {
    if (this.data.config.DELIVERY_PERSON_PHONE) wx.makePhoneCall({ phoneNumber: this.data.config.DELIVERY_PERSON_PHONE });
  },
  copyShopAddress() {
    require('../../utils/copy-address').copyAddress(this.data.config.WORKSHOP_ADDRESS);
  },
  navToPromote() { wx.switchTab({ url: '/pages/promote/promote' }); },
  navToAdmin() { wx.navigateTo({ url: '/pages/admin/admin' }); },
  onAvatarSecretTap() {},
  onSecretAdminTrigger() { if (this.data.userInfo.is_admin === 1) this.navToAdmin(); },
  showAccountFlows() { wx.navigateTo({ url: '/pages/account/account' }); },
  showPrivacy() { wx.navigateTo({ url: '/pages/privacy/privacy' }); },
  showRules() { wx.navigateTo({ url: '/pages/rules/rules' }); },

  onEditProfile() {
    this.openRegisterModal();
  },

  copyReferralCode() {
    const code = this.data.userInfo && this.data.userInfo.invite_code;
    if (!code) return wx.showToast({ title: '邀请码正在生成中', icon: 'none' });
    wx.setClipboardData({ data: code, success: () => wx.showToast({ title: '邀请码已复制', icon: 'success' }) });
  },
  showTimelineGuide() { this.setData({ showTimelineGuide: true }); },
  closeTimelineGuide() { this.setData({ showTimelineGuide: false }); },
  timelineGuideToPromote() { this.setData({ showTimelineGuide: false }); this.navToPromote(); },
  onShareAppMessage() {
    const code = this.data.isMember && this.data.userInfo && this.data.userInfo.invite_code;
    return {
      title: '潘小兜老卤 · 预约现做，会员享菜品专属价',
      path: code ? `/pages/index/index?referrer=${encodeURIComponent(code)}` : '/pages/index/index'
    };
  },
  onShareTimeline() {
    const code = this.data.isMember && this.data.userInfo && this.data.userInfo.invite_code;
    return {
      title: '潘小兜老卤 · 预约现做，新鲜现卤到店自提或周边自送',
      query: code ? `referrer=${encodeURIComponent(code)}` : ''
    };
  }
});
