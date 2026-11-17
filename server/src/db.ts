import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

// 微信云托管内网 MySQL 连接池
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
  keepAliveInitialDelay: 10000
});

export async function query<T = any>(sql: string, params?: any[]): Promise<T> {
  const [results] = await pool.execute(sql, params);
  return results as T;
}

export default pool;
