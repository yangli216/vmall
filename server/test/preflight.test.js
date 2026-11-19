const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {checkConfiguration, migrationChecks} = require('../scripts/preflight');
const {privateKey, publicKey} = crypto.generateKeyPairSync('rsa', {modulusLength: 2048,
  privateKeyEncoding: {type: 'pkcs8', format: 'pem'}, publicKeyEncoding: {type: 'spki', format: 'pem'}});
function validConfig() {
  return {NODE_ENV:'production', ALLOW_DEV_AUTH:'false', ADMIN_OPENIDS:'operator-openid',
    MYSQL_HOST:'127.0.0.1', MYSQL_USER:'app', MYSQL_PASSWORD:'test-only-secret', MYSQL_DATABASE:'test',
    WECHAT_APP_ID:'wx0123456789abcdef', WECHATPAY_MCH_ID:'1234567890', WECHATPAY_CERT_SERIAL:'A'.repeat(40),
    WECHATPAY_API_V3_KEY:'0'.repeat(32), WECHATPAY_PRIVATE_KEY:privateKey, WECHATPAY_PUBLIC_KEY:publicKey,
    WECHATPAY_PUBLIC_KEY_ID:'PUB_KEY_ID_123456789',
    WECHATPAY_NOTIFY_URL:'https://callback.example.com/api/payment/notify',
    WECHATPAY_REFUND_NOTIFY_URL:'https://callback.example.com/api/refund/notify'};
}
test('deployment preflight validates production keys and paths without disclosing values', () => {
  const config = validConfig(), checks = checkConfiguration(config, '22.1.0');
  assert.ok(checks.every(v => v.ok));
  const output = JSON.stringify(checks);
  for (const value of [config.MYSQL_PASSWORD, privateKey, publicKey, config.WECHATPAY_API_V3_KEY, config.ADMIN_OPENIDS]) assert.equal(output.includes(value), false);
  for (const change of [{SERVICE_MODE:'invalid-role'}, {ALLOW_DEV_AUTH:'true'}, {WECHAT_OPENAPI_ENABLED:'yes'}, {NODE_ENV:'development'}, {MYSQL_PASSWORD:''}, {ADMIN_OPENIDS:''},
    {WECHATPAY_PRIVATE_KEY:'malformed'}, {WECHATPAY_PRIVATE_KEY:publicKey}, {WECHATPAY_API_V3_KEY:'短'.repeat(32)},
    {WECHATPAY_PUBLIC_KEY_PATH:'/absent/key.pem', WECHATPAY_PUBLIC_KEY:''}, {WECHATPAY_PREVIOUS_KEY_ID:config.WECHATPAY_PUBLIC_KEY_ID},
    {WECHATPAY_NOTIFY_URL:'https://callback.example.com/wrong-path'},
    {WECHATPAY_NOTIFY_URL:'https://callback.example.com/api/payment/notify?secret=1'},
    {WECHATPAY_NOTIFY_URL:'https://user:pass@callback.example.com/api/payment/notify'},
    {WECHATPAY_NOTIFY_URL:'http://callback.example.com/api/payment/notify'}]) {
    assert.ok(checkConfiguration({...config, ...change}, '22.1.0').some(v => !v.ok), Object.keys(change).join(','));
  }
  assert.ok(checkConfiguration(config, '20.1.0').some(v => !v.ok));
});
test('migration preflight rejects unapplied, modified and unknown statements', () => {
  const dir = path.join(__dirname, '../migrations');
  const rows = fs.readdirSync(dir).filter(v => v.endsWith('.sql')).sort().flatMap(name =>
    fs.readFileSync(path.join(dir, name), 'utf8').replace(/^\s*--.*$/gm, '').split(';').map(v => v.trim()).filter(Boolean)
      .map((sql, i) => ({name:`${name}:${i}`, state:'APPLIED', checksum:crypto.createHash('sha256').update(sql).digest('hex')})));
  assert.ok(migrationChecks(rows).every(v => v.ok));
  for (const changed of [rows.slice(1), [{...rows[0], state:'STARTED'}, ...rows.slice(1)],
    [{...rows[0], checksum:'bad'}, ...rows.slice(1)], [...rows, {name:'future:0', state:'APPLIED', checksum:'future'}]]) {
    assert.ok(migrationChecks(changed).some(v => !v.ok));
  }
});
