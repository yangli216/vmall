function copyAddress(value){
  const address=typeof value==='string'?value.trim():'';
  if(!address){wx.showToast({title:'取餐地址暂未提供，请联系掌柜',icon:'none'});return;}
  wx.setClipboardData({data:address,fail:()=>wx.showToast({title:'地址复制失败，请重试',icon:'none'})});
}
module.exports={copyAddress};
