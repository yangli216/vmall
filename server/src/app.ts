import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import { randomUUID } from 'crypto';
import { query } from './db';
import { wechatAuth, userRequired, adminRequired, auditAdmin } from './middlewares/auth';
import * as product from './controllers/product';
import * as user from './controllers/user';
import * as order from './controllers/order';
import * as admin from './controllers/admin';
import * as support from './controllers/support';
import * as referral from './controllers/referral';
import * as privacy from './controllers/privacy';
import * as reports from './controllers/reports';
import { BusinessError } from './domain/errors';
import { simulationEnabled } from './services/local-simulation';
import * as localDev from './controllers/local-dev';

export function createApp() {
  const simulated=simulationEnabled();
  const serviceMode=process.env.SERVICE_MODE || 'app';
  if(!['app','callbacks'].includes(serviceMode))throw new Error('Invalid SERVICE_MODE');
  const app=new Koa(), router=new Router({prefix:'/api'});
  app.use(async(ctx,next)=>{
    const requestId=randomUUID();ctx.set('X-Request-Id',requestId);
    if(simulated)ctx.set('X-Pandou-Payment-Mode','mock');
    try {await next();}
    catch(err:any) {
      const status=err instanceof BusinessError ? err.status : [400,413].includes(err.status) ? err.status : 500;
      ctx.status=status;
      ctx.body=ctx.path.endsWith('/notify') ? {code:'FAIL',message:'通知未完成处理'} : {code:status,msg:status===500 ? '服务暂时异常，请稍后重试' : status===413 ? '图片或请求内容过大，请压缩后重试' : err instanceof BusinessError ? err.message : '请求内容格式无效',request_id:requestId};
      if(status>=500) console.error('Request failed',{requestId,path:ctx.path,code:err.code || err.name});
    }
  });
  // Public callback instances must never resolve a caller-supplied WeChat identity.
  // Keep this gate before body parsing and authentication, including on unknown paths.
  app.use(async(ctx,next)=>{
    if(!simulated && ctx.path.startsWith('/api/dev/')) {
      ctx.status=404;ctx.body={code:404,msg:'接口不存在'};return;
    }
    if(serviceMode==='callbacks' && !(
      (ctx.method==='POST' && ['/api/payment/notify','/api/refund/notify'].includes(ctx.path)) ||
      (['GET','HEAD'].includes(ctx.method) && ctx.path==='/api/health')
    )) {ctx.status=404;ctx.body={code:404,msg:'接口不存在'};return;}
    await next();
  });
  const regularBody=bodyParser({jsonLimit:'256kb',enableTypes:['json']});
  app.use((ctx,next)=>ctx.method==='POST' && ctx.path==='/api/admin/product/image' ? next() : regularBody(ctx,next));
  app.use((ctx,next)=>serviceMode==='callbacks' ? next() : wechatAuth(ctx,next));
  router.get('/health',async ctx=>{
    await query('SELECT request_id,earned_normal_points,refund_origin_status FROM t_order LIMIT 0');
    await query('SELECT normal_points_debt,red_packet_debt,forfeited_red_rewards FROM t_user LIMIT 0');
    await query('SELECT capacity_reserved FROM t_order LIMIT 0');
    await query('SELECT reserved_orders FROM t_batch_capacity LIMIT 0');
    await query('SELECT completed_by,completion_source,completion_note FROM t_order LIMIT 0');
    const cursor:any=await query('SELECT revision FROM t_activity_cursor WHERE id=1');
    if(cursor.length!==1)throw new Error('Activity cursor missing');
    await query('SELECT revision FROM t_admin_activity LIMIT 0');
    await query('SELECT id FROM t_account_flow LIMIT 0');
    await query('SELECT operator_id FROM t_admin_mutation LIMIT 0');
    await query('SELECT id FROM t_support_ticket LIMIT 0');
    await query('SELECT file_id,state FROM t_product_image LIMIT 0');
    await query('SELECT active_user_id,status FROM t_privacy_request LIMIT 0');
    await query('SELECT payer_paid_amount,payer_refund_amount FROM t_order LIMIT 0');
    await query('SELECT sign_date FROM t_user_sign_in LIMIT 0');
    if(simulated)await query('SELECT out_trade_no,trade_state FROM t_dev_payment LIMIT 0');
    ctx.body={status:'UP',...(simulated?{payment_mode:'mock',local_development:true}:{})};
  });
  router.get('/products',product.getProductList);router.get('/categories',product.getCategoryList);
  router.get('/config/all',admin.getSystemConfigs);router.get('/batches',order.getBatches);
  router.post('/payment/notify',order.paymentNotify);router.post('/refund/notify',order.refundNotify);
  router.post('/admin/verify',user.verifyAdminPasscode);
  router.post('/order/pay-success',order.payOrderSuccess);
  router.get('/user/info',userRequired,user.getOrCreateCurrentUser);
  router.get('/user/signin-status',userRequired,user.getSignInStatus);
  router.post('/user/signin',userRequired,user.doSignIn);
  router.get('/user/privacy',userRequired,privacy.myRequests);
  router.post('/user/privacy/request',userRequired,privacy.createRequest);
  router.post('/user/privacy/cancel',userRequired,privacy.cancelRequest);
  router.post('/user/clear-profile',userRequired,privacy.clearProfile);
  router.post('/user/update-profile',userRequired,user.updateProfile);
  router.post('/user/bind-referrer',userRequired,user.bindReferrer);
  router.post('/user/exit-member',userRequired,user.exitMembership);
  router.post('/user/activate-free',userRequired,user.activateFreeMembership);
  router.get('/user/account-flows',userRequired,user.accountFlows);
  router.get('/referral/my',userRequired,admin.getMyReferrals);
  router.post('/referral/code',userRequired,referral.createInviteCode);
  router.post('/order/calculate',userRequired,order.calculateOrder);
  router.post('/order/create',userRequired,order.createOrder);
  router.post('/order/payment',userRequired,order.payment);
  router.post('/order/sync-payment',userRequired,order.syncPayment);
  if(simulated) {
    router.get('/dev/accounts',userRequired,localDev.accounts);
    router.post('/dev/payment/confirm',userRequired,localDev.confirmPayment);
  }
  router.post('/order/cancel',userRequired,order.cancelOrder);
  router.post('/order/complete',userRequired,order.completeOrder);
  router.get('/order/list',userRequired,order.getOrderList);
  router.get('/order/detail',userRequired,order.getOrderDetail);
  router.post('/support/create',userRequired,support.createTicket);
  router.get('/support/my',userRequired,support.myTickets);
  const manage=(path:string,handler:any)=>router.post(path,adminRequired,auditAdmin,handler);
  router.post('/admin/product/image',adminRequired,bodyParser({jsonLimit:'3mb',enableTypes:['json']}),auditAdmin,product.uploadImage);
  manage('/admin/product/toggle',product.toggleProductStatus);manage('/admin/product/add',product.addProduct);
  manage('/admin/product/update',product.updateProduct);manage('/admin/product/delete',product.deleteProduct);
  manage('/admin/config/update',admin.updateSystemConfig);
  router.get('/admin/config',adminRequired,admin.getAdminConfig);
  manage('/admin/order/dispatch',order.dispatchDelivery);manage('/admin/order/ready',order.readyPickup);
  manage('/admin/order/complete',order.completeOrder);manage('/admin/order/cancel',order.cancelOrder);
  manage('/admin/order/refund',order.afterSalesRefund);
  router.get('/admin/orders',adminRequired,order.getAdminOrderList);
  router.get('/admin/preparation',adminRequired,order.preparation);
  router.get('/admin/batch-capacity',adminRequired,order.batchCapacity);
  router.get('/admin/activity',adminRequired,order.adminActivity);
  manage('/admin/product/stock',product.adjustBatchStock);
  router.get('/admin/members',adminRequired,admin.getMemberList);
  manage('/admin/member/update-status',admin.updateMemberStatus);manage('/admin/member/adjust-points',admin.adjustMemberPoints);
  manage('/admin/member/bind-referrer',admin.bindMemberReferrer);
  router.get('/admin/member/adjust-logs',adminRequired,admin.getPointAdjustLogs);
  router.get('/admin/reports/daily',adminRequired,reports.daily);
  router.get('/admin/reports/transactions',adminRequired,reports.transactions);
  router.get('/admin/privacy',adminRequired,privacy.adminRequests);
  manage('/admin/privacy/handle',privacy.handleRequest);
  router.get('/admin/support',adminRequired,support.adminTickets);
  manage('/admin/support/handle',support.handleTicket);
  app.use(router.routes()).use(router.allowedMethods());
  return app;
}
