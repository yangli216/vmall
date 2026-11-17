// miniprogram/pages/index/index.js
const app = getApp();

Page({
  data: {
    deliveryType: 1, // 1: 作坊自送, 2: 到店自提
    destAddress: '临安锦城·钱王新村 2幢302',
    receiverName: '陈女士',
    receiverPhone: '13968028888',
    currentBatchText: '今日 16:30 傍晚出炉批次 (现捞温热送达)',
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
    cartList: [], // 数组格式便于抽屉列表展示
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
    this.initBatchTime();
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
    this.initBatchTime();
    this.fetchProductList(() => {
      this.fetchUserInfo(() => {
        wx.stopPullDownRefresh();
      });
    });
  },

  // 计算当前出炉批次文案
  initBatchTime: function () {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    // 每日傍晚批次 16:30
    if (hours < 16 || (hours === 16 && minutes <= 30)) {
      this.setData({
        currentBatchText: '今日傍晚 16:30 出炉批次 (现捞保温直达)'
      });
    } else {
      this.setData({
        currentBatchText: '今日出炉已毕 · 预约明日傍晚 16:30 批次'
      });
    }
  },

  // 绑定扫码推荐人
  bindReferrerFromQuery: function (inviteCode) {
    app.callContainer({
      path: '/api/user/bind-referrer',
      method: 'POST',
      data: { invite_code: inviteCode }
    }).then(res => {
      if (res && res.code === 0) {
        wx.showToast({ title: `已绑定推荐好友`, icon: 'success' });
      }
    }).catch(() => {});
  },

  // 获取真实商品列表
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
      }
      if (cb) cb();
    }).catch(err => {
      that.setData({ loadingProducts: false });
      if (cb) cb();
    });
  },

  // 获取真实用户身份与积分
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

  // 切换配送与自提
  changeDelType: function (e) {
    const type = parseInt(e.currentTarget.dataset.type, 10);
    this.setData({ deliveryType: type }, () => {
      if (this.data.isDrawerOpen) {
        this.calculateBill();
      }
    });
  },

  // 切换分类
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

  // 辅助方法：重新计算购物车状态并同步数组
  updateCartState: function (cart) {
    let count = 0;
    let total = 0;
    const list = [];

    Object.keys(cart).forEach(k => {
      const item = cart[k];
      if (item && item.quantity > 0) {
        count += item.quantity;
        const price = this.data.isMember ? parseFloat(item.dish.member_price) : parseFloat(item.dish.origin_price);
        total += price * item.quantity;
        list.push(item);
      }
    });

    this.setData({
      cart,
      cartList: list,
      cartCount: count,
      cartTotal: total.toFixed(2)
    });

    // 如果购物车被减空，自动关闭抽屉
    if (count === 0 && this.data.isDrawerOpen) {
      this.setData({ isDrawerOpen: false });
    } else if (this.data.isDrawerOpen) {
      this.calculateBill();
    }
  },

  // 购物车加一
  addToCart: function (e) {
    const dish = e.currentTarget.dataset.dish;
    if (dish.status === 0) {
      wx.showToast({ title: '今日已售罄沽清', icon: 'none' });
      return;
    }
    const cart = { ...this.data.cart };
    if (!cart[dish.id]) {
      cart[dish.id] = { id: dish.id, dish, quantity: 1 };
    } else {
      cart[dish.id].quantity += 1;
    }

    this.updateCartState(cart);
  },

  // 购物车减一
  decreaseCart: function (e) {
    const dish = e.currentTarget.dataset.dish;
    const cart = { ...this.data.cart };
    if (!cart[dish.id]) return;

    cart[dish.id].quantity -= 1;
    if (cart[dish.id].quantity <= 0) {
      delete cart[dish.id];
    }

    this.updateCartState(cart);
  },

  // 清空购物车
  clearCart: function () {
    const that = this;
    wx.showModal({
      title: '清空购物车',
      content: '确认清空已挑选的全部老卤？',
      confirmColor: '#DC2626',
      success: (res) => {
        if (res.confirm) {
          that.updateCartState({});
        }
      }
    });
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

  // 修改收货地址与收件人联系方式
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
        that.setData({
          destAddress: fullAddr,
          receiverName: res.userName,
          receiverPhone: res.telNumber
        });
      },
      fail: () => {
        wx.showModal({
          title: '修改自送地址与联系人',
          editable: true,
          placeholderText: '请输入：收件人 手机号 详细地址',
          content: `${that.data.receiverName} ${that.data.receiverPhone} ${that.data.destAddress}`,
          success: (res) => {
            if (res.confirm && res.content) {
              const parts = res.content.trim().split(/\s+/);
              if (parts.length >= 3) {
                that.setData({
                  receiverName: parts[0],
                  receiverPhone: parts[1],
                  destAddress: parts.slice(2).join(' ')
                });
              } else {
                that.setData({ destAddress: res.content });
              }
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

  // 预核算
  calculateBill: function () {
    const that = this;
    const items = Object.keys(this.data.cart).map(id => ({
      product_id: parseInt(id, 10),
      quantity: this.data.cart[id].quantity
    }));

    if (items.length === 0) return;

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
      }
    }).catch(() => {});
  },

  // 提交并完成真实支付
  submitOrderPay: function () {
    const that = this;
    const items = Object.keys(this.data.cart).map(id => ({
      product_id: parseInt(id, 10),
      quantity: this.data.cart[id].quantity
    }));

    if (items.length === 0) {
      wx.showToast({ title: '请挑选卤味', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在创建订单...' });

    const createPayload = {
      items,
      delivery_type: this.data.deliveryType,
      receiver_address: this.data.deliveryType === 1 ? this.data.destAddress : '临天八弄36号作坊自提',
      receiver_name: this.data.receiverName,
      receiver_phone: this.data.receiverPhone,
      expect_time_slot: this.data.currentBatchText,
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
    }).catch(() => {
      wx.hideLoading();
      wx.showToast({ title: '下单网络异常', icon: 'none' });
    });
  },

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
          }).catch(() => {
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
      cartList: [],
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
