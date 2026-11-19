// Read-only deployment checks. Never print environment values, database errors or PEM contents.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function checkConfiguration(env, nodeVersion = process.versions.node) {
  const checks = [];
  const check = (name, pass) => checks.push({name, ok: Boolean(pass)});
  check('Node.js >= 22', Number(nodeVersion.split('.')[0]) >= 22);
  check('NODE_ENV=production', env.NODE_ENV === 'production');
  check('ALLOW_DEV_AUTH=false', env.ALLOW_DEV_AUTH === 'false');
  check('SERVICE_MODE', !env.SERVICE_MODE || ['app','callbacks'].includes(env.SERVICE_MODE));
  check('WECHAT_OPENAPI_ENABLED flag', !env.WECHAT_OPENAPI_ENABLED || ['true','false'].includes(env.WECHAT_OPENAPI_ENABLED));
  check('PRODUCT_IMAGE_UPLOAD_ENABLED flag', !env.PRODUCT_IMAGE_UPLOAD_ENABLED || ['true','false'].includes(env.PRODUCT_IMAGE_UPLOAD_ENABLED));
  if(env.PRODUCT_IMAGE_UPLOAD_ENABLED==='true') {
    check('product image sidecar enabled',env.WECHAT_OPENAPI_ENABLED==='true');
    check('product image storage configuration',/^[a-z0-9-]{1,80}$/.test(env.PRODUCT_IMAGE_ENV_ID || '') && /^[a-z0-9-]{3,100}-\d+$/.test(env.PRODUCT_IMAGE_BUCKET || '') && /^ap-[a-z]+(?:-[a-z]+)*$/.test(env.PRODUCT_IMAGE_REGION || ''));
  }
  const admins = (env.ADMIN_OPENIDS || '').split(',').map(v => v.trim()).filter(Boolean);
  check('ADMIN_OPENIDS', admins.length > 0 && admins.every(v => /^[\w-]{1,64}$/.test(v)));
  check('MYSQL connection parameters', Boolean((env.MYSQL_ADDRESS || env.MYSQL_HOST) &&
    (env.MYSQL_USERNAME || env.MYSQL_USER) && env.MYSQL_PASSWORD && env.MYSQL_DATABASE));
  const address = (env.MYSQL_ADDRESS || '').split(':');
  const port = Number(address[1] || env.MYSQL_PORT || 3306);
  check('MYSQL port', Number.isInteger(port) && port > 0 && port <= 65535);
  check('WECHAT_APP_ID', /^wx[0-9a-f]{16}$/.test(env.WECHAT_APP_ID || ''));
  check('WECHATPAY_MCH_ID', /^\d{6,20}$/.test(env.WECHATPAY_MCH_ID || ''));
  check('WECHATPAY_CERT_SERIAL', /^[0-9a-f]{16,64}$/i.test(env.WECHATPAY_CERT_SERIAL || ''));
  check('WECHATPAY_API_V3_KEY (32 bytes)', Buffer.byteLength(env.WECHATPAY_API_V3_KEY || '') === 32);
  function key(name, privateKey) {
    try {
      const value = env[name] ? env[name].replace(/\\n/g, '\n') : fs.readFileSync(env[name + '_PATH'], 'utf8');
      const parsed = privateKey ? crypto.createPrivateKey(value) : crypto.createPublicKey(value);
      check(name + ' (readable RSA >= 2048)', parsed.asymmetricKeyType === 'rsa' && parsed.asymmetricKeyDetails.modulusLength >= 2048);
    } catch { check(name + ' (readable RSA >= 2048)', false); }
  }
  key('WECHATPAY_PRIVATE_KEY', true);
  check('WECHATPAY_PUBLIC_KEY_ID', /^PUB_KEY_ID_\d+$/.test(env.WECHATPAY_PUBLIC_KEY_ID || ''));
  key('WECHATPAY_PUBLIC_KEY', false);
  if (env.WECHATPAY_PREVIOUS_KEY_ID || env.WECHATPAY_PREVIOUS_KEY || env.WECHATPAY_PREVIOUS_KEY_PATH) {
    check('WECHATPAY_PREVIOUS_KEY_ID', /^PUB_KEY_ID_\d+$/.test(env.WECHATPAY_PREVIOUS_KEY_ID || '') && env.WECHATPAY_PREVIOUS_KEY_ID !== env.WECHATPAY_PUBLIC_KEY_ID);
    key('WECHATPAY_PREVIOUS_KEY', false);
  }
  for (const [name, expectedPath] of [['WECHATPAY_NOTIFY_URL', '/api/payment/notify'], ['WECHATPAY_REFUND_NOTIFY_URL', '/api/refund/notify']]) {
    let valid = false;
    try {
      const url = new URL(env[name]);
      valid = url.protocol === 'https:' && url.pathname === expectedPath && !url.search && !url.hash &&
        !url.username && !url.password && !/^(localhost|127\.|0\.|\[?::1\]?|YOUR_CALLBACK_DOMAIN$)/i.test(url.hostname);
    } catch {}
    check(name + ' (HTTPS callback path)', valid);
  }
  return checks;
}

