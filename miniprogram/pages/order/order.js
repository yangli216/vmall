// miniprogram/pages/order/order.js
const app = getApp();

Page({
  data: {
    loading: true,
    statusTitleMap: {
      10: '待付款',
      20: '作坊老卤慢煨出锅中',
      30: '潘师傅电瓶车正在配送中',
      40: '已安全送达'
    },
    activeOrder: null,
    historyOrders: []
  },

  onLoad: function () {
    this.fetchOrders();
  },

  onShow: function () {
    this.fetchOrders();
  },

  onPullDownRefresh: function () {
    this.fetchOrders(() => {
      wx.stopPullDownRefresh();
    });
  },

  fetchOrders: function (cb) {
    const that = this;
    that.setData({ loading: true });

    app.callContainer({
      path: '/api/order/list',
      method: 'GET'
    }).then(res => {
      that.setData({ loading: false });
      if (res && res.code === 0 && Array.isArray(res.data)) {
        const list = res.data;
        // 活跃订单：待付款(10)、待出锅备餐(20)、配送中(30)
        const active = list.find(o => o.order_status === 10 || o.order_status === 20 || o.order_status === 30);
        // 历史订单：已完成(40) 或 已取消/退款(50)
        const history = list.filter(o => o.order_status === 40 || o.order_status === 50);

        that.setData({
          activeOrder: active || null,
          historyOrders: history
        });
      }
      if (cb) cb();
    }).catch(err => {
      that.setData({ loading: false });
      if (cb) cb();
    });
  },

  // 待支付订单前往支付
  payActiveOrder: function () {
    const that = this;
    if (!this.data.activeOrder) return;
    const order = this.data.activeOrder;

    wx.showModal({
      title: '微信支付确认',
      content: `应付金额：¥${order.final_pay_amount}`,
      confirmText: '立即支付',
      confirmColor: '#07C160',
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '正在完成结算...' });
          app.callContainer({
            path: '/api/order/pay-success',
            method: 'POST',
            data: { order_id: order.id }
          }).then(apiRes => {
            wx.hideLoading();
            if (apiRes && apiRes.code === 0) {
              wx.showToast({ title: '支付成功！', icon: 'success' });
              that.fetchOrders();
            } else {
              wx.showToast({ title: apiRes.msg || '支付失败', icon: 'none' });
            }
          }).catch(() => {
            wx.hideLoading();
            wx.showToast({ title: '网络异常，请重试', icon: 'none' });
          });
        }
      }
    });
  },

  // 客户主动取消订单并申请退款
  cancelActiveOrder: function () {
    const that = this;
    if (!this.data.activeOrder) return;
    const order = this.data.activeOrder;

    const tipContent = order.order_status === 10
      ? '确认取消该待支付订单？已抵扣积分将自动退回您的账户。'
      : '确认在出锅发车前申请取消订单？已支付微信款项将原路退回，抵扣积分自动返还。';

    wx.showModal({
      title: '取消订单确认',
      content: tipContent,
      confirmText: '确认取消',
      confirmColor: '#DC2626',
      cancelText: '暂不取消',
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '正在取消...' });
          app.callContainer({
            path: '/api/order/cancel',
            method: 'POST',
            data: { order_id: order.id }
          }).then(apiRes => {
            wx.hideLoading();
            if (apiRes && apiRes.code === 0) {
              wx.showToast({ title: '订单已取消，积分已返还', icon: 'success' });
              that.fetchOrders();
            } else {
              wx.showToast({ title: apiRes.msg || '取消失败', icon: 'none' });
            }
          }).catch(() => {
            wx.hideLoading();
            wx.showToast({ title: '取消请求网络异常', icon: 'none' });
          });
        }
      }
    });
  },

  // 联系掌柜潘师傅
  callPanMaster: function () {
    const phone = (this.data.activeOrder && this.data.activeOrder.delivery_person_phone) || '13735518290';
    wx.makePhoneCall({
      phoneNumber: phone,
      fail: () => {
        wx.showModal({
          title: '掌柜联系电话',
          content: `潘师傅 (潘健)：${phone}\n作坊基地：临安锦城街道临天八弄36号`,
          showCancel: false,
          confirmColor: '#D9480F'
        });
      }
    });
  },

  // 客户确认收货 (状态流转至 40)
  confirmDelivered: function () {
    const that = this;
    if (!this.data.activeOrder) return;

    wx.showModal({
      title: '确认已收到老卤？',
      content: '确认后订单将流转为完成状态，并正式为推荐人结算防刷红包积分。',
      confirmText: '确认送达',
      confirmColor: '#07C160',
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '正在确认...' });
          app.callContainer({
            path: '/api/order/complete',
            method: 'POST',
            data: { order_id: that.data.activeOrder.id }
          }).then(apiRes => {
            wx.hideLoading();
            if (apiRes && apiRes.code === 0) {
              wx.showToast({ title: '已确认送达，祝您用餐愉快！', icon: 'success' });
              that.fetchOrders();
            } else {
              wx.showToast({ title: apiRes.msg || '操作失败', icon: 'none' });
            }
          }).catch(err => {
            wx.hideLoading();
            wx.showToast({ title: '网络异常，请重试', icon: 'none' });
          });
        }
      }
    });
  },

  navToMenu: function () {
    wx.switchTab({
      url: '/pages/index/index'
    });
  }
});
