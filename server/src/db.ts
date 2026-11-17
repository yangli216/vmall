import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

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
  decimalNumbers: true // 自动将 DECIMAL 转换为数值/字符串，避免不精确序列化
});

/**
 * 通用安全参数化 SQL 查询
 */
export async function query<T = any>(sql: string, params?: any[]): Promise<T> {
  const [results] = await pool.execute(sql, params);
  return results as T;
}

/**
 * 数据库原子事务包装器 (工匠精神：保障下单与资金核销 ACID 强一致性)
 */
export async function withTransaction<T>(
  callback: (conn: mysql.PoolConnection) => Promise<T>
): Promise<T> {
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    const result = await callback(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export default pool;
