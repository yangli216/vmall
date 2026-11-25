// Persistent local integration environment. Never reads the cloud credentials.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const net=require('node:net');
const {spawn,execFileSync}=require('node:child_process');
const mysql=require('mysql2/promise');
const serverRoot=path.resolve(__dirname,'..'),projectRoot=path.resolve(serverRoot,'..');
const runtime=path.join(projectRoot,'.runtime/local-dev'),configPath=path.join(runtime,'config.json');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
fs.mkdirSync(runtime,{recursive:true,mode:0o700});fs.chmodSync(runtime,0o700);
let config;
function save(){fs.writeFileSync(configPath,JSON.stringify(config,null,2)+'\n',{mode:0o600});fs.chmodSync(configPath,0o600);}
function load(){
  config=fs.existsSync(configPath)?JSON.parse(fs.readFileSync(configPath,'utf8')):{
    mysqlPort:33317,port:18080,database:'pandou_local_dev',user:'pandou_local',
    password:crypto.randomBytes(24).toString('hex'),rootPassword:crypto.randomBytes(24).toString('hex')};
  if(config.database!=='pandou_local_dev' || config.user!=='pandou_local'
    || config.mysqlPort!==33317 || config.port!==18080)throw Error('Unexpected local environment configuration');
  save();
}
function environment(root=false){
  const env={...process.env};
  for(const key of Object.keys(env))if(key.startsWith('MYSQL_') || key.startsWith('WECHATPAY_') || ['WECHAT_APP_ID','NODE_ENV','ADMIN_OPENIDS','SERVICE_MODE','ALLOW_DEV_AUTH','PAYMENT_MODE','BIND_HOST','PORT','DOTENV_CONFIG_PATH','WECHAT_OPENAPI_ENABLED','PRODUCT_IMAGE_UPLOAD_ENABLED'].includes(key))delete env[key];
  return {...env,NODE_ENV:'development',ALLOW_DEV_AUTH:'true',PAYMENT_MODE:'mock',SERVICE_MODE:'app',BIND_HOST:'127.0.0.1',
    PORT:String(config.port),MYSQL_HOST:'127.0.0.1',MYSQL_PORT:String(config.mysqlPort),MYSQL_DATABASE:config.database,
    MYSQL_USER:root?'root':config.user,MYSQL_PASSWORD:root?config.rootPassword:config.password,
    ADMIN_OPENIDS:'wx_dev_local_admin',WECHAT_APP_ID:'wx8e2380dec308d5de',
    WECHAT_OPENAPI_ENABLED:'false',PRODUCT_IMAGE_UPLOAD_ENABLED:'false',DOTENV_CONFIG_PATH:path.join(runtime,'unused.env')};
}
function listening(port){return new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});
  socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));});}
