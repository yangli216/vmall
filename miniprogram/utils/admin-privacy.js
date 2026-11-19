const {formatRequest}=require('./privacy');
const methods={
  changePrivacyStatus:function(e){this.setData({privacyStatus:e.currentTarget.dataset.status});this.loadPrivacyRequests();},
  loadPrivacyRequests:async function(append=false){
    if(append!==true)append=false;
    if(append && (this.data.privacyLoading || !this.data.privacyNextCursor))return;
    const sequence=this._privacySequence=(this._privacySequence || 0)+1;this.setData({privacyLoading:true,privacyError:''});
    try{
      const result=await getApp().api('/api/admin/privacy?status='+this.data.privacyStatus+(append?'&before_id='+this.data.privacyNextCursor:''));
      if(this._privacyUnloaded || sequence!==this._privacySequence)return;
      this.setData({privacyRequests:(append?this.data.privacyRequests:[]).concat(result.list.map(formatRequest)),privacyNextCursor:result.next_cursor});
    }catch(error){if(!this._privacyUnloaded && sequence===this._privacySequence)this.setData({privacyError:error.message});}
    finally{if(!this._privacyUnloaded && sequence===this._privacySequence)this.setData({privacyLoading:false});}
  },
  morePrivacyRequests:function(){this.loadPrivacyRequests(true);},
  acceptPrivacyRequest:async function(e){
    if(this.data.privacyBusyId)return;const id=Number(e.currentTarget.dataset.id);this.setData({privacyBusyId:id});
    try{await getApp().api('/api/admin/privacy/handle','POST',{id,status:'PROCESSING'});if(!this._privacyUnloaded)await this.loadPrivacyRequests();}
    catch(error){if(!this._privacyUnloaded)wx.showToast({title:error.message,icon:'none'});}
    finally{if(!this._privacyUnloaded)this.setData({privacyBusyId:null});}
  },
  replyPrivacyRequest:function(e){
    if(this.data.privacyBusyId)return;
    const id=Number(e.currentTarget.dataset.id),request=this.data.privacyRequests.find(r=>r.id===id);if(!request)return;
    this.setData({privacyBusyId:id});
    const release=()=>{if(!this._privacyUnloaded)this.setData({privacyBusyId:null});};
    wx.showModal({title:'回复个人信息处理申请',content:'请记录已实际完成的处理；若无法处理或仍需留存，请说明具体范围、理由和后续方式。此回复不会自动删除数据或注销账号。',editable:true,placeholderText:'填写核实结果，不要填写密码或密钥',success:r=>{
      if(this._privacyUnloaded)return;
      if(!r.confirm){release();return;}
      const resolution=(r.content || '').trim();if(!resolution || resolution.length>1000){release();wx.showToast({title:'请填写1000字以内的具体结果',icon:'none'});return;}
      wx.showModal({title:'确认已核实实际结果',content:'申请编号 '+id+'。保存回复仅记录处理说明，请确认内容与实际执行一致；未执行删除或注销时，应如实说明尚未完成及后续安排。',confirmText:'核实并保存',success:confirmation=>{
        if(this._privacyUnloaded)return;if(!confirmation.confirm){release();return;}return this.savePrivacyReply(id,resolution);
      },fail:release});
    },fail:release});
  },
  savePrivacyReply:async function(id,resolution){
    try{await getApp().api('/api/admin/privacy/handle','POST',{id,status:'RESOLVED',resolution,confirm_actual_result:true});
      if(!this._privacyUnloaded){wx.showToast({title:'回复已保存',icon:'success'});await this.loadPrivacyRequests();}}
    catch(error){if(!this._privacyUnloaded)wx.showToast({title:error.message,icon:'none'});}
    finally{if(!this._privacyUnloaded)this.setData({privacyBusyId:null});}
  }
};
module.exports={methods};
