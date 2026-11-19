// Stored order times are China local time, independent of the phone's timezone.
function deadline(value) {
  if(typeof value!=='string' || !/^20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value))return NaN;
  return Date.parse(value.replace(' ','T')+'+08:00');
}
function paymentClock(order,serverNow) {
  const end=deadline(order.expires_at);
  if(!Number.isFinite(end) || !Number.isFinite(serverNow))return null;
  const seconds=Math.max(0,Math.ceil((end-serverNow)/1000));
  return {expired:seconds===0,remaining:Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0')};
}
module.exports={deadline,paymentClock};
