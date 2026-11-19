const app=getApp();
Page({
 data:{loading:false,userInfo:{nickname:'食客',normal_points:0,red_packet_points:'0.00'},isMember:false,progressPercent:0,
  config:{MEMBER_ENTRY_MODE:'CONSUME',MEMBER_ENTRY_THRESHOLD:'68.00',COMMISSION_RATE:'0.03'},error:'',localDevelopment:false,switchingTestAccount:false,showTimelineGuide:false},
 onShow(){this.setData({localDevelopment:app.globalData.allowLocalDev===true && app.globalData.runtimeVersion==='develop'});this.loadData();},onPullDownRefresh(){this.loadData().finally(()=>wx.stopPullDownRefresh());},
 async switchTestAccount(event){
  if(!this.data.localDevelopment || this.data.switchingTestAccount)return;
  this.setData({switchingTestAccount:true});
  try{
   const result=await app.api('/api/dev/accounts');
   const openid=event && event.currentTarget && event.currentTarget.dataset.openid;
   const account=result.accounts.find(x=>x.openid===openid);if(!account)return;
   wx.setStorageSync('pandou_local_user_openid',account.openid);
   app.globalData.devOpenid=account.openid;app.globalData.userInfo=null;
   wx.removeStorageSync('pandou_pending_referrer');
   wx.reLaunch({url:'/pages/member/member'});
  }catch(error){wx.showToast({title:error.message,icon:'none'});}
  finally{this.setData({switchingTestAccount:false});}
 },
 async loadData(){this.setData({loading:true,error:''});try{
  const [u,c]=await Promise.all([app.api('/api/user/info'),app.api('/api/config/all')]);
  const threshold=Number(c.MEMBER_ENTRY_THRESHOLD),total=Number(u.total_consumption);
  this.setData({userInfo:u,isMember:u.is_member===1,config:c,progressPercent:threshold>0?Math.min(100,Math.floor(total/threshold*100)):100});
 }catch(error){this.setData({error:error.message});wx.showToast({title:error.message,icon:'none'});}finally{this.setData({loading:false});}},
 async activateFreeMember(){if(this.data.loading)return;this.setData({loading:true});try{await app.api('/api/user/activate-free','POST');wx.showToast({title:'会员已开通'});await this.loadData();}catch(error){wx.showToast({title:error.message,icon:'none'});}finally{this.setData({loading:false});}},
 confirmExitMember(){wx.showModal({title:'确认退出会员？',content:`退出后恢复原价，停止推荐奖励；现有红包余额 ¥${this.data.userInfo.red_packet_points} 将清零，普通积分保留。请先处理完进行中的订单，退出后不会自动再次入会。`,confirmText:'确认退出',success:async r=>{if(!r.confirm)return;try{await app.api('/api/user/exit-member','POST',{confirm_clear_red:true});await this.loadData();}catch(error){wx.showToast({title:error.message,icon:'none'});}}});},
 contactShop(){if(this.data.config.DELIVERY_PERSON_PHONE)wx.makePhoneCall({phoneNumber:this.data.config.DELIVERY_PERSON_PHONE});},
 copyShopAddress(){require('../../utils/copy-address').copyAddress(this.data.config.WORKSHOP_ADDRESS);},
 navToPromote(){wx.switchTab({url:'/pages/promote/promote'});},navToAdmin(){wx.navigateTo({url:'/pages/admin/admin'});},
 onAvatarSecretTap(){},onSecretAdminTrigger(){if(this.data.userInfo.is_admin===1)this.navToAdmin();},
 showAccountFlows(){wx.navigateTo({url:'/pages/account/account'});},
 showPrivacy(){wx.navigateTo({url:'/pages/privacy/privacy'});},
 showRules(){wx.navigateTo({url:'/pages/rules/rules'});},
 onEditProfile(){wx.showModal({title:'修改昵称',editable:true,content:this.data.userInfo.nickname,success:async r=>{if(!r.confirm||!r.content)return;try{await app.api('/api/user/update-profile','POST',{nickname:r.content.trim()});await this.loadData();}catch(error){wx.showToast({title:error.message,icon:'none'});}}});},
 copyReferralCode(){
  const code = this.data.userInfo && this.data.userInfo.invite_code;
  if (!code) return wx.showToast({ title: '邀请码正在生成中', icon: 'none' });
  wx.setClipboardData({ data: code, success: () => wx.showToast({ title: '邀请码已复制', icon: 'success' }) });
 },
 showTimelineGuide(){ this.setData({ showTimelineGuide: true }); },
 closeTimelineGuide(){ this.setData({ showTimelineGuide: false }); },
 timelineGuideToPromote(){ this.setData({ showTimelineGuide: false }); this.navToPromote(); },
 onShareAppMessage(){
  const code = this.data.isMember && this.data.userInfo && this.data.userInfo.invite_code;
  return {
   title: '潘小兜老卤 · 预约现做，会员享菜品专属价',
   path: code ? `/pages/index/index?referrer=${encodeURIComponent(code)}` : '/pages/index/index'
  };
 },
 onShareTimeline(){
  const code = this.data.isMember && this.data.userInfo && this.data.userInfo.invite_code;
  return {
   title: '潘小兜老卤 · 预约现做，新鲜现卤到店自提或周边自送',
   query: code ? `referrer=${encodeURIComponent(code)}` : ''
  };
 }
});
