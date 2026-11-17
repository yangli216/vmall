// miniprogram/pages/admin/admin.js
const app = getApp();

Page({
  data: {
    loading: true,
    dishes: [],
    config: {
      MEMBER_ENTRY_MODE: 'CONSUME',
      MEMBER_ENTRY_THRESHOLD: 68,
      RED_PACKET_MAX_DEDUCT_RATIO: '0.50',
      COMMISSION_RATE: '0.03'
    },
    redDeductPercent: 50,
    commissionPercent: 3,
    showAddModal: false,
    newDish: {
      title: '',
      origin_price: '',
      member_price: '',
      badge: '今日现捞',
      intro: ''
    }
  },

  onLoad: function () {
    this.loadDishes();
    this.loadConfigs();
  },

  onPullDownRefresh: function () {
    this.loadDishes();
    this.loadConfigs(() => {
      wx.stopPullDownRefresh();
    });
  },

  // 获取真实菜品列表
  loadDishes: function (cb) {
    const that = this;
    that.setData({ loading: true });

    app.callContainer({
      path: '/api/products',
      method: 'GET'
    }).then(res => {
      that.setData({ loading: false });
      if (res && res.code === 0 && Array.isArray(res.data)) {
        that.setData({ dishes: res.data });
      }
      if (cb) cb();
    }).catch(err => {
      that.setData({ loading: false });
      wx.showToast({ title: '加载菜品失败', icon: 'none' });
      if (cb) cb();
    });
  },

  // 获取真实后台运营配置
  loadConfigs: function (cb) {
    const that = this;
    app.callContainer({
      path: '/api/config/all',
      method: 'GET'
    }).then(res => {
      if (res && res.code === 0 && res.data) {
        const c = res.data;
        const redRatio = parseFloat(c.RED_PACKET_MAX_DEDUCT_RATIO || '0.50') * 100;
        const commRate = parseFloat(c.COMMISSION_RATE || '0.03') * 100;
        const threshold = parseInt(c.MEMBER_ENTRY_THRESHOLD || '68', 10);

        that.setData({
          config: {
            ...c,
            MEMBER_ENTRY_THRESHOLD: threshold,
            MEMBER_ENTRY_MODE: c.MEMBER_ENTRY_MODE || 'CONSUME'
          },
          redDeductPercent: Math.round(redRatio),
          commissionPercent: Math.round(commRate)
        });
      }
      if (cb) cb();
    }).catch(() => {
      if (cb) cb();
    });
  },

  // 一键切换上下架/沽清状态 (直连云数据库)
  toggleProductStatus: function (e) {
    const that = this;
    const dishId = e.currentTarget.dataset.id;
    const index = e.currentTarget.dataset.index;
    const newStatus = e.detail.value ? 1 : 0;

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
        dishes[index].status = newStatus;
        that.setData({ dishes });
      } else {
        wx.showToast({ title: res.msg || '切换失败', icon: 'none' });
        // 恢复原有开关状态
        const dishes = [...that.data.dishes];
        that.setData({ dishes });
      }
    }).catch(err => {
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
      const dishes = [...that.data.dishes];
      that.setData({ dishes });
    });
  },

  // 切换升级门槛模式
  changeUpgradeType: function (e) {
    const type = e.currentTarget.dataset.type;
    this.setData({
      'config.MEMBER_ENTRY_MODE': type
    });
  },

  // 修改累计消费门槛滑块
  updateThresholdSlider: function (e) {
    this.setData({
      'config.MEMBER_ENTRY_THRESHOLD': e.detail.value
    });
  },

  // 修改红包抵扣上限滑块
  updateRedRatioSlider: function (e) {
    this.setData({
      redDeductPercent: e.detail.value
    });
  },

  // 修改返佣比例滑块
  updateCommissionSlider: function (e) {
    this.setData({
      commissionPercent: e.detail.value
    });
  },

  // 保存全部真实运营参数至云端数据库
  saveAllConfigs: function () {
    const that = this;
    wx.showLoading({ title: '正在保存配置...' });

    const redRatioStr = (this.data.redDeductPercent / 100).toFixed(2);
    const commRateStr = (this.data.commissionPercent / 100).toFixed(2);
    const thresholdStr = this.data.config.MEMBER_ENTRY_THRESHOLD.toString();
    const entryModeStr = this.data.config.MEMBER_ENTRY_MODE;

    const updates = [
      { key: 'MEMBER_ENTRY_MODE', val: entryModeStr },
      { key: 'MEMBER_ENTRY_THRESHOLD', val: thresholdStr },
      { key: 'RED_PACKET_MAX_DEDUCT_RATIO', val: redRatioStr },
      { key: 'COMMISSION_RATE', val: commRateStr }
    ];

    const promises = updates.map(u => {
      return app.callContainer({
        path: '/api/admin/config/update',
        method: 'POST',
        data: {
          config_key: u.key,
          config_value: u.val
        }
      });
    });

    Promise.all(promises).then(() => {
      wx.hideLoading();
      wx.showToast({ title: '运营配置已生效！', icon: 'success' });
      that.loadConfigs();
    }).catch(err => {
      wx.hideLoading();
      wx.showToast({ title: '保存配置失败，请重试', icon: 'none' });
    });
  },

  // 调度一键发车 (真实批量更新数据库待配送订单)
  dispatchAllOrders: function () {
    const that = this;
    wx.showModal({
      title: '确认一键全单发车？',
      content: '今日傍晚 16:30 出炉批次已准备就绪，潘师傅将立即骑行电瓶车出发行车配送，所有待出锅订单将实时流转为「配送中」。',
      confirmText: '立即发车',
      confirmColor: '#059669',
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '正在派发订单...' });
          app.callContainer({
            path: '/api/admin/order/dispatch',
            method: 'POST',
            data: {}
          }).then(apiRes => {
            wx.hideLoading();
            if (apiRes && apiRes.code === 0) {
              wx.showToast({ title: '全单发车成功！', icon: 'success' });
            } else {
              wx.showToast({ title: apiRes.msg || '调度失败', icon: 'none' });
            }
          }).catch(err => {
            wx.hideLoading();
            wx.showToast({ title: '发车调度异常', icon: 'none' });
          });
        }
      }
    });
  },

  // 新增菜品模态框
  openAddModal: function () {
    this.setData({
      showAddModal: true,
      newDish: {
        title: '',
        origin_price: '',
        member_price: '',
        badge: '今日现捞',
        intro: ''
      }
    });
  },

  closeAddModal: function () {
    this.setData({ showAddModal: false });
  },

  onInputTitle: function (e) {
    this.setData({ 'newDish.title': e.detail.value });
  },
  onInputOriginPrice: function (e) {
    const origin = parseFloat(e.detail.value) || 0;
    const member = (origin * 0.88).toFixed(2);
    this.setData({
      'newDish.origin_price': e.detail.value,
      'newDish.member_price': member
    });
  },
  onInputMemberPrice: function (e) {
    this.setData({ 'newDish.member_price': e.detail.value });
  },
  onInputBadge: function (e) {
    this.setData({ 'newDish.badge': e.detail.value });
  },
  onInputIntro: function (e) {
    this.setData({ 'newDish.intro': e.detail.value });
  },

  // 提交新增菜品至真实数据库
  submitAddDish: function () {
    const that = this;
    const d = this.data.newDish;
    if (!d.title || !d.origin_price) {
      wx.showToast({ title: '请填写名称与价格', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在上架...' });
    const payload = {
      category_id: 1,
      title: d.title,
      intro: d.intro || '临天八弄纯手工老卤，鲜卤现捞',
      origin_price: parseFloat(d.origin_price),
      member_price: parseFloat(d.member_price || (parseFloat(d.origin_price) * 0.88).toFixed(2)),
      cover_img: 'https://images.unsplash.com/photo-1544025162-d76694265947?w=500',
      badge: d.badge || '手工现做'
    };

    app.callContainer({
      path: '/api/admin/product/add',
      method: 'POST',
      data: payload
    }).then(res => {
      wx.hideLoading();
      if (res && res.code === 0) {
        that.closeAddModal();
        wx.showToast({ title: '新菜品上架成功！', icon: 'success' });
        that.loadDishes();
      } else {
        wx.showToast({ title: res.msg || '上架失败', icon: 'none' });
      }
    }).catch(err => {
      wx.hideLoading();
      wx.showToast({ title: '上架请求异常', icon: 'none' });
    });
  }
});
