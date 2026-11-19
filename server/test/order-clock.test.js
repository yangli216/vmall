const {test}=require('node:test');const assert=require('node:assert/strict');
const {deadline,paymentClock}=require('../../miniprogram/utils/order-clock');
test('payment countdown uses China order timestamps and never substitutes the phone clock for a missing server clock',()=>{
 const order={expires_at:'2026-11-19 16:00:00'};
 assert.equal(deadline(order.expires_at),Date.parse('2026-11-19T08:00:00Z'));
 assert.equal(paymentClock(order,Date.parse('2026-11-19T07:45:00Z')).remaining,'15:00');
 assert.equal(paymentClock(order,Date.parse('2026-11-19T07:59:59.999Z')).remaining,'0:01');
 assert.deepEqual(paymentClock(order,Date.parse('2026-11-19T08:00:00Z')),{expired:true,remaining:'0:00'});
 assert.equal(paymentClock(order,NaN),null);assert.equal(paymentClock({expires_at:null},Date.now()),null);
 assert.equal(paymentClock({expires_at:'2026-11-19 16:00:00;bad'},Date.now()),null);
});
