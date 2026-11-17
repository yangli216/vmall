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

  if (category_id && category_id !== '0' && category_id !== '1') {
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
 * 获取动态菜品分类列表
 */
export async function getCategoryList(ctx: Context) {
  const defaultCats = [
    { id: 1, name: '🔥 招牌必吃' },
    { id: 2, name: '秘制酱牛肉' },
    { id: 3, name: '麻辣鸭副件' },
    { id: 4, name: '爽脆下酒菜' },
    { id: 5, name: '手工饮品' }
  ];
  ctx.body = { code: 0, msg: 'ok', data: defaultCats };
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

/**
 * 店主端：编辑更新现有菜品 (标题、价格、会员价、简介、标签)
 */
export async function updateProduct(ctx: Context) {
  const body = ctx.request.body as {
    id: number;
    title: string;
    origin_price: number;
    member_price?: number;
    intro?: string;
    badge?: string;
    category_id?: number;
    cover_img?: string;
  };

  if (!body.id || !body.title || !body.origin_price) {
    ctx.status = 400;
    ctx.body = { code: 400, msg: '菜品ID、标题与价格必填' };
    return;
  }

  const originPrice = parseFloat(body.origin_price.toString());
  const memberPrice = body.member_price ? parseFloat(body.member_price.toString()) : Number((originPrice * 0.88).toFixed(2));
  const categoryId = body.category_id || 1;
  const badge = body.badge || '手工老卤';
  const intro = body.intro || '纯手工慢卤';
  const coverImg = body.cover_img || 'https://images.unsplash.com/photo-1544025162-d76694265947?w=400';

  await query(
    `UPDATE t_product 
     SET title = ?, origin_price = ?, member_price = ?, intro = ?, badge = ?, category_id = ?, cover_img = ?
     WHERE id = ?`,
    [body.title, originPrice, memberPrice, intro, badge, categoryId, coverImg, body.id]
  );

  ctx.body = { code: 0, msg: '菜品修改保存成功', data: { id: body.id } };
}

/**
 * 店主端：删除菜品
 */
export async function deleteProduct(ctx: Context) {
  const { id } = ctx.request.body as { id: number };
  if (!id) {
    ctx.status = 400;
    ctx.body = { code: 400, msg: '缺少菜品ID' };
    return;
  }

  await query('DELETE FROM t_product WHERE id = ?', [id]);
  ctx.body = { code: 0, msg: '菜品已删除', data: { id } };
}
