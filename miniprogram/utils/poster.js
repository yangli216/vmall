function wxCall(method,options) {
  return new Promise((resolve,reject)=>wx[method](Object.assign({},options,{success:resolve,fail:()=>reject(new Error('图片处理未完成，请稍后重试'))})));
}
function drawPoster(ctx,image,code,version) {
  ctx.fillStyle='#FFF8EF';ctx.fillRect(0,0,750,1160);
  ctx.fillStyle='#8E3326';ctx.fillRect(36,36,678,280);
  ctx.textAlign='center';ctx.fillStyle='#FFF8EF';ctx.font='bold 70px sans-serif';ctx.fillText('潘小兜老卤',375,160);
  ctx.font='30px sans-serif';ctx.fillText('预约现做 · 街坊一起尝鲜',375,228);
  ctx.fillStyle='#2D2926';ctx.font='bold 40px sans-serif';ctx.fillText('长按识别，进入小程序',375,390);
  ctx.fillStyle='#FFFFFF';ctx.fillRect(130,430,490,490);
  ctx.drawImage(image,160,460,430,430);
  ctx.fillStyle='#8E3326';ctx.font='bold 30px sans-serif';ctx.fillText('好友邀请码：'+code,375,982);
  ctx.fillStyle='#65574F';ctx.font='26px sans-serif';ctx.fillText('首次下单前可绑定推荐人',375,1030);
  ctx.fillText('预约日期、菜品价格以小程序为准',375,1072);
  if(version!=='release'){ctx.fillStyle='#8E3326';ctx.font='bold 24px sans-serif';ctx.fillText((version==='trial'?'体验版':'开发版')+' · 仅限联调，请勿公开推广',375,1120);}
}
async function createReferralPoster(page,image) {
  if(!image || !['image/png','image/jpeg'].includes(image.mime) || typeof image.base64!=='string' || image.base64.length>350000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64))throw new Error('邀请图片无效，请重试');
  if(!/^[A-Za-z0-9_-]{1,28}$/.test(image.invite_code) || !['release','trial','develop'].includes(image.version))throw new Error('邀请信息无效，请重试');
  const nodes=await new Promise(resolve=>wx.createSelectorQuery().in(page).select('#referralPosterCanvas').fields({node:true,size:true}).exec(resolve));
  const canvas=nodes && nodes[0] && nodes[0].node;if(!canvas)throw new Error('海报画布未就绪，请重试');
  canvas.width=750;canvas.height=1160;
  const fs=wx.getFileSystemManager(),file=wx.env.USER_DATA_PATH+'/referral-code-'+Date.now()+'-'+Math.random().toString(36).slice(2)+'.'+(image.mime==='image/png'?'png':'jpg');
  try {
    await new Promise((resolve,reject)=>fs.writeFile({filePath:file,data:image.base64,encoding:'base64',success:resolve,fail:()=>reject(new Error('图片写入失败，请检查存储空间后重试'))}));
    const code=canvas.createImage();
    await new Promise((resolve,reject)=>{code.onload=resolve;code.onerror=()=>reject(new Error('邀请图片读取失败，请重试'));code.src=file;});
    drawPoster(canvas.getContext('2d'),code,image.invite_code,image.version);
    const result=await wxCall('canvasToTempFilePath',{canvas,fileType:'png',destWidth:750,destHeight:1160});
    if(!result.tempFilePath)throw new Error('海报导出失败，请重试');
    return result.tempFilePath;
  }finally{fs.unlink({filePath:file,fail:()=>{}});}
}
module.exports={createReferralPoster,drawPoster};
