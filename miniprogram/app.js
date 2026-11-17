// miniprogram/app.js
App({
  globalData: {
    userInfo: null,
    systemConfig: {},
    // 微信云托管环境 ID (在微信开发者工具云托管控制台创建后填入)
    // 填写您的真实环境ID（如 prod-xxxx）后，将自动通过微信内部专线免鉴权请求
    cloudEnvId: '',
    serviceName: 'pandou-server'
  },

  onLaunch: function () {
    if (wx.cloud) {
      if (this.globalData.cloudEnvId) {
        wx.cloud.init({
          env: this.globalData.cloudEnvId,
          traceUser: true
        });
      }
    } else {
      console.error('请使用 2.2.3 或以上的基础库以使用微信云托管功能');
    }

    // 初始化本地存储的真实身份标识 (本地联调模式备用)
    let openid = wx.getStorageSync('pandou_user_openid');
    if (!openid) {
      openid = 'wx_dev_' + Math.random().toString(36).substring(2, 10);
      wx.setStorageSync('pandou_user_openid', openid);
    }
    this.globalData.devOpenid = openid;
  },

  /**
   * 封装微信云托管原生容器调用
   * 生产环境：走微信内部专线安全网关，自动透传真实 x-wx-openid，免配合法域名与SSL证书
   * 开发联调：直连本地或开发服务器
   */
  callContainer: function (options) {
    const that = this;
    return new Promise((resolve, reject) => {
      // 真实云托管生产环境调用
      if (wx.cloud && that.globalData.cloudEnvId && that.globalData.cloudEnvId.length > 5 && !that.globalData.cloudEnvId.includes('your-env')) {
        wx.cloud.callContainer({
          config: {
            env: that.globalData.cloudEnvId
          },
          path: options.path,
          header: {
            'X-WX-SERVICE': that.globalData.serviceName,
            'content-type': 'application/json'
          },
          method: options.method || 'GET',
          data: options.data || {},
          success: res => resolve(res.data),
          fail: err => {
            console.error('[CloudContainer Call Fail]', err);
            reject(err);
          }
        });
      } else {
        // 本地/联调模式：带上持久化的开发者身份 OpenID
        wx.request({
          url: 'http://127.0.0.1:80' + options.path,
          method: options.method || 'GET',
          data: options.data || {},
          header: {
            'content-type': 'application/json',
            'x-wx-openid': that.globalData.devOpenid
          },
          success: res => resolve(res.data),
          fail: err => {
            console.warn('[Local Server Connect Error]', err);
            reject(err);
          }
        });
      }
    });
  }
});
