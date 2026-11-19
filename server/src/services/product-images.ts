import { createHash } from 'crypto';
import sharp from 'sharp';
import COS from 'cos-nodejs-sdk-v5';
import { BusinessError, requireValue } from '../domain/errors';
import { withTransaction } from '../db';

export const MAX_IMAGE_BYTES=2*1024*1024;
export function imageBytes(value:unknown):Buffer {
  requireValue(typeof value==='string' && value.length>0 && value.length<=4*Math.ceil(MAX_IMAGE_BYTES/3) && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),'图片编码无效或超过2MB');
  const bytes=Buffer.from(value,'base64');
  requireValue(bytes.length>0 && bytes.length<=MAX_IMAGE_BYTES && bytes.toString('base64')===value,'图片编码无效或超过2MB');
  return bytes;
}
export async function normalizeImage(bytes:Buffer) {
  requireValue(bytes.length>0 && bytes.length<=MAX_IMAGE_BYTES,'图片须小于2MB');
  try {
    const source=sharp(bytes,{limitInputPixels:16000000,failOn:'warning',animated:false});
    const meta=await source.metadata();
    requireValue(['jpeg','png','webp'].includes(meta.format || '') && (meta.pages || 1)===1,'仅支持单张JPG、PNG或WebP图片');
    const {data,info}=await source.rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true})
      .flatten({background:'#ffffff'}).jpeg({quality:85,mozjpeg:true}).toBuffer({resolveWithObject:true});
    requireValue(data.length<=1024*1024,'图片内容过大，请裁剪后重试');
    return {bytes:data,width:info.width,height:info.height};
  } catch(error) {
    if(error instanceof BusinessError)throw error;
    throw new BusinessError('图片无法读取或像素过大，请重新选择JPG、PNG或WebP图片');
  }
}
export function imageConfig(env=process.env) {
  requireValue(env.PRODUCT_IMAGE_UPLOAD_ENABLED==='true' && env.WECHAT_OPENAPI_ENABLED==='true','图片上传暂不可用，请联系掌柜配置存储',503);
  const environment=env.PRODUCT_IMAGE_ENV_ID || '',bucket=env.PRODUCT_IMAGE_BUCKET || '',region=env.PRODUCT_IMAGE_REGION || '';
  requireValue(/^[a-z0-9-]{1,80}$/.test(environment) && /^[a-z0-9-]{3,100}-\d+$/.test(bucket) && /^ap-[a-z]+(?:-[a-z]+)*$/.test(region),'图片存储配置未完成',503);
  return {environment,bucket,region};
}
export class ProductImageStorage {
  constructor(private transport:typeof fetch=fetch) {}
  async put(key:string,bytes:Buffer,config:ReturnType<typeof imageConfig>):Promise<string> {
    requireValue(/^products\/[a-f0-9]{64}\.jpg$/.test(key),'图片路径无效');
    const signal=AbortSignal.timeout(18000);
    const json=async(path:string,body?:unknown)=>{
      const response=await this.transport('http://api.weixin.qq.com'+path,{method:body?'POST':'GET',redirect:'error',signal,
        headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
      requireValue(response.ok && response.headers.get('x-openapi-seqid'),'云存储接口不可用',502);
      requireValue(response.body,'云存储响应异常',502);
      const reader=response.body.getReader(),chunks:Buffer[]=[];let size=0;
      try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;requireValue(size<=32768,'云存储响应异常',502);chunks.push(Buffer.from(part.value));}}
      finally{await reader.cancel().catch(()=>{});}
      return JSON.parse(Buffer.concat(chunks).toString());
    };
    try {
      const auth=await json('/_/cos/getauth');
      requireValue(['TmpSecretId','TmpSecretKey','Token'].every(k=>typeof auth[k]==='string' && auth[k].length>0) && Number(auth.ExpiredTime)>Date.now()/1000+30,'云存储授权不可用',502);
      const encoded=await json('/_/cos/metaid/encode',{openid:'',bucket:config.bucket,paths:[key]});
      const metadata=encoded?.respdata?.x_cos_meta_field_strs?.[0];
      requireValue(encoded.errcode===0 && typeof metadata==='string' && metadata.length>0 && metadata.length<=8192,'云存储图片标识不可用',502);
      const host=config.bucket+'.cos.'+config.region+'.myqcloud.com';
      const headers:Record<string,string>={'host':host,'content-type':'image/jpeg','content-length':String(bytes.length),
        'content-md5':createHash('md5').update(bytes).digest('base64'),'x-cos-security-token':auth.Token,'x-cos-meta-fileid':metadata};
      headers.authorization=COS.getAuthorization({SecretId:auth.TmpSecretId,SecretKey:auth.TmpSecretKey,Method:'PUT',Pathname:'/'+key,Headers:headers,Expires:60});
      const response=await this.transport('https://'+host+'/'+key,{method:'PUT',headers,body:bytes,redirect:'error',signal});
      await response.body?.cancel().catch(()=>{});
      requireValue(response.status===200 && response.headers.get('etag'),'图片未能写入云存储，请重试',502);
      return 'cloud://'+config.environment+'.'+config.bucket+'/'+key;
    } catch(error) {
      if(error instanceof BusinessError)throw error;
      throw new BusinessError('图片上传未完成，请稍后重试',502);
    }
  }
}
export const productImageStorage=new ProductImageStorage();
let inFlight=0;
export async function uploadProductImage(operator:number,requestId:unknown,value:unknown) {
  requireValue(typeof requestId==='string' && /^[A-Za-z0-9_-]{16,80}$/.test(requestId),'图片请求编号无效');
  const config=imageConfig();
  requireValue(inFlight<2,'图片上传繁忙，请稍后重试',503);
  inFlight++;
  try {
    const original=imageBytes(value),hash=createHash('sha256').update(original).digest('hex');
    const key='products/'+createHash('sha256').update(operator+':'+requestId+':'+hash).digest('hex')+'.jpg';
    const image=await normalizeImage(original);
    return await withTransaction(async conn=>{
      await conn.execute(`INSERT IGNORE INTO t_product_image(operator_id,request_id,request_hash,object_key) VALUES(?,?,?,?)`,[operator,requestId,hash,key]);
      const [rows]:any=await conn.execute('SELECT * FROM t_product_image WHERE operator_id=? AND request_id=? FOR UPDATE',[operator,requestId]);
      const row=rows[0];requireValue(row && row.request_hash===hash,'该图片请求已用于其他照片，请重新选择',409);
      if(row.state==='READY')return {file_id:row.file_id,width:row.width,height:row.height,byte_size:row.byte_size};
      const fileId=await productImageStorage.put(key,image.bytes,config);
      await conn.execute("UPDATE t_product_image SET state='READY',file_id=?,byte_size=?,width=?,height=? WHERE id=?",[fileId,image.bytes.length,image.width,image.height,row.id]);
      return {file_id:fileId,width:image.width,height:image.height,byte_size:image.bytes.length};
    });
  } finally {inFlight--;}
}
