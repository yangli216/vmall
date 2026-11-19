import dotenv from 'dotenv';
dotenv.config();
import { createApp } from './app';
import pool from './db';
import { reconcileOrders } from './services/orders';
const host=process.env.BIND_HOST || (process.env.NODE_ENV==='development'?'127.0.0.1':'0.0.0.0');
const server=createApp().listen(Number(process.env.PORT || 8080),host,()=>console.log('潘小兜服务已启动'));
const timer=process.env.SERVICE_MODE==='callbacks' ? undefined : setInterval(()=>reconcileOrders().catch(err=>console.error('Order reconciliation unavailable',err.code || err.name)),30000);
timer?.unref();
if(timer)reconcileOrders().catch(err=>console.error('Order reconciliation unavailable',err.code || err.name));
async function shutdown() {if(timer)clearInterval(timer);server.close(async()=>{await pool.end();process.exit(0);});}
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
