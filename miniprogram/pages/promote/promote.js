// miniprogram/pages/promote/promote.js
const app = getApp();

Page({
  data: {
    loading: true,
    myReferralCode: '',
    commissionRatePercent: 3,
    simOrderAmount: 100,
    simRedDeduct: 30,
    maxSimRedAllowed: 50,
    simActualCash: '70.00',
    simEarnCommission: '2.10',
    summary: {
      total_referred: 0,
      total_orders: 0,
      total_commission: '0.00'
    },
    referrals: []
  },

  onLoad: function () {
    this.recalcSim();
    this.loadReferrals();
  },

  onShow: function () {
    this.loadReferrals();
  },

  onPullDownRefresh: function () {
    this.loadReferrals(() => {
      wx.stopPullDownRefresh();
    });
  },

  loadReferrals: function (cb) {
    const that = this;
    that.setData({ loading: true });

    // 1. 获取用户信息以读取个人真实专属邀请码
    const userPromise = app.callContainer({
      path: '/api/user/info',
      method: 'GET'
    }).then(res => {
      if (res && res.code === 0 && res.data) {
        if (res.data.invite_code) {
          that.setData({ myReferralCode: res.data.invite_code });
        }
      }
    });

    // 2. 获取系统配置以读取后台动态返佣比率
    const configPromise = app.callContainer({
      path: '/api/config/all',
      method: 'GET'
    }).then(res => {
      if (res && res.code === 0 && res.data && res.data.COMMISSION_RATE) {
        const ratePercent = Math.round(parseFloat(res.data.COMMISSION_RATE) * 100);
        that.setData({ commissionRatePercent: ratePercent }, () => {
          that.recalcSim();
        });
      }
    });

    // 3. 获取真实推荐列表与统计流水
    const referralPromise = app.callContainer({
      path: '/api/referral/my',
      method: 'GET'
    }).then(res => {
      if (res && res.code === 0 && res.data) {
        that.setData({
          summary: res.data.summary || { total_referred: 0, total_orders: 0, total_commission: '0.00' },
          referrals: res.data.list || []
        });
      }
    });

    Promise.all([userPromise, configPromise, referralPromise]).then(() => {
      that.setData({ loading: false });
      if (cb) cb();
    }).catch(err => {
      that.setData({ loading: false });
      if (cb) cb();
    });
  },

  // 复制邀请码
  copyCode: function () {
    if (!this.data.myReferralCode) {
      wx.showToast({ title: '邀请码正在生成中', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: this.data.myReferralCode,
      success: () => {
        wx.showToast({ title: '邀请码已复制', icon: 'success' });
      }
    });
  },

  // 调整模拟订单消费金额
  onSimOrderChange: function (e) {
    const val = parseInt(e.detail.value, 10);
    const maxRed = Math.floor(val * 0.5); // 上限50%
    const currentRed = Math.min(this.data.simRedDeduct, maxRed);
    this.setData({
      simOrderAmount: val,
      maxSimRedAllowed: maxRed,
      simRedDeduct: currentRed
    }, () => {
      this.recalcSim();
    });
  },

  // 调整模拟好友红包抵扣金额
  onSimRedChange: function (e) {
    const val = parseInt(e.detail.value, 10);
    this.setData({
      simRedDeduct: val
    }, () => {
      this.recalcSim();
    });
  },

  // 实时根据防刷公式核算
  recalcSim: function () {
    const orderAmt = this.data.simOrderAmount;
    const redDeduct = this.data.simRedDeduct;
    // 纯微信实付基数 = 订单金额 - 红包抵扣
    const actualCash = Math.max(0, orderAmt - redDeduct);
    const commission = (actualCash * (this.data.commissionRatePercent / 100)).toFixed(2);

    this.setData({
      simActualCash: actualCash.toFixed(2),
      simEarnCommission: commission
    });
  },

  // 海报弹窗提示
  showPosterTip: function () {
    if (!this.data.myReferralCode) {
      wx.showToast({ title: '邀请码准备中', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '生成分享海报',
      content: `海报包含您的专属邀请码【${this.data.myReferralCode}】及潘小兜老卤二维码，好友扫码即可终身绑定，每单实付为您返利 ${this.data.commissionRatePercent}% 红包积分！`,
      confirmText: '保存到相册',
      confirmColor: '#D9480F',
      success: (res) => {
        if (res.confirm) {
          wx.showToast({ title: '已保存海报图片', icon: 'success' });
        }
      }
    });
  },

  // 原生微信分享给好友
  onShareAppMessage: function () {
    return {
      title: '临安锦城老卤现捞！快来潘小兜小作坊，享8.8折特惠',
      path: `/pages/index/index?referrer=${this.data.myReferralCode}`,
      imageUrl: 'https://images.unsplash.com/photo-1544025162-d76694265947?w=600'
    };
  },

  // 分享到朋友圈 (工匠精神：裂变闭环)
  onShareTimeline: function () {
    return {
      title: '潘小兜老卤小作坊 · 每日两炉现卤现捞 · 全场8.8折',
      query: `referrer=${this.data.myReferralCode}`,
      imageUrl: 'https://images.unsplash.com/photo-1544025162-d76694265947?w=600'
    };
  }
});
