const kinds=[{value:'ACCESS',label:'查阅或获取个人信息副本'},{value:'CORRECT',label:'更正个人信息'},{value:'DELETE',label:'申请删除个人信息'},{value:'CLOSE_ACCOUNT',label:'申请注销账号'}];
const statuses={OPEN:'待掌柜处理',PROCESSING:'掌柜核实中',RESOLVED:'掌柜已回复',CANCELLED:'已撤回'};
function formatRequest(row){return Object.assign({},row,{kind_title:(kinds.find(k=>k.value===row.kind)||{}).label || '个人信息申请',status_title:statuses[row.status] || row.status});}
function clearSavedContact(){
  wx.removeStorageSync('pandou_contact');wx.removeStorageSync('pandou_pending_checkout');
  wx.setStorageSync('pandou_contact_revision',Date.now().toString(36)+'_'+Math.random().toString(36).slice(2));
}
module.exports={kinds,statuses,formatRequest,clearSavedContact};
