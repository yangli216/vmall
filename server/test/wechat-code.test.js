const {test}=require('node:test');const assert=require('node:assert/strict');
const {WechatCodes,codeVersion}=require('../dist/services/wechat-code');
// An image fixture for transport checks; it is deliberately not a usable QR code.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=','base64');
const image=()=>new Response(png,{headers:{'x-openapi-seqid':'test-cloud-call','content-type':'image/png'}});
test('invitation codes use the cloud sidecar, fixed page and server-owned scene, separating all app versions',async()=>{
 const calls=[];let now=100;
 const codes=new WechatCodes(async(url,options)=>{calls.push({url,options});return image();},()=>now);
 const [first,duplicate]=await Promise.all([codes.generate('PXD-ABC','release'),codes.generate('PXD-ABC','release')]);
 assert.equal(calls.length,1);assert.equal(first.base64,duplicate.base64);assert.equal(first.invite_code,'PXD-ABC');
 assert.equal(calls[0].url,'http://api.weixin.qq.com/wxa/getwxacodeunlimit');assert.equal(calls[0].options.redirect,'error');
 const body=JSON.parse(calls[0].options.body);assert.equal(body.scene,'ref=PXD-ABC');assert.equal(body.page,'pages/index/index');assert.equal(body.check_path,true);assert.equal(body.env_version,'release');assert.equal(body.width,430);
 await codes.generate('PXD-ABC','release');assert.equal(calls.length,1);
 await codes.generate('PXD-ABC','trial');assert.equal(JSON.parse(calls[1].options.body).check_path,false);
 const other=await codes.generate('PXD-OTHER','release');assert.equal(other.invite_code,'PXD-OTHER');assert.equal(calls.length,3);
 now+=86400001;await codes.generate('PXD-ABC','release');assert.equal(calls.length,4);
 for(const value of ['bad',null,'','RELEASE'])assert.throws(()=>codeVersion(value));assert.equal(codeVersion(undefined),'release');
 for(const invite of ['a&ref=OTHER','../secret','汉字','x'.repeat(29)])await assert.rejects(()=>codes.generate(invite,'release'));
 assert.equal(calls.length,4);
});
test('missing cloud proof, provider JSON and transport details cannot become a successful image or expose secrets',async()=>{
 let mode='missing',calls=0;
 const codes=new WechatCodes(async()=>{
  calls++;
  if(mode==='missing')return new Response(png);
  if(mode==='json')return new Response(JSON.stringify({errcode:41030,errmsg:'upstream-secret-detail'}),{headers:{'x-openapi-seqid':'test'}});
  if(mode==='network')throw new Error('private-token-and-internal-host');
  return image();
 });
 for(const value of ['missing','json','network']){mode=value;await assert.rejects(()=>codes.generate('PXD-ABC','release'),error=>{assert.equal(error.status,502);assert.doesNotMatch(error.message,/upstream-secret|private-token/);return true;});}
 mode='ok';assert.equal((await codes.generate('PXD-ABC','release')).mime,'image/png');assert.equal(calls,4);
});
test('oversized streamed responses are cancelled and failed generations can be retried',async()=>{
 let cancelled=false;
 const codes=new WechatCodes(async()=>new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(200000));},cancel(){cancelled=true;}}),{headers:{'x-openapi-seqid':'test'}}));
 await assert.rejects(()=>codes.generate('PXD-ABC','release'),/过大/);assert.equal(cancelled,true);
});
test('image cache and concurrent generation limits bound resource use',async()=>{
 let calls=0;const codes=new WechatCodes(async()=>{calls++;return image();});
 for(let i=0;i<65;i++)await codes.generate('PXD-'+i,'release');await codes.generate('PXD-0','release');assert.equal(calls,66);
 const releases=[];const busy=new WechatCodes(()=>new Promise(resolve=>releases.push(()=>resolve(image()))));
 const work=Array.from({length:10},(_,i)=>busy.generate('PXD-'+i,'release'));
 await assert.rejects(()=>busy.generate('PXD-over-limit','release'),error=>error.status===503);assert.equal(releases.length,10);
 releases.forEach(release=>release());await Promise.all(work);
 assert.equal((await busy.generate('PXD-0','release')).invite_code,'PXD-0');
});
