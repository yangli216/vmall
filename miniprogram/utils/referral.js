function referralFrom(options) {
  if(!options || typeof options!=='object')return '';
  let code=options.referrer;
  if(!code && typeof options.scene==='string'){
    try{code=decodeURIComponent(options.scene).replace(/^ref=/,'');}catch(error){return '';}
  }
  return typeof code==='string' && /^[A-Za-z0-9_-]{1,32}$/.test(code)?code:'';
}
function captureReferral(options) {
  const code=referralFrom(options);
  if(code)wx.setStorageSync('pandou_pending_referrer',code);
  return code;
}
module.exports={referralFrom,captureReferral};
