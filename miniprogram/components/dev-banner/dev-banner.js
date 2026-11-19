Component({
  data:{visible:false},
  lifetimes:{attached(){
    const app=getApp();
    this.setData({visible:app.globalData.allowLocalDev===true && app.globalData.runtimeVersion==='develop'});
  }}
});
