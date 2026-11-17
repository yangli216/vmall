// miniprogram/pages/member/member.js
const app = getApp();

Page({
  data: {
    loading: true,
    userInfo: null,
    isMember: false,
    progressPercent: 0,
    config: {
      MEMBER_ENTRY_MODE: 'CONSUME',
      MEMBER_ENTRY_THRESHOLD: '68.00',
      COMMISSION_RATE: '0.03',
      RED_PACKET_MAX_DEDUCT_RATIO: '0.50'
    }
  },

  onLoad: function () {
    this.loadData();
  },

  onShow: function () {
    this.loadData();
  },

  onPullDownRefresh: function () {
    this.loadData(() => {
      wx.stopPullDownRefresh();
    });
  },

  loadData: function (cb) {
    const that = this;
    that.setData({ loading: true });

    // 1. 获取真实当前用户信息
    const userPromise = app.callContainer({
      path: '/api/user/info',
      method: 'GET'
    }).then(res => {
      if (res && res.code === 0 && res.data) {
        const u = res.data;
        const isMem = u.is_member === 1;
        const total = parseFloat(u.total_consumption) || 0;
        const threshold = parseFloat(that.data.config.MEMBER_ENTRY_THRESHOLD || '68.00');
        const percent = threshold > 0 ? Math.min(100, Math.floor((total / threshold) * 100)) : 100;

        that.setData({
          userInfo: u,
          isMember: isMem,
          progressPercent: percent
        });
      }
    });

    // 2. 获取真实运营系统配置
    const configPromise = app.callContainer({
      path: '/api/config/all',
      method: 'GET'
    }).then(res => {
      if (res && res.code === 0 && res.data) {
        that.setData({
          config: {
            ...that.data.config,
            ...res.data
          }
        });
      }
    });

    Promise.all([userPromise, configPromise]).then(() => {
      that.setData({ loading: false });
      if (cb) cb();
    }).catch(err => {
      that.setData({ loading: false });
      wx.showToast({ title: '加载失败，请下拉重试', icon: 'none' });
      if (cb) cb();
    });
  },

  // 免费激活会员（当后台设置为FREE模式时）
  activateFreeMember: function () {
    const that = this;
    wx.showLoading({ title: '正在升级...' });
    app.callContainer({
      path: '/api/user/activate-free',
      method: 'POST'
    }).then(res => {
      wx.hideLoading();
      if (res && res.code === 0) {
        wx.showToast({ title: '恭喜晋升尊享会员！', icon: 'success' });
        that.loadData();
      } else {
        wx.showToast({ title: res.msg || '升级失败', icon: 'none' });
      }
    }).catch(err => {
      wx.hideLoading();
      wx.showToast({ title: '升级异常，请重试', icon: 'none' });
    });
  },

  // 退出会员流程 (真实流转：注销会员身份恢复为普通用户)
  confirmExitMember: function () {
    const that = this;
    wx.showModal({
      title: '确认退出尊享会员？',
      content: '退出会员后：\n1. 购买老卤商品将恢复原价，不再享受全场8.8折；\n2. 推荐好友将不再获得 3% 红包积分返利；\n3. 现有普通积分将继续为您保留。\n\n确认注销恢复为普通客官？',
      confirmText: '确认注销',
      confirmColor: '#DC2626',
      cancelText: '继续保留',
      cancelColor: '#6B7280',
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '正在注销...' });
          app.callContainer({
            path: '/api/user/exit-member',
            method: 'POST'
          }).then(apiRes => {
            wx.hideLoading();
            if (apiRes && apiRes.code === 0) {
              wx.showToast({ title: '已注销，恢复为普通客官', icon: 'none' });
              that.loadData();
            } else {
              wx.showToast({ title: apiRes.msg || '操作失败', icon: 'none' });
            }
          }).catch(err => {
            wx.hideLoading();
            wx.showToast({ title: '注销异常，请稍后重试', icon: 'none' });
          });
        }
      }
    });
  },

  // 联系掌柜
  contactShop: function () {
    wx.makePhoneCall({
      phoneNumber: '13735518290',
      fail: () => {
        wx.showModal({
          title: '作坊掌柜联系方式',
          content: '掌柜潘师傅：13735518290\n作坊地址：临安区锦城街道临天八弄36号',
          showCancel: false,
          confirmColor: '#D9480F'
        });
      }
    });
  },

  // 前往推广页面
  navToPromote: function () {
    wx.switchTab({
      url: '/pages/promote/promote'
    });
  },

  // 前往管理后台 (微信 OpenID 与掌柜主口令双重 RBAC 守护)
  navToAdmin: function () {
    const that = this;
    // 如果后端用户数据已标识为掌柜，且本地有授权标识，直接通行
    if (that.data.userInfo && that.data.userInfo.is_admin === 1) {
      wx.navigateTo({
        url: '/pages/admin/admin'
      });
      return;
    }

    wx.showModal({
      title: '作坊掌柜身份验证',
      editable: true,
      placeholderText: '请输入掌柜专属口令 (默认: 8899)',
      confirmText: '验证绑定',
      confirmColor: '#D9480F',
      success: (res) => {
        if (res.confirm) {
          const pwd = (res.content || '').trim();
          if (!pwd) {
            wx.showToast({ title: '请输入口令', icon: 'none' });
            return;
          }
          wx.showLoading({ title: '验证中...' });
          app.callContainer({
            path: '/api/admin/verify',
            method: 'POST',
            data: { passcode: pwd }
          }).then(apiRes => {
            wx.hideLoading();
            if (apiRes && apiRes.code === 0) {
              wx.setStorageSync('pandou_admin_authed', true);
              wx.showToast({ title: '掌柜微信已绑定！', icon: 'success' });
              that.loadData();
              setTimeout(() => {
                wx.navigateTo({
                  url: '/pages/admin/admin'
                });
              }, 600);
            } else {
              wx.showToast({ title: apiRes.msg || '口令错误，仅限掌柜本人', icon: 'none' });
            }
          }).catch(err => {
            wx.hideLoading();
            wx.showToast({ title: '验证异常，请重试', icon: 'none' });
          });
        }
      }
    });
  },

  // 更新食客微信昵称 (调用 update-profile 接口)
  onEditProfile: function () {
    const that = this;
    const curName = that.data.userInfo ? that.data.userInfo.nickname : '临安食客';
    wx.showModal({
      title: '修改食客昵称',
      editable: true,
      placeholderText: '请输入新昵称',
      content: curName,
      confirmText: '保存',
      confirmColor: '#D9480F',
      success: (res) => {
        if (res.confirm && res.content && res.content.trim()) {
          wx.showLoading({ title: '正在保存...' });
          app.callContainer({
            path: '/api/user/update-profile',
            method: 'POST',
            data: { nickname: res.content.trim() }
          }).then(apiRes => {
            wx.hideLoading();
            if (apiRes && apiRes.code === 0) {
              wx.showToast({ title: '昵称已保存', icon: 'success' });
              that.loadData();
            } else {
              wx.showToast({ title: apiRes.msg || '保存失败', icon: 'none' });
            }
          }).catch(() => {
            wx.hideLoading();
            wx.showToast({ title: '网络异常', icon: 'none' });
          });
        }
      }
    });
  }
});
