const {test}=require('node:test');const assert=require('node:assert/strict');const sharp=require('sharp');
const {normalizeImage,imageBytes,imageConfig,ProductImageStorage}=require('../dist/services/product-images');
test('real photo decoding rotates, bounds dimensions and strips EXIF before producing JPEG',async()=>{
 const original=await sharp({create:{width:2000,height:1000,channels:3,background:'#784420'}}).jpeg().withMetadata({orientation:6}).toBuffer();
 assert.ok((await sharp(original).metadata()).exif);
 const result=await normalizeImage(imageBytes(original.toString('base64'))),meta=await sharp(result.bytes).metadata();
 assert.equal(meta.format,'jpeg');assert.equal(result.width,800);assert.equal(result.height,1600);assert.equal(meta.exif,undefined);assert.equal(meta.xmp,undefined);assert.ok(result.bytes.length<=1024*1024);
 const png=await sharp({create:{width:10,height:10,channels:4,background:'#0000'}}).png().toBuffer();
 assert.equal((await sharp((await normalizeImage(png)).bytes).metadata()).channels,3);
 const webp=await sharp(png).webp().toBuffer();assert.equal((await normalizeImage(webp)).width,10);
 for(const bytes of [Buffer.from('<svg width="1" height="1"></svg>'),Buffer.from('not-an-image'),await sharp({create:{width:5000,height:5000,channels:3,background:'red'}}).png().toBuffer()])await assert.rejects(()=>normalizeImage(bytes));
 for(const value of ['',null,'YWJj\n','AA=A','AB==',Buffer.alloc(2*1024*1024+1).toString('base64')])assert.throws(()=>imageBytes(value));
});
test('cloud image PUT uses transient sidecar credentials, signed metadata and a bounded fixed destination',async()=>{
 const calls=[],key='products/'+'a'.repeat(64)+'.jpg',config={environment:'prod-test',bucket:'test-bucket-12345',region:'ap-shanghai'};
 const auth={TmpSecretId:'TEMP_ID',TmpSecretKey:'TEMP_SECRET',Token:'TEMP_TOKEN',ExpiredTime:Math.floor(Date.now()/1000)+3600};
 const sidecar=body=>new Response(JSON.stringify(body),{headers:{'x-openapi-seqid':'test'}});
 const storage=new ProductImageStorage(async(url,options)=>{calls.push({url,options});return calls.length===1?sidecar(auth):calls.length===2?sidecar({errcode:0,respdata:{x_cos_meta_field_strs:['signed-file-id']}}):new Response('',{headers:{etag:'"test-md5"'}});});
 const bytes=Buffer.from('jpeg-fixture'),id=await storage.put(key,bytes,config);
 assert.equal(id,'cloud://prod-test.test-bucket-12345/'+key);assert.equal(calls[0].url,'http://api.weixin.qq.com/_/cos/getauth');assert.equal(calls[1].url,'http://api.weixin.qq.com/_/cos/metaid/encode');
 assert.deepEqual(JSON.parse(calls[1].options.body),{openid:'',bucket:config.bucket,paths:[key]});
 assert.equal(calls[2].url,'https://test-bucket-12345.cos.ap-shanghai.myqcloud.com/'+key);assert.equal(calls[2].options.method,'PUT');
 const headers=calls[2].options.headers;assert.equal(headers['x-cos-meta-fileid'],'signed-file-id');assert.equal(headers['x-cos-security-token'],'TEMP_TOKEN');assert.match(headers.authorization,/q-signature=/);assert.match(headers.authorization,/x-cos-meta-fileid/);
 assert.equal(headers['content-length'],String(bytes.length));assert.equal(headers['content-md5'],require('crypto').createHash('md5').update(bytes).digest('base64'));
 assert.ok(calls.every(c=>c.options.signal===calls[0].options.signal && c.options.redirect==='error'));assert.doesNotMatch(id,/TEMP_|signed-file/);
 await assert.rejects(()=>storage.put('../other',bytes,config));assert.equal(calls.length,3);
});
test('missing cloud proof, expired credentials, metadata failures and failed writes cannot produce successful assets',async()=>{
 const config={environment:'prod-test',bucket:'test-bucket-12345',region:'ap-shanghai'},key='products/'+'a'.repeat(64)+'.jpg';
 const auth={TmpSecretId:'TEMP_ID',TmpSecretKey:'TEMP_SECRET',Token:'TEMP_TOKEN',ExpiredTime:Math.floor(Date.now()/1000)+3600};
 for(const failure of ['proof','expired','metadata','write','network','oversize']){
  let count=0;
  const storage=new ProductImageStorage(async()=>{
   count++;if(failure==='network')throw new Error('private-secret-detail');
   let body=count===1?{...auth,...(failure==='expired'?{ExpiredTime:1}:{})}:{errcode:0,respdata:{x_cos_meta_field_strs:failure==='metadata'?[]:['meta']}};
   if(failure==='oversize')return new Response('x'.repeat(32769),{headers:{'x-openapi-seqid':'test'}});
   if(count===3)return new Response('storage-secret-error',{status:403});
   return new Response(JSON.stringify(body),{headers:failure==='proof'?{}:{'x-openapi-seqid':'test'}});
  });
  await assert.rejects(()=>storage.put(key,Buffer.from('fixture'),config),error=>{assert.equal(error.status,502);assert.doesNotMatch(error.message,/TEMP_|private-secret|storage-secret/);return true;});
 }
 assert.throws(()=>imageConfig({PRODUCT_IMAGE_UPLOAD_ENABLED:'true'}));
 assert.deepEqual(imageConfig({PRODUCT_IMAGE_UPLOAD_ENABLED:'true',WECHAT_OPENAPI_ENABLED:'true',PRODUCT_IMAGE_ENV_ID:'prod-test',PRODUCT_IMAGE_BUCKET:'test-bucket-12345',PRODUCT_IMAGE_REGION:'ap-shanghai'}),config);
});