function daemon(executable,args,log){
  const fd=fs.openSync(log,'a',0o600);
  const child=spawn(executable,args,{cwd:runtime,env:environment(),detached:true,stdio:['ignore',fd,fd]});
  fs.closeSync(fd);child.on('error',error=>console.error('Local process start failed:',error.code));child.unref();return child.pid;
}
async function health(){try{const response=await fetch(`http://127.0.0.1:${config.port}/api/health`,{signal:AbortSignal.timeout(1500)});
  const data=await response.json();return response.ok && data.status==='UP' && data.payment_mode==='mock' && data.local_development===true;
}catch{return false;}}
function ownedProcess(pid,marker){try{return !!pid && execFileSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).includes(marker);}catch{return false;}}
async function stopProcess(key,marker){
  const pid=config[key];if(!pid)return;
  if(ownedProcess(pid,marker)){
    process.kill(pid,'SIGTERM');
    for(let i=0;i<80 && ownedProcess(pid,marker);i++)await wait(100);
    if(ownedProcess(pid,marker))throw Error('Local process is still shutting down; retry shortly');
  }
  delete config[key];save();
}
async function start(){
  if(await health()){console.log('本机联调服务已运行：http://127.0.0.1:'+config.port);return;}
  if(await listening(config.port))throw Error('Local API port is occupied by another process');
  const dataDir=path.join(runtime,'mysql-data');
  const candidates=[process.env.PANDOU_LOCAL_MYSQLD,path.join(projectRoot,'.runtime/mysql-test/mysql-8.4.0-macos14-x86_64/bin/mysqld'),'/opt/homebrew/opt/mysql/bin/mysqld','/usr/local/opt/mysql/bin/mysqld'].filter(Boolean);
  const binary=candidates.find(p=>fs.existsSync(p));
  if(!binary)throw Error('MySQL 8 binary not found; set PANDOU_LOCAL_MYSQLD to its absolute path');
  if(!fs.existsSync(path.join(dataDir,'mysql'))){
    fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
    execFileSync(binary,['--no-defaults','--initialize-insecure',`--datadir=${dataDir}`],{stdio:'pipe'});
  }
  if(!await listening(config.mysqlPort)){
    config.mysqlPid=daemon(binary,['--no-defaults',`--datadir=${dataDir}`,'--bind-address=127.0.0.1',`--port=${config.mysqlPort}`,
      `--socket=${path.join(runtime,'mysql.sock')}`,`--pid-file=${path.join(runtime,'mysql.pid')}`,
      `--log-error=${path.join(runtime,'mysql.log')}`,'--mysqlx=OFF','--default-time-zone=+08:00'],path.join(runtime,'mysql-launch.log'));save();
    for(let i=0;i<100 && !await listening(config.mysqlPort);i++)await wait(150);
  }
  const connection={host:'127.0.0.1',port:config.mysqlPort,user:'root',password:config.rootPassword,dateStrings:true};
  let root;
  try{root=await mysql.createConnection(connection);}catch(error){
    if(error.code!=='ER_ACCESS_DENIED_ERROR')throw error;
    root=await mysql.createConnection({...connection,password:''});
    await root.query('ALTER USER CURRENT_USER() IDENTIFIED BY ?',[config.rootPassword]);
  }
  try{
    await root.query('CREATE DATABASE IF NOT EXISTS ?? CHARACTER SET utf8mb4',[config.database]);
    await root.changeUser({database:config.database,password:config.rootPassword});
    const [tables]=await root.query('SHOW TABLES');
    const fresh=tables.length===0;
    if(fresh){
      const source=fs.readFileSync(path.join(projectRoot,'init.sql'),'utf8').replace(/^\s*--.*$/gm,'');
      for(const sql of source.split(';').map(s=>s.trim()).filter(Boolean))await root.query(sql);
    }
    execFileSync(process.execPath,[path.join(__dirname,'migrate.js')],{env:environment(true),cwd:runtime,stdio:'pipe'});
    await root.query(fs.readFileSync(path.join(__dirname,'local-payment-schema.sql'),'utf8'));
    const accounts=[['wx_dev_local_customer','测试新客','LOCAL-CUSTOMER',0,0,'0.00','0.00'],
      ['wx_dev_local_member','测试会员','LOCAL-MEMBER',1,200,'20.00','120.00'],
      ['wx_dev_local_admin','测试掌柜','LOCAL-ADMIN',0,0,'0.00','0.00']];
    for(const [openid,nickname,code,member,points,red,total] of accounts)await root.execute(
      `INSERT IGNORE INTO t_user(openid,nickname,invite_code,member_card_no,is_member,normal_points,red_packet_points,total_consume_amount)
        VALUES (?,?,?,?,?,?,?,?)`,[openid,nickname,code,code,member,points,red,total]);
    if(fresh){
      await root.query("UPDATE t_product SET stock_qty=40,specification='份量见菜品名称（联调样品）',storage_note='本机测试商品，不用于实际销售'");
      const settings={SHOP_OPEN:'1',WORKSHOP_ANNOUNCEMENT:'本机联调环境：模拟支付不会扣款，所有余额均为测试数据',
        DELIVERY_AREAS:'临安区,锦城街道,锦北街道,锦南街道,青山湖街道,玲珑街道',WORKSHOP_ADDRESS:'浙江省杭州市临安区锦城街道临天八弄36号',WORKSHOP_LAT:'30.2339',WORKSHOP_LNG:'119.7247',DELIVERY_MAX_KM:'5',DELIVERY_PERSON_NAME:'测试配送员',DELIVERY_PERSON_PHONE:'13900000000'};
      for(const [key,value] of Object.entries(settings))await root.execute(
        'INSERT INTO t_system_config(config_key,config_value) VALUES (?,?) ON DUPLICATE KEY UPDATE config_value=VALUES(config_value)',[key,value]);
    }
    await root.query('CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?',[config.user,'127.0.0.1',config.password]);
    await root.query('ALTER USER ?@? IDENTIFIED BY ?',[config.user,'127.0.0.1',config.password]);
    await root.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ??.* TO ?@?',[config.database,config.user,'127.0.0.1']);
  }finally{await root.end();}
  execFileSync(process.execPath,[path.join(serverRoot,'node_modules/typescript/bin/tsc')],{cwd:serverRoot,stdio:'pipe'});
  config.serverPid=daemon(process.execPath,[path.join(serverRoot,'dist/index.js')],path.join(runtime,'server.log'));save();
  for(let i=0;i<80;i++){if(await health()){
    console.log('本机联调已启动：http://127.0.0.1:'+config.port);
    console.log('支付：模拟；数据库：独立持久联调库；身份：会员页可切换新客/会员/掌柜');return;
  }await wait(150);}
  throw Error('API did not become healthy; check .runtime/local-dev/server.log');
}
(async()=>{
  load();const command=process.argv[2] || 'start';
  if(command==='status')console.log(JSON.stringify({api:await health()?'UP':'DOWN',url:`http://127.0.0.1:${config.port}`,mysql:await listening(config.mysqlPort)?'UP':'DOWN',payment_mode:'mock'}));
  else if(command==='stop'){
    await stopProcess('serverPid',path.join(serverRoot,'dist/index.js'));
    await stopProcess('mysqlPid',path.join(runtime,'mysql-data'));
    console.log('本机联调已停止，测试数据已保留');
  }else if(command==='restart'){
    await stopProcess('serverPid',path.join(serverRoot,'dist/index.js'));await start();
  }else if(command==='start')await start();
  else throw Error('Use start, stop, restart or status');
})().catch(error=>{console.error('本机联调启动失败：',error.code || error.message);process.exitCode=1;});
