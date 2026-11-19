const app=getApp();
Page({
 data:{rows:[],loading:false,nextId:0,error:''},
 onLoad(){this.load();},onReachBottom(){if(this.data.nextId&&!this.data.loading)this.load(true);},
 onPullDownRefresh(){this.load().finally(()=>wx.stopPullDownRefresh());},
 async load(append=false){this.setData({loading:true,error:''});try{const rows=await app.api('/api/user/account-flows'+(append?'?before_id='+this.data.nextId:''));
  const list=rows.map(r=>{const debt=r.account_type.endsWith('_DEBT'),normal=r.account_type.startsWith('NORMAL_POINT');return Object.assign({},r,{label:(normal?'普通积分':'红包')+(debt?'待抵回':''),unit:normal?'分':'元',balance_label:debt?'待抵回':'余额',display_amount:(Number(r.amount)>0?'+':'')+r.amount});});
  this.setData({rows:append?this.data.rows.concat(list):list,nextId:rows.length===30?rows[rows.length-1].id:0});
 }catch(error){this.setData({error:error.message});}finally{this.setData({loading:false});}}
});
