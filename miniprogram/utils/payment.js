const app = getApp();
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function sync(orderId) {
  return app.api('/api/order/sync-payment', 'POST', { order_id: orderId });
}
async function payOrder(orderId) {
  const result = await app.api('/api/order/payment', 'POST', { order_id: orderId });
  if (result.paid) return { confirmed: true };
  if(result.payment && result.payment.simulated===true) {
    if(!app.globalData.allowLocalDev || app.globalData.runtimeVersion!=='develop')throw new Error('当前版本不允许模拟支付');
    const choice=await new Promise((resolve,reject)=>wx.showActionSheet({
      itemList:['模拟付款成功（不会扣款）','模拟付款失败','模拟取消付款'],
      success:r=>resolve(r.tapIndex),fail:()=>reject(new Error('已取消模拟支付，可在订单中重试'))
    }));
    const outcome=['SUCCESS','FAIL','CANCEL'][choice];
    if(!outcome)throw new Error('未选择模拟支付结果');
    const confirmation=await app.api('/api/dev/payment/confirm','POST',{order_id:orderId,outcome});
    if(!confirmation.paid)throw new Error(outcome==='FAIL'?'模拟付款失败，可在订单中重新付款':'已取消模拟支付，可在订单中继续付款');
    const order=await sync(orderId);
    return {confirmed:order.payment_state==='PAID',simulated:true};
  }
  try {
    await new Promise((resolve, reject) => wx.requestPayment(Object.assign({}, result.payment, { success: resolve, fail: reject })));
  } catch (error) {
    // A client failure or cancellation is not proof of the payment's final outcome.
    try { const order = await sync(orderId); if (order.payment_state === 'PAID') return { confirmed: true }; } catch (e) {}
    const cancelled = /cancel/.test(error.errMsg || '');
    throw new Error(cancelled ? '已取消支付，可在我的订单继续付款' : '支付结果待确认，请在订单中查询，勿重复下单');
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const order = await sync(orderId);
      if (order.payment_state === 'PAID') return { confirmed: true };
      if (['REFUNDING', 'REFUNDED'].includes(order.payment_state)) return { confirmed: false, refunding: true };
    } catch (error) { if (attempt === 2) return { confirmed: false }; }
    if (attempt < 2) await wait(800);
  }
  return { confirmed: false };
}
module.exports = { payOrder, sync };
