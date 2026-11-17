import { Context } from 'koa';
import { query } from '../db';

/**
 * 获取菜品列表
 * 支持按分类筛选，返回菜品、价格、会员价与在售/沽清状态
 */
export async function getProductList(ctx: Context) {
  const { category_id } = ctx.query;
  let sql = 'SELECT * FROM t_product';
  const params: any[] = [];

  if (category_id) {
    sql += ' WHERE category_id = ?';
    params.push(category_id);
  }
  sql += ' ORDER BY sort_order DESC, id ASC';

  const list: any = await query(sql, params);
  
  // 确保价格格式化为两位小数字符串，方便前端显示
  const formatted = list.map((item: any) => ({
    ...item,
    origin_price: Number(item.origin_price).toFixed(2),
    member_price: Number(item.member_price).toFixed(2),
    points: Math.floor(Number(item.member_price))
  }));

  ctx.body = { code: 0, msg: 'ok', data: formatted };
}

/**
 * 店主端：一键切换商品在售/沽清状态
 */
export async function toggleProductStatus(ctx: Context) {
  const body = ctx.request.body as { id?: number; product_id?: number; status: number };
  const productId = body.product_id || body.id;
  const status = body.status;

  if (!productId || typeof status !== 'number') {
    ctx.status = 400;
    ctx.body = { code: 400, msg: '缺少必要参数 (product_id 或 status)' };
    return;
  }

  await query('UPDATE t_product SET status = ? WHERE id = ?', [status, productId]);
  ctx.body = { code: 0, msg: '状态更新成功', data: { id: productId, status } };
}

/**
 * 店主端：快速发布/上架新菜品
 */
export async function addProduct(ctx: Context) {
  const body = ctx.request.body as {
    title: string;
    cover_img?: string;
    origin_price: number;
    member_price?: number;
    intro?: string;
    badge?: string;
    category_id?: number;
    category_name?: string;
  };

  if (!body.title || !body.origin_price) {
    ctx.status = 400;
    ctx.body = { code: 400, msg: '菜品标题与价格必填' };
    return;
  }

  const originPrice = parseFloat(body.origin_price.toString());
  const memberPrice = body.member_price ? parseFloat(body.member_price.toString()) : Number((originPrice * 0.88).toFixed(2));
  const coverImg = body.cover_img || 'https://images.unsplash.com/photo-1544025162-d76694265947?w=400&q=80';
  const intro = body.intro || '潘小兜实体工坊现捞现卤，纯手工慢煨入味';
  const badge = body.badge || '新品出锅';
  const categoryId = body.category_id || 1;

  const res: any = await query(
    `INSERT INTO t_product (title, cover_img, origin_price, member_price, intro, badge, category_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    [body.title, coverImg, originPrice, memberPrice, intro, badge, categoryId]
  );

  ctx.body = {
    code: 0,
    msg: '菜品上架成功',
    data: {
      id: res.insertId,
      title: body.title,
      origin_price: originPrice.toFixed(2),
      member_price: memberPrice.toFixed(2),
      status: 1
    }
  };
}
