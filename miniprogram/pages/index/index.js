// miniprogram/pages/index/index.js
const app = getApp();

Page({
  data: {
    deliveryType: 1, // 1: 作坊自送, 2: 到店自提
    destAddress: '临安锦城·钱王新村 2幢302',
    categories: [
      { id: 1, name: '🔥 招牌必吃' },
      { id: 2, name: '秘制酱牛肉' },
      { id: 3, name: '麻辣鸭副件' },
      { id: 4, name: '爽脆下酒菜' }
    ],
    currentCatId: 1,
    allDishes: [],
    dishes: [],
    cart: {}, // { [dishId]: { dish, quantity } }
    cartCount: 0,
    cartTotal: '0.00',
    isDrawerOpen: false,
    orderRemark: '',
    isMember: false,
    userNormalPoints: 0,
    userRedPoints: '0.00',
    useNormalPoints: false,
    useRedPoints: false,
    inputRedAmount: '0.00',
    loadingProducts: true,
    calcResult: {
      goods_origin_total: '0.00',
      member_discount: '0.00',
      normal_deduct: '0.00',
      red_deduct: '0.00',
      delivery_fee: '0.00',
      final_pay_amount: '0.00',
      commission_cash_base: '0.00'
    }
  },

  onLoad: function (options) {
    // 处理好友邀请码自动绑定 (扫码裂变进入)
    if (options && options.referrer) {
      this.bindReferrerFromQuery(options.referrer);
    }
    this.fetchProductList();
    this.fetchUserInfo();
  },

  onShow: function () {
    this.fetchUserInfo();
  },

  onPullDownRefresh: function () {
    this.fetchProductList(() => {
      this.fetchUserInfo(() => {
        wx.stopPullDownRefresh();
      });
    });
  },

  // 绑定扫码推荐人
  bindReferrerFromQuery: function (inviteCode) {
    app.callContainer({
      path: '/api/user/bind-referrer',
      method: 'POST',
      data: { invite_code: inviteCode }
    }).then(res => {
      if (res && res.code === 0) {
        wx.showToast({ title: `已成功绑定推荐人`, icon: 'success' });
      }
    }).catch(() => {});
  },

  // 获取真实商品列表 (生产直连云数据库)
  fetchProductList: function (cb) {
    const that = this;
    that.setData({ loadingProducts: true });

    app.callContainer({
      path: '/api/products',
      method: 'GET'
    }).then(res => {
      that.setData({ loadingProducts: false });
      if (res && res.code === 0 && Array.isArray(res.data)) {
        that.setData({
          allDishes: res.data,
          dishes: that.data.currentCatId === 1 ? res.data : res.data.filter(d => d.category_id === that.data.currentCatId)
        });
      } else {
        wx.showToast({ title: res.msg || '获取菜品失败', icon: 'none' });
      }
      if (cb) cb();
    }).catch(err => {
      that.setData({ loadingProducts: false });
      wx.showToast({ title: '网络异常，请下拉重试', icon: 'none' });
      if (cb) cb();
    });
  },

  // 获取真实用户积分、红包与会员身份
  fetchUserInfo: function (cb) {
    const that = this;
    app.callContainer({
      path: '/api/user/info',
      method: 'GET'
    }).then(res => {
      if (res && res.code === 0 && res.data) {
        const u = res.data;
        that.setData({
          isMember: u.is_member === 1,
          userNormalPoints: u.normal_points || 0,
          userRedPoints: Number(u.red_packet_points || 0).toFixed(2),
          inputRedAmount: Number(u.red_packet_points || 0).toFixed(2)
        });
      }
      if (cb) cb();
    }).catch(() => {
      if (cb) cb();
    });
  },

  // 切换作坊自送/到店自提
  changeDelType: function (e) {
    const type = parseInt(e.currentTarget.dataset.type, 10);
    this.setData({ deliveryType: type }, () => {
      if (this.data.isDrawerOpen) {
        this.calculateBill();
      }
    });
  },

  // 切换菜品分类
  selectCategory: function (e) {
    const id = parseInt(e.currentTarget.dataset.id, 10);
    this.setData({ currentCatId: id });
    if (id === 1) {
      this.setData({ dishes: this.data.allDishes });
    } else {
      const filtered = this.data.allDishes.filter(d => d.category_id === id);
      this.setData({ dishes: filtered });
    }
  },

  // 加入购物车
  addToCart: function (e) {
    const dish = e.currentTarget.dataset.dish;
    if (dish.status === 0) {
      wx.showToast({ title: '今日已售罄沽清', icon: 'none' });
      return;
    }
    const cart = { ...this.data.cart };
    if (!cart[dish.id]) {
      cart[dish.id] = { dish, quantity: 1 };
    } else {
      cart[dish.id].quantity += 1;
    }

    let count = 0;
    let total = 0;
    Object.keys(cart).forEach(k => {
      count += cart[k].quantity;
      const price = this.data.isMember ? parseFloat(cart[k].dish.member_price) : parseFloat(cart[k].dish.origin_price);
      total += price * cart[k].quantity;
    });

    this.setData({
      cart,
      cartCount: count,
      cartTotal: total.toFixed(2)
    });

    wx.showToast({ title: `已加: ${dish.title}`, icon: 'none', duration: 800 });
  },

  // 打开结算抽屉
  openCheckoutSheet: function () {
    if (this.data.cartCount === 0) {
      wx.showToast({ title: '请先挑选卤味', icon: 'none' });
      return;
    }
    this.setData({ isDrawerOpen: true });
    this.calculateBill();
  },

  // 关闭结算抽屉
  closeCheckoutSheet: function () {
    this.setData({ isDrawerOpen: false });
  },

  // 修改收货地址
  editAddress: function () {
    const that = this;
    if (this.data.deliveryType === 2) {
      wx.showModal({
        title: '到店自提地址',
        content: '浙江省杭州市临安区锦城街道临天八弄36号（潘小兜食品小作坊）\n营业时间：09:00 - 20:30',
        showCancel: false,
        confirmColor: '#D9480F'
      });
      return;
    }
    wx.chooseAddress({
      success: (res) => {
        const fullAddr = `${res.cityName}${res.countyName}${res.detailInfo}`;
        that.setData({ destAddress: fullAddr });
      },
      fail: () => {
        wx.showModal({
          title: '修改自送地址',
          editable: true,
          placeholderText: '请输入临安锦城周边详细送达地址',
          content: that.data.destAddress,
          success: (res) => {
            if (res.confirm && res.content) {
              that.setData({ destAddress: res.content });
            }
          }
        });
      }
    });
  },

  // 切换普通积分抵扣
  toggleNormalPoints: function (e) {
    this.setData({ useNormalPoints: e.detail.value }, () => {
      this.calculateBill();
    });
  },

  // 切换红包积分抵扣
  toggleRedPoints: function (e) {
    this.setData({ useRedPoints: e.detail.value }, () => {
      this.calculateBill();
    });
  },

  // 输入红包抵扣金额
  onRedAmountChange: function (e) {
    this.setData({ inputRedAmount: e.detail.value }, () => {
      this.calculateBill();
    });
  },

  // 备注输入
  onRemarkInput: function (e) {
    this.setData({ orderRemark: e.detail.value });
  },

  // 调用云端进行真实订单金额与积分试算
  calculateBill: function () {
    const that = this;
    const items = Object.keys(this.data.cart).map(id => ({
      product_id: parseInt(id, 10),
      quantity: this.data.cart[id].quantity
    }));

    const payload = {
      items,
      delivery_type: this.data.deliveryType,
      use_normal_points: this.data.useNormalPoints,
      use_red_packet_points: this.data.useRedPoints,
      custom_red_amount: parseFloat(this.data.inputRedAmount) || 0
    };

    app.callContainer({
      path: '/api/order/calculate',
      method: 'POST',
      data: payload
    }).then(res => {
      if (res && res.code === 0 && res.data) {
        that.setData({ calcResult: res.data });
      } else {
        wx.showToast({ title: res.msg || '核算失败', icon: 'none' });
      }
    }).catch(err => {
      wx.showToast({ title: '试算网络异常', icon: 'none' });
    });
  },

  // 提交订单并唤起真实支付闭环
  submitOrderPay: function () {
    const that = this;
    const items = Object.keys(this.data.cart).map(id => ({
      product_id: parseInt(id, 10),
      quantity: this.data.cart[id].quantity
    }));

    if (items.length === 0) {
      wx.showToast({ title: '请选择商品', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在创建订单...' });

    const createPayload = {
      items,
      delivery_type: this.data.deliveryType,
      receiver_address: this.data.deliveryType === 1 ? this.data.destAddress : '临天八弄36号作坊自提',
      order_remark: this.data.orderRemark,
      use_normal_points: this.data.useNormalPoints,
      use_red_packet_points: this.data.useRedPoints,
      custom_red_amount: parseFloat(this.data.inputRedAmount) || 0
    };

    app.callContainer({
      path: '/api/order/create',
      method: 'POST',
      data: createPayload
    }).then(res => {
      wx.hideLoading();
      if (res && res.code === 0 && res.data) {
        const orderId = res.data.order_id;
        const payAmount = res.data.pay_amount;
        that.confirmAndPayOrder(orderId, payAmount);
      } else {
        wx.showToast({ title: res.msg || '创建订单失败', icon: 'none' });
      }
    }).catch(err => {
      wx.hideLoading();
      wx.showToast({ title: '下单服务异常，请重试', icon: 'none' });
    });
  },

  // 微信原生支付确认与订单状态流转
  confirmAndPayOrder: function (orderId, payAmount) {
    const that = this;
    wx.showModal({
      title: '微信原生安全支付',
      content: `应付金额：¥${payAmount}\n(已扣减积分抵扣，严格按实付结算推荐人返佣)`,
      confirmText: '立即支付',
      confirmColor: '#07C160',
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '正在完成支付结算...' });
          app.callContainer({
            path: '/api/order/pay-success',
            method: 'POST',
            data: { order_id: orderId }
          }).then(payRes => {
            wx.hideLoading();
            if (payRes && payRes.code === 0) {
              that.finishOrderFlow();
            } else {
              wx.showToast({ title: payRes.msg || '支付核销异常', icon: 'none' });
            }
          }).catch(err => {
            wx.hideLoading();
            wx.showToast({ title: '支付处理失败', icon: 'none' });
          });
        }
      }
    });
  },

  finishOrderFlow: function () {
    wx.showToast({ title: '下单成功！进入备餐', icon: 'success' });
    this.setData({
      cart: {},
      cartCount: 0,
      cartTotal: '0.00',
      isDrawerOpen: false
    });
    setTimeout(() => {
      wx.switchTab({
        url: '/pages/order/order'
      });
    }, 1000);
  },

  navToMember: function () {
    wx.switchTab({
      url: '/pages/member/member'
    });
  }
});
