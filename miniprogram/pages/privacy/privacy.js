const app=getApp();
const {kinds,formatRequest,clearSavedContact}=require('../../utils/privacy');
Page({
  data:{user:null,nickname:'',phone:'',shopPhone:'',kinds,kindIndex:0,description:'',reviewConfirmed:false,
    rows:[],nextCursor:null,hasActive:false,loading:false,profileBusy:false,submitting:false,cancelBusyId:null,error:''},
  onLoad(){this._alive=true;this.refresh();},
  onUnload(){this._alive=false;this._sequence=(this._sequence || 0)+1;},
  onPullDownRefresh(){this.refresh().finally(()=>wx.stopPullDownRefresh());},
  onReachBottom(){if(this.data.nextCursor && !this.data.loading)this.loadRequests(true);},
  async refresh(){
    if(this.data.profileBusy || this.data.submitting)return;
    const epoch=this._refreshEpoch=(this._refreshEpoch || 0)+1;this.setData({loading:true,error:''});
    try{
      const [user,config]=await Promise.all([app.api('/api/user/info'),app.api('/api/config/all')]);
      if(!this._alive || epoch!==this._refreshEpoch)return;
      this.setData({user,nickname:user.nickname || '',phone:user.phone || '',shopPhone:config.DELIVERY_PERSON_PHONE || ''});
      await this.loadRequests();
    }catch(error){if(this._alive && epoch===this._refreshEpoch)this.setData({error:error.message,loading:false});}
  },
  async loadRequests(append=false){
    if(append && (this.data.loading || !this.data.nextCursor))return;
    const sequence=this._sequence=(this._sequence || 0)+1;this.setData({loading:true,error:''});
    try{
      const result=await app.api('/api/user/privacy'+(append?'?before_id='+this.data.nextCursor:''));
      if(!this._alive || sequence!==this._sequence)return;
      const rows=(append?this.data.rows:[]).concat(result.list.map(formatRequest));
      this.setData({rows,nextCursor:result.next_cursor,hasActive:rows.some(r=>r.status==='OPEN' || r.status==='PROCESSING')});
    }catch(error){if(this._alive && sequence===this._sequence)this.setData({error:error.message});}
    finally{if(this._alive && sequence===this._sequence)this.setData({loading:false});}
  },
  editProfile(e){if(!this.data.profileBusy && !this.data.loading && ['nickname','phone'].includes(e.currentTarget.dataset.field))this.setData({[e.currentTarget.dataset.field]:e.detail.value});},
  async saveProfile(){
    if(this.data.profileBusy || this.data.loading || !this.data.user)return;
    const nickname=this.data.nickname.trim(),phone=this.data.phone.trim();
    if(!nickname || (phone && !/^1[3-9]\d{9}$/.test(phone)))return wx.showToast({title:'请填写昵称和有效手机号，手机号可留空',icon:'none'});
    this.setData({profileBusy:true});
    try{
      await app.api('/api/user/update-profile','POST',{nickname,phone});
      if(!this._alive)return;this.setData({user:Object.assign({},this.data.user,{nickname,phone}),nickname,phone});wx.showToast({title:'资料已保存',icon:'success'});
    }catch(error){if(this._alive)wx.showToast({title:error.message,icon:'none'});}
    finally{if(this._alive)this.setData({profileBusy:false});}
  },
  clearProfile(){
    if(this.data.profileBusy || this.data.loading || !this.data.user)return;
    this.setData({profileBusy:true});
    wx.showModal({title:'清除账户展示资料',content:'将昵称恢复为“食客”，移除头像及资料手机号。订单中的联系方式、历史交易和会员资产保留。若需处理订单资料或注销账号，请在下方提交申请。',confirmText:'确认清除',success:r=>{
      if(!this._alive)return;
      if(!r.confirm){if(this._alive)this.setData({profileBusy:false});return;}
      return this.performClearProfile();
    },fail:()=>{if(this._alive)this.setData({profileBusy:false});}});
  },
  async performClearProfile(){
    try{
      await app.api('/api/user/clear-profile','POST',{confirm_clear_profile:true});
      if(!this._alive)return;this.setData({nickname:'食客',phone:'',user:Object.assign({},this.data.user,{nickname:'食客',phone:'',avatar_url:''})});wx.showToast({title:'展示资料已清除',icon:'success'});
    }catch(error){if(this._alive)wx.showToast({title:error.message,icon:'none'});}
    finally{if(this._alive)this.setData({profileBusy:false});}
  },
  clearContact(){
    wx.showModal({title:'清除本机收货资料',content:'清除这台设备保存的联系人、手机号、地址和未提交订单缓存。已生成订单中的资料保留，其他设备不会同步清除。',confirmText:'确认清除',success:r=>{
      if(!r.confirm || !this._alive)return;
      try{clearSavedContact();wx.showToast({title:'本机收货资料已清除',icon:'success'});}catch(error){wx.showToast({title:'清除未完成，请重试',icon:'none'});}
    }});
  },
  changeKind(e){if(!this.data.submitting)this.setData({kindIndex:Number(e.detail.value)});},
  editDescription(e){if(!this.data.submitting)this.setData({description:e.detail.value});},
  confirmReview(e){if(!this.data.submitting)this.setData({reviewConfirmed:e.detail.value.includes('review')});},
  async submitRequest(){
    if(this.data.submitting || this.data.loading || this.data.hasActive)return;
    const kind=kinds[this.data.kindIndex],description=this.data.description.trim();
    if(!kind || !description || !this.data.reviewConfirmed)return wx.showToast({title:'请填写说明并确认申请处理方式',icon:'none'});
    const payload={kind:kind.value,description,confirm_review:true},fingerprint=JSON.stringify(payload);
    if(!this._pendingRequest || this._pendingRequest.fingerprint!==fingerprint)this._pendingRequest={fingerprint,id:'privacy_'+Date.now()+'_'+Math.random().toString(36).slice(2,12)};
    payload.request_id=this._pendingRequest.id;this.setData({submitting:true});
    try{
      await app.api('/api/user/privacy/request','POST',payload);
      if(!this._alive)return;this._pendingRequest=null;this.setData({description:'',reviewConfirmed:false,hasActive:true});
      wx.showToast({title:'申请已提交，待核实处理',icon:'none'});await this.loadRequests();
    }catch(error){if(this._alive){wx.showToast({title:error.message,icon:'none'});if(error.code===409)await this.loadRequests();}}
    finally{if(this._alive)this.setData({submitting:false});}
  },
  cancelRequest(e){
    if(this.data.cancelBusyId)return;const id=Number(e.currentTarget.dataset.id);this.setData({cancelBusyId:id});
    wx.showModal({title:'撤回此申请',content:'只可撤回尚未接单的申请，已接单时请联系掌柜。',confirmText:'确认撤回',success:r=>{
      if(!this._alive)return;
      if(!r.confirm){if(this._alive)this.setData({cancelBusyId:null});return;}return this.performCancel(id);
    },fail:()=>{if(this._alive)this.setData({cancelBusyId:null});}});
  },
  async performCancel(id){try{await app.api('/api/user/privacy/cancel','POST',{id});if(this._alive)await this.loadRequests();}
    catch(error){if(this._alive)wx.showToast({title:error.message,icon:'none'});}finally{if(this._alive)this.setData({cancelBusyId:null});}},
  contact(){if(this.data.shopPhone)wx.makePhoneCall({phoneNumber:this.data.shopPhone});}
});