function migrationChecks(rows, migrationsDir = path.join(__dirname, '../migrations')) {
  const recorded = new Map(rows.map(row => [row.name, row]));
  const checks = [];
  for (const name of fs.readdirSync(migrationsDir).filter(v => v.endsWith('.sql')).sort()) {
    const statements = fs.readFileSync(path.join(migrationsDir, name), 'utf8').replace(/^\s*--.*$/gm, '').split(';').map(v => v.trim()).filter(Boolean);
    for (let i = 0; i < statements.length; i++) {
      const key = `${name}:${i}`, row = recorded.get(key);
      const hash = crypto.createHash('sha256').update(statements[i]).digest('hex');
      checks.push({name: `migration ${key}`, ok: Boolean(row && row.state === 'APPLIED' && row.checksum === hash)});
      recorded.delete(key);
    }
  }
  // A newer database must not silently pass a check for an older deployment.
  checks.push({name: 'no unknown migrations', ok: recorded.size === 0});
  return checks;
}

async function main() {
  require('dotenv').config();
  const env = process.env;
  const checks = checkConfiguration(env);
  if (!process.argv.includes('--config-only')) {
    const explicitDatabase = checks.find(v => v.name === 'MYSQL connection parameters').ok;
    if (!explicitDatabase) checks.push({name: 'database checks (explicit connection required)', ok: false});
    else {
      let conn;
      try {
        const address = (env.MYSQL_ADDRESS || '').split(':');
        conn = await require('mysql2/promise').createConnection({
          host: address[0] || env.MYSQL_HOST, port: Number(address[1] || env.MYSQL_PORT || 3306),
          user: env.MYSQL_USERNAME || env.MYSQL_USER, password: env.MYSQL_PASSWORD,
          database: env.MYSQL_DATABASE, connectTimeout: 8000
        });
        const [rows] = await conn.execute('SELECT name, checksum, state FROM t_schema_migration');
        checks.push(...migrationChecks(rows));
        for (const sql of ['SELECT request_id,payment_state,paid_goods_amount,earned_normal_points,refund_origin_status FROM t_order LIMIT 0',
          'SELECT normal_points_debt,red_packet_debt,forfeited_red_rewards FROM t_user LIMIT 0',
          'SELECT capacity_reserved FROM t_order LIMIT 0', 'SELECT reserved_orders FROM t_batch_capacity LIMIT 0',
          'SELECT completed_by,completion_source,completion_note FROM t_order LIMIT 0',
          'SELECT revision FROM t_admin_activity LIMIT 0',
          'SELECT id FROM t_account_flow LIMIT 0', 'SELECT operator_id FROM t_admin_mutation LIMIT 0',
          'SELECT id FROM t_support_ticket LIMIT 0', 'SELECT file_id,state FROM t_product_image LIMIT 0', 'SELECT active_user_id,status FROM t_privacy_request LIMIT 0', 'SELECT payer_paid_amount,payer_refund_amount FROM t_order LIMIT 0', 'SELECT available_qty FROM t_batch_stock LIMIT 0']) await conn.execute(sql);
        checks.push({name: 'core schema readable', ok: true});
        const [cursor]=await conn.execute('SELECT revision FROM t_activity_cursor WHERE id=1');
        checks.push({name:'activity cursor initialized',ok:cursor.length===1});
      } catch { checks.push({name: 'database connection / schema readable', ok: false}); }
      finally { if (conn) await conn.end(); }
    }
  }
  console.log(JSON.stringify({ok: checks.every(v => v.ok), mode: process.argv.includes('--config-only') ? 'configuration' : 'configuration-and-database', checks,
    manual_checks_required: ['recoverable database backup', 'public ingress allows callback paths only', 'trusted WeChat gateway identity', 'real payment and refund acceptance']}, null, 2));
  if (checks.some(v => !v.ok)) process.exitCode = 1;
}

module.exports = {checkConfiguration, migrationChecks};
if (require.main === module) main().catch(() => { console.error('Preflight failed; inspect configuration and database access without sharing secret values.'); process.exitCode = 1; });
