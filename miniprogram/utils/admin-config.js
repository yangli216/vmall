const app=getApp();
const keys=['MEMBER_ENTRY_MODE','MEMBER_ENTRY_THRESHOLD','DELIVERY_BASE_FEE','DELIVERY_FREE_THRESHOLD','DELIVERY_PERSON_PHONE','DELIVERY_PERSON_NAME','WORKSHOP_ADDRESS','WORKSHOP_LAT','WORKSHOP_LNG','DELIVERY_MAX_KM','WORKSHOP_ANNOUNCEMENT','DELIVERY_AREAS','BATCH_SCHEDULE_TIME','BATCH_CUTOFF_TIME','BOOKING_DAYS','SHOP_OPEN','BATCH_MAX_ORDERS','ORDER_EXPIRE_MINUTES'];
const methods={
  editConfigFields(fields){
    if(!this.data.configLoaded || this.data.configLoading || this.data.configSaving || this._configUnloaded)return;
    this.setData(Object.assign({configDirty:true},fields));
  },
  applyConfigs(result){
    if(!result || !result.configs || typeof result.revision!=='string' || !/^[a-f0-9]{64}$/.test(result.revision) || keys.concat(['RED_PACKET_MAX_DEDUCT_RATIO','COMMISSION_RATE']).some(key=>typeof result.configs[key]!=='string'))throw new Error('营业设置未完整读取，请重试');
    this._configRevision=result.revision;
    this.setData({config:result.configs,configLoaded:true,configDirty:false,configError:'',redDeductPercent:Math.round(Number(result.configs.RED_PACKET_MAX_DEDUCT_RATIO)*100),commissionPercent:Math.round(Number(result.configs.COMMISSION_RATE)*100)});
  },
  async loadConfigs(cb,discard=false){
    if(this.data.configSaving || this._configUnloaded || (this.data.configDirty && !discard)){if(typeof cb==='function')cb();return false;}
    const sequence=this._configSequence=(this._configSequence||0)+1;
    this.setData({configLoading:true,configError:''});
    try{
      const result=await app.api('/api/admin/config');
      if(this._configUnloaded || sequence!==this._configSequence)return false;
      this.applyConfigs(result);return true;
    }catch(error){if(!this._configUnloaded && sequence===this._configSequence)this.setData({configError:error.message || '营业设置读取失败'});return false;}
    finally{if(!this._configUnloaded && sequence===this._configSequence)this.setData({configLoading:false});if(typeof cb==='function')cb();}
  },
  async reloadConfigs(){
    if(this.data.configSaving || this.data.configLoading || this._configUnloaded)return;
    if(this.data.configDirty){const discard=await new Promise(resolve=>wx.showModal({title:'重新读取营业设置？',content:'尚未保存的填写会被覆盖。需要保留的内容请先复制记录，再读取最新设置并核对。',confirmText:'重新读取',success:r=>resolve(r.confirm),fail:()=>resolve(false)}));if(!discard || this._configUnloaded)return;}
    const loaded=await this.loadConfigs(undefined,true);
    if(loaded && !this._configUnloaded){this.loadDishes();this.loadPendingOrders();this.loadMembers();}
    return loaded;
  },
  onConfigInput(e){const field=e.currentTarget.dataset.field;if(keys.includes(field))this.editConfigFields({['config.'+field]:e.detail.value});},
  onShopOpen(e){this.editConfigFields({'config.SHOP_OPEN':e.detail.value?'1':'0'});},
  changeUpgradeType(e){if(['FREE','CONSUME','MANUAL'].includes(e.currentTarget.dataset.type))this.editConfigFields({'config.MEMBER_ENTRY_MODE':e.currentTarget.dataset.type});},
  updateThresholdSlider(e){this.editConfigFields({'config.MEMBER_ENTRY_THRESHOLD':e.detail.value});},
  updateRedRatioSlider(e){this.editConfigFields({redDeductPercent:e.detail.value});},
  updateCommissionSlider(e){this.editConfigFields({commissionPercent:e.detail.value});},
  onInputDeliveryFee(e){this.editConfigFields({'config.DELIVERY_BASE_FEE':e.detail.value});},
  onInputFreeThreshold(e){this.editConfigFields({'config.DELIVERY_FREE_THRESHOLD':e.detail.value});},
  onInputPhone(e){this.editConfigFields({'config.DELIVERY_PERSON_PHONE':e.detail.value});},
  onInputAnnouncement(e){this.editConfigFields({'config.WORKSHOP_ANNOUNCEMENT':e.detail.value});},
  fillLinanCoreAreas(){
    this.editConfigFields({'config.DELIVERY_AREAS':'临安区,锦城街道,锦北街道,锦南街道,青山湖街道,玲珑街道'});
    wx.showToast({title:'已填入临安主城区',icon:'none'});
  },
  pickWorkshopLocation(){
    if(!this.data.configLoaded || this.data.configLoading || this.data.configSaving || this._configUnloaded)return;
    wx.chooseLocation({
      success:res=>{
        const addr=[res.address,res.name].filter(Boolean).join(' ').trim();
        const updates={
          'config.WORKSHOP_LAT':Number(res.latitude).toFixed(6),
          'config.WORKSHOP_LNG':Number(res.longitude).toFixed(6)
        };
        if(addr)updates['config.WORKSHOP_ADDRESS']=addr.slice(0,255);
        this.editConfigFields(updates);
        wx.showToast({title:'门店坐标已更新，记得保存',icon:'none'});
      },
      fail:err=>{
        if(!/cancel/i.test((err&&err.errMsg)||''))wx.showToast({title:'未获取到位置，请检查定位权限',icon:'none'});
      }
    });
  },
  async saveAllConfigs(){
    if(!this.data.configLoaded || this.data.configLoading || this.data.configSaving || this._configUnloaded)return;
    const configs={};keys.forEach(key=>{configs[key]=this.data.config[key];});
    configs.RED_PACKET_MAX_DEDUCT_RATIO=(this.data.redDeductPercent/100).toFixed(2);configs.COMMISSION_RATE=(this.data.commissionPercent/100).toFixed(2);
    this._configSequence=(this._configSequence||0)+1;this.setData({configSaving:true,configError:''});
    try{
      const result=await app.api('/api/admin/config/update','POST',{configs,expected_revision:this._configRevision});
      if(this._configUnloaded)return;
      this.applyConfigs(result);wx.showToast({title:'营业设置已保存'});
    }catch(error){if(!this._configUnloaded)this.setData({configError:error.message || '保存失败，填写已保留，可重试'});}
    finally{if(!this._configUnloaded)this.setData({configSaving:false});}
  }
};
module.exports={methods};
