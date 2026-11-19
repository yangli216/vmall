const {selectRuntime} = require('./config/runtime');
const {captureReferral} = require('./utils/referral');
App({
  globalData: {
    userInfo: null,
    systemConfig: {},
    cloudEnvId: '',
    serviceName: 'pandou',
    allowLocalDev: false
  },

  onLaunch: function () {
    let version = '';
    try { version = wx.getAccountInfoSync().miniProgram.envVersion; } catch (error) {}
    Object.assign(this.globalData, selectRuntime(version));
    if (wx.cloud && !this.globalData.allowLocalDev) {
      if (this.globalData.cloudEnvId) {
        wx.cloud.init({
          env: this.globalData.cloudEnvId,
          traceUser: false
        });
      }
    } else if (!this.globalData.allowLocalDev) {
      console.error('请使用 2.2.3 或以上的基础库以使用微信云托管功能');
    }

    if (this.globalData.allowLocalDev) {
      let openid = wx.getStorageSync('pandou_local_user_openid');
      if (!['wx_dev_local_customer','wx_dev_local_member','wx_dev_local_admin'].includes(openid)) openid='wx_dev_local_customer';
      wx.setStorageSync('pandou_local_user_openid',openid);
      this.globalData.devOpenid = openid;
    }
  },

  onShow: function(options) {captureReferral(options && options.query);},

  /**
   * 封装微信云托管原生容器调用
   * 生产环境：走微信内部专线安全网关，自动透传真实 x-wx-openid，免配合法域名与SSL证书
   * 开发联调：直连本地或开发服务器
   */
  api: function (path, method, data) {
    return this.callContainer({ path, method: method || 'GET', data: data || {} }).then(res => {
      if (!res || res.code !== 0) { const error = new Error((res && res.msg) || '服务暂时不可用'); error.code = res && res.code; throw error; }
      return res.data;
    });
  },

  callContainer: function (options) {
    const that = this;
    return new Promise((resolve, reject) => {
      // 真实云托管生产环境调用
      if (!that.globalData.allowLocalDev && wx.cloud && that.globalData.cloudEnvId && that.globalData.cloudEnvId.length > 5 && !that.globalData.cloudEnvId.includes('your-env')) {
        wx.cloud.callContainer({
          config: {
            env: that.globalData.cloudEnvId
          },
          path: options.path,
          header: Object.assign({
            'X-WX-SERVICE': that.globalData.serviceName,
            'content-type': 'application/json'
          }, options.header || {}),
          method: options.method || 'GET',
          data: options.data || {},
          success: res => {
            let body = res.data;
            if (typeof body === 'string') {
              try {
                body = JSON.parse(body);
              } catch (e) {
                body = { code: res.statusCode || 500, msg: body.length < 120 ? body : '服务响应异常' };
              }
            }
            resolve(body);
          },
          fail: err => {
            console.error('[CloudContainer Call Fail]', err);
            reject(new Error('网络连接失败，请稍后重试'));
          }
        });
      } else {
        if (!that.globalData.allowLocalDev || that.globalData.runtimeVersion !== 'develop') { reject(new Error('服务暂未开放，请联系掌柜')); return; }
        // 仅显式启用本地开发时使用开发身份
        wx.request({
          url: that.globalData.localBaseUrl + options.path,
          timeout: 15000,
          method: options.method || 'GET',
          data: options.data || {},
          header: Object.assign({
            'content-type': 'application/json',
            'x-dev-openid': that.globalData.devOpenid
          }, options.header || {}),
          success: res => {
            let body = res.data;
            if (typeof body === 'string') {
              try { body = JSON.parse(body); } catch (e) {}
            }
            resolve(body);
          },
          fail: err => {
            console.warn('[Local Server Connect Error]', err);
            reject(new Error('网络连接失败，请稍后重试'));
          }
        });
      }
    });
  }
});
