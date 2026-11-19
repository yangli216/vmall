import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { adminAuditContext } from './services/audit-context';

dotenv.config();

// 微信云托管内网 MySQL 连接池配置
// 云托管环境下会自动注入环境变量 MYSQL_ADDRESS (如 10.0.0.1:3306), MYSQL_USERNAME, MYSQL_PASSWORD
let host = process.env.MYSQL_HOST || '127.0.0.1';
let port = parseInt(process.env.MYSQL_PORT || '3306', 10);

if (process.env.MYSQL_ADDRESS) {
  const parts = process.env.MYSQL_ADDRESS.split(':');
  host = parts[0];
  if (parts.length > 1) {
    port = parseInt(parts[1], 10);
  }
}

const pool = mysql.createPool({
  host: host,
  port: port,
  user: process.env.MYSQL_USERNAME || process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'pandou_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  dateStrings: true,
  timezone: '+08:00',
  decimalNumbers: true // 自动将 DECIMAL 转换为数值/字符串，避免不精确序列化
});

pool.on('connection', (connection: any) => { connection.query("SET time_zone = '+08:00'"); });

/**
 * 通用安全参数化 SQL 查询
 */
export async function query<T = any>(sql: string, params?: any[]): Promise<T> {
  const audit = adminAuditContext.getStore();
  if (audit && !audit.committed && /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) {
    return withTransaction(async conn => {
      const [results] = await conn.execute(sql, params);
      return results as T;
    });
  }
  const [results] = await pool.execute(sql, params);
  return results as T;
}

/**
 * 数据库原子事务包装器 (工匠精神：保障下单与资金核销 ACID 强一致性)
 */
export async function withTransaction<T>(
  callback: (conn: mysql.PoolConnection) => Promise<T>
): Promise<T> {
  // Only retry errors whose entire transaction has been rolled back. Network or
  // commit errors have an uncertain outcome and must never be blindly replayed.
  for (let attempt = 0; ; attempt++) {
    const conn = await pool.getConnection();
    let retry = false;
    try {
      await conn.beginTransaction();
      const result = await callback(conn);
      const audit = adminAuditContext.getStore();
      if (audit && !audit.committed) {
        await conn.execute('INSERT INTO t_admin_audit (operator_id, action, target_id) VALUES (?, ?, ?)',
          [audit.operatorId, audit.action, audit.targetId]);
      }
      await conn.commit();
      if (audit) audit.committed = true;
      return result;
    } catch (err: any) {
      try { await conn.rollback(); }
      catch { throw err; }
      retry = attempt < 2 && ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(err.code);
      if (!retry) throw err;
    } finally {
      conn.release();
    }
    if (retry) await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1) + Math.floor(Math.random() * 50)));
  }
}

export default pool;
