require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
(async () => {
  const address = (process.env.MYSQL_ADDRESS || '').split(':');
  const conn = await mysql.createConnection({host:address[0] || process.env.MYSQL_HOST || '127.0.0.1',port:Number(address[1] || process.env.MYSQL_PORT || 3306),user:process.env.MYSQL_USERNAME || process.env.MYSQL_USER || 'root',password:process.env.MYSQL_PASSWORD || '',database:process.env.MYSQL_DATABASE || 'pandou_db'});
  let locked=false;
  try {
    const [lock] = await conn.query("SELECT GET_LOCK('pandou_schema_migration', 10) AS acquired");
    if (lock[0].acquired !== 1) throw new Error('另一升级进程正在运行');
    locked=true;
    await conn.query("CREATE TABLE IF NOT EXISTS t_schema_migration (name VARCHAR(200) PRIMARY KEY, checksum CHAR(64) NOT NULL, state VARCHAR(16) NOT NULL, applied_time DATETIME NULL)");
    // MySQL DDL autocommits. Record STARTED before every statement so a crash after DDL can be resumed.
    for (const name of fs.readdirSync(path.join(__dirname,'../migrations')).filter(x=>x.endsWith('.sql')).sort()) {
      const source = fs.readFileSync(path.join(__dirname,'../migrations',name),'utf8').replace(/^\s*--.*$/gm,'');
      const statements=source.split(';').map(x=>x.trim()).filter(Boolean);
      for(let i=0;i<statements.length;i++) {
        const key=`${name}:${i}`,sql=statements[i],hash=crypto.createHash('sha256').update(sql).digest('hex');
        const [rows]=await conn.execute('SELECT checksum,state FROM t_schema_migration WHERE name=?',[key]);
        if(rows.length) {
          if(rows[0].checksum!==hash)throw new Error(`已开始的升级不可修改: ${key}`);
          if(rows[0].state==='APPLIED')continue;
        } else await conn.execute("INSERT INTO t_schema_migration(name,checksum,state) VALUES (?,?,'STARTED')",[key,hash]);
        try {await conn.query(sql);} catch(err) {
          // A duplicate on a fresh statement is schema drift, not an interrupted migration.
          if(!rows.length || !['ER_DUP_FIELDNAME','ER_DUP_KEYNAME','ER_TABLE_EXISTS_ERROR'].includes(err.code))throw err;
        }
        await conn.execute("UPDATE t_schema_migration SET state='APPLIED',applied_time=NOW() WHERE name=?",[key]);
      }
      console.log(`Applied ${name}`);
    }
  } finally {if(locked)await conn.query("SELECT RELEASE_LOCK('pandou_schema_migration')");await conn.end();}
})().catch(err=>{console.error('Migration failed:',err.message);process.exitCode=1;});
