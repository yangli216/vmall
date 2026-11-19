import { BusinessError, requireValue } from '../domain/errors';

export function codeVersion(value: unknown): string {
  requireValue(value===undefined || ['release','trial','develop'].includes(value as string),'小程序码版本无效');
  return value as string || 'release';
}
export interface InviteCodeImage { mime: string; base64: string; invite_code: string; version: string; }

// Cloud Run's Open API sidecar supplies authentication. No token or AppSecret is
// accepted from clients, maintained here, or sent back in the image response.
export class WechatCodes {
  private cache=new Map<string,{expires:number;image:InviteCodeImage}>();
  private pending=new Map<string,Promise<InviteCodeImage>>();
  constructor(private transport:typeof fetch=fetch,private now:()=>number=Date.now) {}
  async generate(invite: string,version: string):Promise<InviteCodeImage> {
    codeVersion(version);
    requireValue(typeof invite==='string' && /^[A-Za-z0-9_-]{1,28}$/.test(invite),'邀请码格式不支持生成小程序码');
    const key=version+':'+invite,cached=this.cache.get(key);
    if(cached && cached.expires>this.now()) {
      this.cache.delete(key);this.cache.set(key,cached);return cached.image;
    }
    if(cached)this.cache.delete(key);
    const running=this.pending.get(key);if(running)return running;
    requireValue(this.pending.size<10,'海报生成繁忙，请稍后再试',503);
    const work=this.request(invite,version).then(image=>{
      if(this.cache.size>=64)this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key,{image,expires:this.now()+86400000});return image;
    });
    this.pending.set(key,work);
    try{return await work;}finally{this.pending.delete(key);}
  }
  private async request(invite:string,version:string):Promise<InviteCodeImage> {
    try {
      const response=await this.transport('http://api.weixin.qq.com/wxa/getwxacodeunlimit',{
        method:'POST',headers:{'content-type':'application/json'},redirect:'error',signal:AbortSignal.timeout(8000),
        body:JSON.stringify({scene:'ref='+invite,page:'pages/index/index',env_version:version,
          check_path:version==='release',width:430,auto_color:false,line_color:{r:0,g:0,b:0},is_hyaline:false})
      });
      requireValue(response.ok && Boolean(response.headers.get('x-openapi-seqid')),'海报暂不可用，请先使用好友分享',502);
      // Bound memory even if an upstream unexpectedly streams an oversized body.
      requireValue(response.body,'海报响应异常',502);
      const reader=response.body.getReader(),chunks:Buffer[]=[];let length=0;
      try {
        for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;
          requireValue(length<=256*1024,'海报图片过大，请稍后重试',502);chunks.push(Buffer.from(value));}
      }finally{await reader.cancel().catch(()=>{});}
      const bytes=Buffer.concat(chunks),png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpeg=bytes[0]===255 && bytes[1]===216 && bytes[2]===255;
      requireValue(length>24 && (png || jpeg),'海报暂不可用，请先使用好友分享',502);
      return {mime:png?'image/png':'image/jpeg',base64:bytes.toString('base64'),invite_code:invite,version};
    }catch(error){
      if(error instanceof BusinessError)throw error;
      throw new BusinessError('海报生成未完成，请稍后重试或使用好友分享',502);
    }
  }
}
export const inviteCodes=new WechatCodes();
