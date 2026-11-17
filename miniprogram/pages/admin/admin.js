// miniprogram/pages/admin/admin.js
const app = getApp();

Page({
  data: {
    loading: true,
    dishes: [],
    pendingOrders: [],
    config: {
      MEMBER_ENTRY_MODE: 'CONSUME',
      MEMBER_ENTRY_THRESHOLD: 68,
      RED_PACKET_MAX_DEDUCT_RATIO: '0.50',
      COMMISSION_RATE: '0.03',
      DELIVERY_BASE_FEE: '3.00',
      DELIVERY_FREE_THRESHOLD: '38.00',
      DELIVERY_PERSON_PHONE: '13735518290',
      WORKSHOP_ANNOUNCEMENT: '今日傍晚 16:30 准时出锅，临天八弄现捞保温直达'
    },
    redDeductPercent: 50,
    commissionPercent: 3,
    showAddModal: false,
    isEditingDish: false,
    dishForm: {
      id: 0,
      title: '',
      origin_price: '',
      member_price: '',
      badge: '今日现捞',
      intro: ''
    }
  },

  onLoad: function () {
    this.checkAdminAuth();
  },

  checkAdminAuth: function () {
    const that = this;
    wx.showLoading({ title: '验证权限...' });
    app.callContainer({
      path: '/api/user/info',
      method: 'GET'
    }).then(res => {
      wx.hideLoading();
      if (res && res.code === 0 && res.data && res.data.is_admin === 1) {
        that.loadDishes();
        that.loadConfigs();
        that.loadPendingOrders();
      } else {
        wx.showModal({
          title: '作坊掌柜专属通道',
          content: '检测到当前微信未激活掌柜权限。请前往【尊享会员】中心输入口令绑定，或联系潘师傅授权。',
          showCancel: false,
          confirmText: '返回前台',
          confirmColor: '#D9480F',
          success: () => {
            wx.navigateBack();
          }
        });
      }
    }).catch(() => {
      wx.hideLoading();
      wx.navigateBack();
    });
  },

  onPullDownRefresh: function () {
    this.loadDishes();
    this.loadPendingOrders();
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

  // 获取待备餐发车订单 (status = 20)
  loadPendingOrders: function () {
    const that = this;
    app.callContainer({
      path: '/api/order/list?status=20',
      method: 'GET'
    }).then(res => {
      if (res && res.code === 0 && Array.isArray(res.data)) {
        that.setData({ pendingOrders: res.data });
      }
    }).catch(() => {});
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
            ...that.data.config,
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

  // 一键切换上下架/沽清状态
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
        const dishes = [...that.data.dishes];
        that.setData({ dishes });
      }
    }).catch(() => {
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
      const dishes = [...that.data.dishes];
      that.setData({ dishes });
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
    const dish = e.currentTarget.dataset.dish;
    this.setData({
      showAddModal: true,
      isEditingDish: true,
      dishForm: {
        id: dish.id,
        title: dish.title,
        origin_price: dish.origin_price,
        member_price: dish.member_price,
        badge: dish.badge || '手工老卤',
        intro: dish.intro || ''
      }
    });
  },

  // 打开新增模态框
  openAddModal: function () {
    this.setData({
      showAddModal: true,
      isEditingDish: false,
      dishForm: {
        id: 0,
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

  onInputFormTitle: function (e) {
    this.setData({ 'dishForm.title': e.detail.value });
  },
  onInputFormOriginPrice: function (e) {
    const origin = parseFloat(e.detail.value) || 0;
    const member = (origin * 0.88).toFixed(2);
    this.setData({
      'dishForm.origin_price': e.detail.value,
      'dishForm.member_price': member
    });
  },
  onInputFormMemberPrice: function (e) {
    this.setData({ 'dishForm.member_price': e.detail.value });
  },
  onInputFormBadge: function (e) {
    this.setData({ 'dishForm.badge': e.detail.value });
  },
  onInputFormIntro: function (e) {
    this.setData({ 'dishForm.intro': e.detail.value });
  },

  // 提交新增或修改菜品
  submitDishForm: function () {
    const that = this;
    const f = this.data.dishForm;
    if (!f.title || !f.origin_price) {
      wx.showToast({ title: '请填写名称与价格', icon: 'none' });
      return;
    }

    const isEdit = this.data.isEditingDish;
    wx.showLoading({ title: isEdit ? '正在保存修改...' : '正在发布上架...' });

    const payload = {
      id: f.id,
      category_id: 1,
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
      if (res && res.code === 0) {
        that.closeAddModal();
        wx.showToast({ title: isEdit ? '修改保存成功！' : '上架成功！', icon: 'success' });
        that.loadDishes();
      } else {
        wx.showToast({ title: res.msg || '操作失败', icon: 'none' });
      }
    }).catch(() => {
      wx.hideLoading();
      wx.showToast({ title: '请求异常', icon: 'none' });
    });
  },

  // 运营配置项输入处理器
  changeUpgradeType: function (e) {
    this.setData({ 'config.MEMBER_ENTRY_MODE': e.currentTarget.dataset.type });
  },
  updateThresholdSlider: function (e) {
    this.setData({ 'config.MEMBER_ENTRY_THRESHOLD': e.detail.value });
  },
  updateRedRatioSlider: function (e) {
    this.setData({ redDeductPercent: e.detail.value });
  },
  updateCommissionSlider: function (e) {
    this.setData({ commissionPercent: e.detail.value });
  },
  onInputDeliveryFee: function (e) {
    this.setData({ 'config.DELIVERY_BASE_FEE': e.detail.value });
  },
  onInputFreeThreshold: function (e) {
    this.setData({ 'config.DELIVERY_FREE_THRESHOLD': e.detail.value });
  },
  onInputPhone: function (e) {
    this.setData({ 'config.DELIVERY_PERSON_PHONE': e.detail.value });
  },
  onInputAnnouncement: function (e) {
    this.setData({ 'config.WORKSHOP_ANNOUNCEMENT': e.detail.value });
  },

  // 保存全部真实运营参数至云端数据库
  saveAllConfigs: function () {
    const that = this;
    wx.showLoading({ title: '正在保存全部配置...' });

    const redRatioStr = (this.data.redDeductPercent / 100).toFixed(2);
    const commRateStr = (this.data.commissionPercent / 100).toFixed(2);
    const thresholdStr = this.data.config.MEMBER_ENTRY_THRESHOLD.toString();
    const entryModeStr = this.data.config.MEMBER_ENTRY_MODE;

    const updates = [
      { key: 'MEMBER_ENTRY_MODE', val: entryModeStr },
      { key: 'MEMBER_ENTRY_THRESHOLD', val: thresholdStr },
      { key: 'RED_PACKET_MAX_DEDUCT_RATIO', val: redRatioStr },
      { key: 'COMMISSION_RATE', val: commRateStr },
      { key: 'DELIVERY_BASE_FEE', val: this.data.config.DELIVERY_BASE_FEE || '3.00' },
      { key: 'DELIVERY_FREE_THRESHOLD', val: this.data.config.DELIVERY_FREE_THRESHOLD || '38.00' },
      { key: 'DELIVERY_PERSON_PHONE', val: this.data.config.DELIVERY_PERSON_PHONE || '13735518290' },
      { key: 'WORKSHOP_ANNOUNCEMENT', val: this.data.config.WORKSHOP_ANNOUNCEMENT || '' }
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
      wx.showToast({ title: '全部运营配置已生效！', icon: 'success' });
      that.loadConfigs();
    }).catch(() => {
      wx.hideLoading();
      wx.showToast({ title: '保存配置异常，请重试', icon: 'none' });
    });
  },

  // 单独一单发车
  dispatchSingleOrder: function (e) {
    const that = this;
    const orderId = e.currentTarget.dataset.id;
    wx.showLoading({ title: '正在派发...' });

    app.callContainer({
      path: '/api/admin/order/dispatch',
      method: 'POST',
      data: { order_id: orderId }
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
    const that = this;
    wx.showModal({
      title: '确认一键全单发车？',
      content: `今日傍晚 16:30 出炉批次已准备就绪，当前共 ${this.data.pendingOrders.length} 笔订单，潘师傅将立即骑行电瓶车出发行车配送，所有订单实时流转为「配送中」。`,
      confirmText: '立即发车',
      confirmColor: '#059669',
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '正在派发全部订单...' });
          app.callContainer({
            path: '/api/admin/order/dispatch',
            method: 'POST',
            data: {}
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
  }
});
