import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import cors from '@koa/cors';
import dotenv from 'dotenv';
import { query } from './db';
import { wechatAuth, adminRequired } from './middlewares/auth';

import * as productCtrl from './controllers/product';
import * as userCtrl from './controllers/user';
import * as orderCtrl from './controllers/order';
import * as adminCtrl from './controllers/admin';

dotenv.config();

const app = new Koa();
const router = new Router({ prefix: '/api' });

// 中间件配置
app.use(cors());
app.use(bodyParser());

// 全局日志与异常捕获
app.use(async (ctx, next) => {
  const start = Date.now();
  try {
    await next();
  } catch (err: any) {
    console.error('Request error:', err);
    ctx.status = err.status || 500;
    ctx.body = { code: ctx.status, msg: err.message || '内部服务错误' };
  }
  const ms = Date.now() - start;
  console.log(`${ctx.method} ${ctx.url} - ${ctx.status} [${ms}ms] [openid: ${ctx.headers['x-wx-openid'] || ctx.query.openid || 'none'}]`);
});

// 全局注入微信用户身份解析
app.use(wechatAuth);

// 健康与就绪检查 (探测数据库连接是否真实可用，保障容器服务探针正常工作)
router.get('/health', async (ctx) => {
  try {
    await query('SELECT 1');
    ctx.body = { status: 'UP', database: 'CONNECTED', timestamp: new Date().toISOString() };
  } catch (err: any) {
    ctx.status = 503;
    ctx.body = { status: 'DOWN', error: err.message, timestamp: new Date().toISOString() };
  }
});

// 1. 商品相关 (读公开，写与管理必须为掌柜)
router.get('/products', productCtrl.getProductList);
router.get('/categories', productCtrl.getCategoryList);
router.post('/admin/product/toggle', adminRequired, productCtrl.toggleProductStatus);
router.post('/admin/product/add', adminRequired, productCtrl.addProduct);
router.post('/admin/product/update', adminRequired, productCtrl.updateProduct);
router.post('/admin/product/delete', adminRequired, productCtrl.deleteProduct);

// 2. 用户与会员相关
router.get('/user/info', userCtrl.getOrCreateCurrentUser);
router.post('/user/update-profile', userCtrl.updateProfile);
router.post('/user/bind-referrer', userCtrl.bindReferrer);
router.post('/user/exit-member', userCtrl.exitMembership);
router.post('/user/activate-free', userCtrl.activateFreeMembership);
router.post('/admin/verify', userCtrl.verifyAdminPasscode);

// 3. 订单与自配送结算相关 (订单查询与取消内置严格数据隔离)
router.post('/order/calculate', orderCtrl.calculateOrder);
router.post('/order/create', orderCtrl.createOrder);
router.post('/order/pay-success', orderCtrl.payOrderSuccess);
router.post('/admin/order/dispatch', adminRequired, orderCtrl.dispatchDelivery);
router.post('/order/complete', orderCtrl.completeOrder);
router.post('/order/cancel', orderCtrl.cancelOrder);
router.get('/order/list', orderCtrl.getOrderList);

// 4. 运营配置与推广统计
router.get('/config/all', adminCtrl.getSystemConfigs);
router.post('/admin/config/update', adminRequired, adminCtrl.updateSystemConfig);
router.get('/referral/my', adminCtrl.getMyReferrals);

app.use(router.routes()).use(router.allowedMethods());

const PORT = process.env.PORT || 80;
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(` 潘小兜老卤小作坊 · 微信云托管服务已在端口 ${PORT} 启动 `);
  console.log(` 营业执照：杭州临安潘小兜食品小作坊 | 临天八弄36号 `);
  console.log(` 许可证号：JY13301850326102 (含网络经营) `);
  console.log(`=======================================================`);
});
