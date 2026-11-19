const invoke=(method,options)=>new Promise((resolve,reject)=>wx[method](Object.assign({},options,{success:resolve,fail:reject})));
// callContainer limits the entire request to 100KB; base64 adds about one third.
const MAX_PHOTO_BYTES=64*1024;
async function selectPhoto() {
  let path;
  if(wx.chooseMedia) {
    const result=await invoke('chooseMedia',{count:1,mediaType:['image'],sourceType:['album','camera'],sizeType:['compressed']});
    path=result.tempFiles && result.tempFiles[0] && result.tempFiles[0].tempFilePath;
  } else {
    const result=await invoke('chooseImage',{count:1,sizeType:['compressed'],sourceType:['album','camera']});path=result.tempFilePaths[0];
  }
  if(!path)throw new Error('未选择照片');
  const info=await invoke('getImageInfo',{src:path});
  if(!Number.isFinite(info.width) || !Number.isFinite(info.height) || info.width<=0 || info.height<=0)throw new Error('照片尺寸无效，请重新选择');
  const original=path;
  const fs=wx.getFileSystemManager();
  let fits=false;
  for(const [edge,quality] of [[1600,85],[1200,70],[900,55],[640,45]]) {
    const ratio=Math.min(1,edge/info.width,edge/info.height);
    const compressed=await invoke('compressImage',{src:original,quality,compressedWidth:Math.max(1,Math.round(info.width*ratio)),compressedHeight:Math.max(1,Math.round(info.height*ratio))});
    path=compressed.tempFilePath;
    const stat=await new Promise((resolve,reject)=>fs.stat({path,success:resolve,fail:reject}));
    if(!stat.stats || !Number.isSafeInteger(stat.stats.size) || stat.stats.size<=0)throw new Error('无法读取照片大小，请重新选择');
    if(stat.stats.size<=MAX_PHOTO_BYTES){fits=true;break;}
  }
  if(!fits)throw new Error('照片压缩后仍超过64KB，请裁剪后重试');
  const file=await new Promise((resolve,reject)=>fs.readFile({filePath:path,encoding:'base64',success:resolve,fail:reject}));
  if(typeof file.data!=='string' || !file.data.length || file.data.length>4*Math.ceil(MAX_PHOTO_BYTES/3))throw new Error('照片读取结果过大或无效，请重新选择');
  return {path,base64:file.data,request_id:'photo_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2)+'_'+Math.random().toString(36).slice(2)};
}
const methods={
  resetDishPhoto:function(){this._dishEpoch=(this._dishEpoch || 0)+1;this._pendingPhoto=null;this.setData({photoBusy:false,photoError:'',photoPreview:'',photoCloudCover:false,dishSaving:false});},
  chooseDishPhoto:async function(){
    if(this.data.photoBusy || this.data.dishSaving)return;
    const epoch=this._dishEpoch;this.setData({photoBusy:true,photoError:''});
    try {
      const photo=await selectPhoto();
      if(epoch!==this._dishEpoch || !this.data.showAddModal)return;
      this._pendingPhoto=photo;this.setData({photoPreview:photo.path,photoBusy:false});
      await this.uploadDishPhoto();
    }catch(error){
      if(epoch!==this._dishEpoch || !this.data.showAddModal)return;
      this.setData({photoBusy:false,photoError:/cancel/.test(error.errMsg || '')?'':error.message || '选图失败，请检查相册权限后重试'});
    }
  },
  uploadDishPhoto:async function(){
    if(!this._pendingPhoto || this.data.photoBusy || this.data.dishSaving)return;
    const epoch=this._dishEpoch,photo=this._pendingPhoto;this.setData({photoBusy:true,photoError:''});
    try {
      const result=await getApp().api('/api/admin/product/image','POST',{request_id:photo.request_id,base64:photo.base64});
      if(epoch!==this._dishEpoch || !this.data.showAddModal)return;
      if(!result || typeof result.file_id!=='string' || result.file_id.indexOf('cloud://')!==0)throw new Error('图片上传响应异常，请重试');
      this._pendingPhoto=null;this.setData({'dishForm.cover_img':result.file_id,photoCloudCover:true,photoPreview:'',photoError:'',photoBusy:false});
    }catch(error){
      if(epoch===this._dishEpoch && this.data.showAddModal)this.setData({photoBusy:false,photoError:error.message || '上传未完成，请重试'});
    }
  },
  discardDishPhoto:function(){if(this.data.photoBusy || this.data.dishSaving)return;this._pendingPhoto=null;this.setData({photoPreview:'',photoError:''});},
  clearDishPhoto:function(){if(this.data.photoBusy || this.data.dishSaving)return;this._pendingPhoto=null;this.setData({'dishForm.cover_img':'',photoCloudCover:false,photoPreview:'',photoError:''});}
};
module.exports={methods,selectPhoto};
