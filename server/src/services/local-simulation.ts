// This mode is intentionally restricted to a separate loopback development DB.
// It must never turn merchant configuration failures into simulated payments.
export function simulationEnabled(env = process.env): boolean {
  const mode = env.PAYMENT_MODE || 'wechat';
  if (!['wechat', 'mock'].includes(mode)) throw new Error('Invalid PAYMENT_MODE');
  if (mode !== 'mock') return false;
  const address = (env.MYSQL_ADDRESS || '').split(':');
  const host = address[0] || env.MYSQL_HOST || '127.0.0.1';
  if (env.NODE_ENV !== 'development' || env.ALLOW_DEV_AUTH !== 'true'
    || !['127.0.0.1', 'localhost'].includes(host)
    || !/^pandou_local_[a-z0-9_]+$/.test(env.MYSQL_DATABASE || '')
    || (env.SERVICE_MODE && env.SERVICE_MODE !== 'app')
    || (env.BIND_HOST && env.BIND_HOST !== '127.0.0.1')) {
    throw new Error('Mock payments require loopback development and a pandou_local_* database');
  }
  return true;
}

export const LOCAL_ACCOUNTS = [
  {openid:'wx_dev_local_customer', label:'测试新客'},
  {openid:'wx_dev_local_member', label:'测试会员'},
  {openid:'wx_dev_local_admin', label:'测试掌柜'}
];
