import { createSign, createVerify, createDecipheriv, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { BusinessError, requireValue } from '../domain/errors';

export interface PayConfig {
  appid: string; mchid: string; serial: string; privateKey: string; apiKey: string;
  publicKeys: Record<string, string>; notifyUrl: string; refundNotifyUrl: string;
}
function pem(env: NodeJS.ProcessEnv, key: string) {
  return env[key] ? env[key]!.replace(/\\n/g, '\n') : env[`${key}_PATH`] ? readFileSync(env[`${key}_PATH`]!, 'utf8') : '';
}
export function payConfig(env = process.env): PayConfig {
  const publicKeys: Record<string, string> = {};
  if (env.WECHATPAY_PUBLIC_KEY_ID) publicKeys[env.WECHATPAY_PUBLIC_KEY_ID] = pem(env, 'WECHATPAY_PUBLIC_KEY');
  if (env.WECHATPAY_PREVIOUS_KEY_ID) publicKeys[env.WECHATPAY_PREVIOUS_KEY_ID] = pem(env, 'WECHATPAY_PREVIOUS_KEY');
  const config = { appid: env.WECHAT_APP_ID || '', mchid: env.WECHATPAY_MCH_ID || '', serial: env.WECHATPAY_CERT_SERIAL || '',
    privateKey: pem(env, 'WECHATPAY_PRIVATE_KEY'), apiKey: env.WECHATPAY_API_V3_KEY || '', publicKeys,
    notifyUrl: env.WECHATPAY_NOTIFY_URL || '', refundNotifyUrl: env.WECHATPAY_REFUND_NOTIFY_URL || '' };
  requireValue(config.appid && config.mchid && config.serial && config.privateKey && Buffer.byteLength(config.apiKey) === 32
    && Object.values(publicKeys).some(Boolean) && /^https:\/\/[^?#]+$/.test(config.notifyUrl) && /^https:\/\/[^?#]+$/.test(config.refundNotifyUrl),
    '微信支付尚未配置完成，请联系掌柜', 503);
  return config;
}
export function rsaSign(message: string, privateKey: string): string {
  return createSign('RSA-SHA256').update(message).sign(privateKey, 'base64');
}
export function verifyWechatSignature(body: string, headers: Record<string, any>, keys: Record<string, string>, now = Date.now()) {
  const serial = headers['wechatpay-serial'], timestamp = headers['wechatpay-timestamp'], nonce = headers['wechatpay-nonce'], signature = headers['wechatpay-signature'];
  requireValue(typeof serial === 'string' && Boolean(keys[serial]), '未知的微信支付验签密钥', 401);
  requireValue(typeof timestamp === 'string' && /^\d+$/.test(timestamp) && Math.abs(now / 1000 - Number(timestamp)) <= 300, '微信支付签名已过期', 401);
  requireValue(typeof nonce === 'string' && nonce.length > 0 && typeof signature === 'string' && !signature.startsWith('WECHATPAY/SIGNTEST/'), '微信支付签名无效', 401);
  requireValue(createVerify('RSA-SHA256').update(`${timestamp}\n${nonce}\n${body}\n`).verify(keys[serial], signature, 'base64'), '微信支付签名校验失败', 401);
}
export function decryptResource(resource: any, apiKey: string) {
  requireValue(resource?.algorithm === 'AEAD_AES_256_GCM' && typeof resource.ciphertext === 'string' && typeof resource.nonce === 'string', '支付通知格式无效');
  const data = Buffer.from(resource.ciphertext, 'base64');
  requireValue(data.length > 16, '支付通知密文无效');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(apiKey), resource.nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  decipher.setAAD(Buffer.from(resource.associated_data || ''));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString('utf8'));
}
export class WechatPayError extends BusinessError {
  constructor(public providerCode: string, public requestId: string) { super('微信支付处理未完成，请稍后重试或联系掌柜', 502); }
}
export class WechatPay {
  constructor(public config = payConfig(), private transport: typeof fetch = fetch) {}
  async request(method: string, path: string, input?: any): Promise<any> {
    const timestamp = Math.floor(Date.now() / 1000).toString(), nonce = randomBytes(16).toString('hex');
    const body = input === undefined ? '' : JSON.stringify(input);
    const signature = rsaSign(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`, this.config.privateKey);
    const response = await this.transport(`https://api.mch.weixin.qq.com${path}`, {
      method, headers: { Accept: 'application/json', 'Content-Type': 'application/json',
        'Wechatpay-Serial': Object.keys(this.config.publicKeys)[0],
        Authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${this.config.mchid}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${this.config.serial}",signature="${signature}"` },
      ...(body ? { body } : {}), signal: AbortSignal.timeout(8000)
    });
    const raw = await response.text();
    verifyWechatSignature(raw, Object.fromEntries(response.headers.entries()), this.config.publicKeys);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!response.ok) throw new WechatPayError(parsed.code || 'UNKNOWN', response.headers.get('request-id') || '');
    return parsed;
  }
  async prepay(order: any, openid: string) {
    const result = await this.request('POST', '/v3/pay/transactions/jsapi', {
      appid: this.config.appid, mchid: this.config.mchid, description: '潘小兜老卤订单', out_trade_no: order.order_sn,
      time_expire: new Date(`${order.expires_at.replace(' ', 'T')}+08:00`).toISOString(), notify_url: this.config.notifyUrl,
      amount: { total: Math.round(Number(order.pay_amount) * 100), currency: 'CNY' }, payer: { openid }
    });
    requireValue(typeof result.prepay_id === 'string', '微信支付下单响应异常', 502);
    return result.prepay_id as string;
  }
  paymentParams(prepayId: string) {
    const timeStamp = String(Math.floor(Date.now() / 1000)), nonceStr = randomBytes(16).toString('hex'), packageValue = `prepay_id=${prepayId}`;
    return { timeStamp, nonceStr, package: packageValue, signType: 'RSA',
      paySign: rsaSign(`${this.config.appid}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`, this.config.privateKey) };
  }
  query(orderSn: string) { return this.request('GET', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderSn)}?mchid=${encodeURIComponent(this.config.mchid)}`); }
  close(orderSn: string) { return this.request('POST', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderSn)}/close`, { mchid: this.config.mchid }); }
  refund(order: any) {
    const amount = Math.round(Number(order.pay_amount) * 100);
    return this.request('POST', '/v3/refund/domestic/refunds', { out_trade_no: order.order_sn, out_refund_no: order.refund_sn,
      reason: '订单退款', notify_url: this.config.refundNotifyUrl, amount: { refund: amount, total: amount, currency: 'CNY' } });
  }
  queryRefund(refundSn: string) { return this.request('GET', `/v3/refund/domestic/refunds/${encodeURIComponent(refundSn)}`); }
  notification(raw: string, headers: Record<string, any>) {
    verifyWechatSignature(raw, headers, this.config.publicKeys);
    const envelope = JSON.parse(raw);
    return { event: envelope.event_type, data: decryptResource(envelope.resource, this.config.apiKey) };
  }
}
