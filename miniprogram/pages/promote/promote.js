// miniprogram/pages/promote/promote.js
const app = getApp();
const {captureReferral} = require('../../utils/referral');
const {createReferralPoster} = require('../../utils/poster');

Page({
  data: {
    loading: false, error: '', nextCursor: null,
    posterGenerating:false,posterSaving:false,posterPath:'',posterError:'',showPoster:false,showTimelineGuide:false,
    myReferralCode: '',
    commissionRatePercent: 3, maxDeductRatio: 0.5, isMember: false,
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

  onLoad: function (options) {
    this._unloaded=false;captureReferral(options);
    this.recalcSim();
  },
  onUnload: function(){this._unloaded=true;},

  onShow: function () {
    this.loadReferrals();
  },

  onPullDownRefresh: function () {
    this.loadReferrals(() => {
      wx.stopPullDownRefresh();
    });
  },

  loadReferrals: async function (cb, append = false) {
    if (append && (this.data.loading || !this.data.nextCursor)) return;
    const sequence = this._sequence = (this._sequence || 0) + 1;
    this.setData({loading:true, error:''});
    try {
      const [user, config, result] = await Promise.all([
        app.api('/api/user/info'), app.api('/api/config/all'),
        app.api('/api/referral/my' + (append ? '?before_id=' + this.data.nextCursor : ''))
      ]);
      if (sequence !== this._sequence) return;
      this.setData({myReferralCode:user.invite_code, isMember:user.is_member === 1,
        commissionRatePercent:Math.round(Number(config.COMMISSION_RATE) * 100),
        maxDeductRatio:Number(config.RED_PACKET_MAX_DEDUCT_RATIO), summary:result.summary,
        referrals:(append ? this.data.referrals : []).concat(result.list), nextCursor:result.next_cursor}, () => this.recalcSim());
      const pending = wx.getStorageSync('pandou_pending_referrer');
      if (pending && user.is_member !== 1) {
        try {
          await app.api('/api/user/bind-referrer', 'POST', { invite_code: pending });
          wx.removeStorageSync('pandou_pending_referrer');
          wx.showToast({ title: '已绑定推荐好友', icon: 'success' });
        } catch (err) {
          if ([400, 403, 409].includes(err.code)) wx.removeStorageSync('pandou_pending_referrer');
        }
      }
    } catch(error) {
      if (sequence === this._sequence) this.setData({error:error.message});
    } finally {
      if (sequence === this._sequence) this.setData({loading:false});
      if (cb) cb();
    }
  },
  onReachBottom: function () { this.loadReferrals(undefined, true); },
  moreReferrals: function () { this.loadReferrals(undefined, true); },
  retryReferrals: function () { this.loadReferrals(); },

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
    const maxRed = Math.floor(val * this.data.maxDeductRatio); // 上限50%
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
    const maxRed = Math.floor(orderAmt * this.data.maxDeductRatio);
    const redDeduct = Math.min(this.data.simRedDeduct, maxRed);
    // 纯微信实付基数 = 订单金额 - 红包抵扣
    const actualCash = Math.max(0, orderAmt - redDeduct);
    const commission = (actualCash * (this.data.commissionRatePercent / 100)).toFixed(2);

    this.setData({
      maxSimRedAllowed: maxRed, simRedDeduct: redDeduct,
      simActualCash: actualCash.toFixed(2),
      simEarnCommission: commission
    });
  },

  showPosterTip: function () {
    wx.showModal({title:'推荐好友规则',content:'1. 点击「发给微信好友」或「分享到朋友圈」分享专属推荐；\n2. 点击「生成邀请海报」可保存至相册发布到朋友圈；\n3. 符合条件的好友可在首次下单前绑定推荐人；\n4. 好友订单完成后，按有效现金货款计算推荐红包，可用于抵扣货款，不可提现。',showCancel:false});
  },
  showTimelineGuide: function () {
    this.setData({ showTimelineGuide: true });
  },
  closeTimelineGuide: function () {
    this.setData({ showTimelineGuide: false });
  },
  timelineGuideToPoster: function () {
    this.setData({ showTimelineGuide: false });
    this.generatePoster();
  },
  goToIndex: function () {
    wx.switchTab({ url: '/pages/index/index' });
  },
  generatePoster: async function(){
    if(this.data.posterGenerating)return;
    if(!this.data.isMember || !this.data.myReferralCode)return wx.showToast({title:'成为有效会员后可生成海报',icon:'none'});
    this.setData({posterGenerating:true,posterError:'',showPoster:true,posterPath:''});
    try{
      const version=app.globalData.runtimeVersion;
      if(!['release','trial','develop'].includes(version))throw new Error('当前版本无法生成邀请海报');
      const image=await app.api('/api/referral/code','POST',{version});
      if(this._unloaded)return;
      if(image.invite_code!==this.data.myReferralCode || image.version!==version)throw new Error('邀请信息已变化，请刷新后重试');
      const path=await createReferralPoster(this,image);
      if(!this._unloaded)this.setData({posterPath:path});
    }catch(error){if(!this._unloaded)this.setData({posterError:error.message || '海报生成失败，请重试'});}
    finally{if(!this._unloaded)this.setData({posterGenerating:false});}
  },
  closePoster: function(){if(!this.data.posterSaving)this.setData({showPoster:false});},
  previewPoster: function(){if(this.data.posterPath)wx.previewImage({current:this.data.posterPath,urls:[this.data.posterPath]});},
  savePoster: function(){
    if(this.data.posterSaving || !this.data.posterPath)return;
    this.setData({posterSaving:true});
    wx.saveImageToPhotosAlbum({filePath:this.data.posterPath,success:()=>{if(!this._unloaded)wx.showToast({title:'海报已保存到相册'});},fail:error=>{
      if(this._unloaded)return;
      if(/auth|permission|privacy/i.test(error.errMsg || ''))wx.showModal({title:'需要相册保存权限',content:'请在设置中允许保存图片，然后返回点击“保存到相册”。也可预览图片后手动保存。',confirmText:'打开设置',success:r=>{if(r.confirm)wx.openSetting({});}});
      else wx.showToast({title:/cancel/i.test(error.errMsg || '')?'已取消保存':'保存未完成，请重试',icon:'none'});
    },complete:()=>{if(!this._unloaded)this.setData({posterSaving:false});}});
  },

  // 原生微信分享给好友
  onShareAppMessage: function () {
    return {
      title: '潘小兜老卤 · 预约现做，会员享菜品专属价',
      path: this.data.isMember && this.data.myReferralCode ? `/pages/index/index?referrer=${encodeURIComponent(this.data.myReferralCode)}` : '/pages/index/index'
    };
  },

  // 分享到朋友圈 (工匠精神：裂变闭环)
  onShareTimeline: function () {
    return {
      title: '潘小兜老卤 · 预约现做',
      query: this.data.isMember && this.data.myReferralCode ? `referrer=${encodeURIComponent(this.data.myReferralCode)}` : ''
    };
  }
});
