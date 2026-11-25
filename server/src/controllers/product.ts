import { PoolConnection } from 'mysql2/promise';
import { Context } from 'koa';
import { query, withTransaction } from '../db';
import { positiveId, requireValue, text } from '../domain/errors';
import { uploadProductImage } from '../services/product-images';
import { fen, yuan } from '../domain/pricing';
export async function getProductList(ctx: Context) {
  const params: any[] = [];
  let sql = 'SELECT p.* FROM t_product p WHERE p.is_deleted = 0';
  if (ctx.query.category_id && ctx.query.category_id !== '0') { sql += ' AND p.category_id = ?'; params.push(positiveId(ctx.query.category_id)); }
  sql += ' ORDER BY p.sort_order DESC, p.id ASC';
  const rows: any = await query(sql, params);
  for (const p of rows) p.default_stock_qty = p.stock_qty;
  if (ctx.query.batch_date && ctx.query.batch_time) {
    const stocks: any = await query('SELECT product_id, available_qty FROM t_batch_stock WHERE batch_date = ? AND batch_time = ?', [ctx.query.batch_date, ctx.query.batch_time]);
    for (const p of rows) { const stock = stocks.find((s: any) => s.product_id === p.id); if (stock) p.stock_qty = stock.available_qty; }
  }
  ctx.body = { code: 0, data: rows.map((p: any) => ({ ...p, origin_price: yuan(fen(p.origin_price)), member_price: yuan(fen(p.member_price)) })) };
}
export async function getCategoryList(ctx: Context) {
  const rows: any = await query('SELECT id, name, sort_order FROM t_product_category WHERE is_deleted = 0 ORDER BY sort_order DESC, id ASC');
  ctx.body = { code: 0, data: rows };
}
export async function addCategory(ctx: Context) {
  const body = ctx.request.body as any;
  const name = text(body.name, '分类名称', 30);
  const sortOrder = body.sort_order === undefined || body.sort_order === '' ? 0 : Number(body.sort_order);
  requireValue(Number.isSafeInteger(sortOrder) && sortOrder >= 0 && sortOrder <= 9999, '排序权重须为0至9999的整数');
  const created = await withTransaction(async conn => {
    const [dup]: any = await conn.execute('SELECT id FROM t_product_category WHERE name = ? AND is_deleted = 0 FOR UPDATE', [name]);
    requireValue(!dup.length, '分类名称已存在', 409);
    const [res]: any = await conn.execute('INSERT INTO t_product_category (name, sort_order) VALUES (?, ?)', [name, sortOrder]);
    return { id: res.insertId, name, sort_order: sortOrder };
  });
  ctx.body = { code: 0, data: created, msg: '分类已新增' };
}
export async function updateCategory(ctx: Context) {
  const body = ctx.request.body as any, id = positiveId(body.id, '分类ID');
  const name = text(body.name, '分类名称', 30);
  const sortOrder = body.sort_order === undefined || body.sort_order === '' ? 0 : Number(body.sort_order);
  requireValue(Number.isSafeInteger(sortOrder) && sortOrder >= 0 && sortOrder <= 9999, '排序权重须为0至9999的整数');
  await withTransaction(async conn => {
    const [cur]: any = await conn.execute('SELECT id FROM t_product_category WHERE id = ? AND is_deleted = 0 FOR UPDATE', [id]);
    requireValue(cur.length, '分类不存在', 404);
    const [dup]: any = await conn.execute('SELECT id FROM t_product_category WHERE name = ? AND is_deleted = 0 AND id != ? FOR UPDATE', [name, id]);
    requireValue(!dup.length, '分类名称已存在', 409);
    await conn.execute('UPDATE t_product_category SET name = ?, sort_order = ? WHERE id = ?', [name, sortOrder, id]);
    await conn.execute('UPDATE t_product SET category_name = ? WHERE category_id = ?', [name, id]);
  });
  ctx.body = { code: 0, msg: '分类已更新' };
}
export async function deleteCategory(ctx: Context) {
  const id = positiveId((ctx.request.body as any).id, '分类ID');
  await withTransaction(async conn => {
    const [cur]: any = await conn.execute('SELECT id FROM t_product_category WHERE id = ? AND is_deleted = 0 FOR UPDATE', [id]);
    requireValue(cur.length, '分类不存在', 404);
    const [total]: any = await conn.execute('SELECT COUNT(*) AS cnt FROM t_product_category WHERE is_deleted = 0');
    requireValue(Number(total[0].cnt) > 1, '至少须保留一个菜品分类', 409);
    const [used]: any = await conn.execute('SELECT COUNT(*) AS cnt FROM t_product WHERE category_id = ? AND is_deleted = 0', [id]);
    requireValue(Number(used[0].cnt) === 0, `该分类下还有 ${used[0].cnt} 款菜品，请先调整菜品分类后再删`, 409);
    await conn.execute('UPDATE t_product_category SET is_deleted = 1 WHERE id = ?', [id]);
  });
  ctx.body = { code: 0, msg: '分类已删除' };
}
export async function toggleProductStatus(ctx: Context) {
  const body = ctx.request.body as any, id = positiveId(body.product_id || body.id);
  requireValue(body.status === 0 || body.status === 1, '在售状态无效');
  const result: any = await query('UPDATE t_product SET status = ? WHERE id = ? AND is_deleted = 0', [body.status, id]);
  requireValue(result.affectedRows, '菜品不存在', 404);
  ctx.body = { code: 0, msg: '状态已更新' };
}
async function productData(conn: PoolConnection, body: any, original: any = {}) {
  const data = { ...original, ...body };
  const title = text(data.title, '菜品名称', 100), origin = fen(data.origin_price), member = fen(data.member_price ?? data.origin_price);
  requireValue(origin > 0 && origin <= 100000 && member > 0 && member <= origin, '会员价须大于0且不超过原价，单价不超过1000元');
  const categoryId = positiveId(data.category_id || 1, '分类');
  const [cats]: any = await conn.execute('SELECT id, name FROM t_product_category WHERE id = ? AND is_deleted = 0', [categoryId]);
  requireValue(cats.length, '所选分类不存在或已删除');
  const stock = data.stock_qty === undefined ? 0 : Number(data.stock_qty);
  requireValue(Number.isSafeInteger(stock) && stock >= 0 && stock <= 9999, '每批可售份数须为0至9999的整数');
  const cover = text(data.cover_img, '菜品图片', 500, false);
  requireValue(!cover || /^https:\/\//.test(cover) || /^cloud:\/\//.test(cover), '图片须为上传的实拍图或HTTPS地址');
  return [title, yuan(origin), yuan(member), categoryId, cats[0].name, cover,
    text(data.intro, '简介', 255, false), text(data.badge, '标签', 30, false), stock,
    text(data.specification, '规格', 100, false), text(data.storage_note, '保存说明', 255, false)];
}
async function registeredCover(conn:any,cover:any) {
  if(typeof cover==='string' && cover.startsWith('cloud://')) {
    const [rows]:any=await conn.execute("SELECT id FROM t_product_image WHERE file_id=? AND state='READY'",[cover]);
    requireValue(rows.length,'请先通过实拍上传完成图片保存');
  }
}
export async function uploadImage(ctx:Context) {
  const body=ctx.request.body as any;
  const data=await uploadProductImage(ctx.state.user.id,body.request_id,body.base64);
  ctx.set('Cache-Control','private, no-store');ctx.body={code:0,data};
}
export async function addProduct(ctx: Context) {
  const result:any=await withTransaction(async conn=>{
    const data = await productData(conn, ctx.request.body);
    await registeredCover(conn,data[5]);
    const [result]:any=await conn.execute(`INSERT INTO t_product (title, origin_price, member_price, category_id, category_name, cover_img, intro, badge, stock_qty, specification, storage_note, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`, data);
    return result;
  });
  ctx.body = { code: 0, data: { id: result.insertId }, msg: '菜品已新增' };
}
export async function updateProduct(ctx: Context) {
  const body = ctx.request.body as any, id = positiveId(body.id);
  await withTransaction(async conn => {
    const [rows]: any = await conn.execute('SELECT * FROM t_product WHERE id = ? AND is_deleted = 0 FOR UPDATE', [id]);
    requireValue(rows.length, '菜品不存在', 404);
    const data = await productData(conn, body, rows[0]); await registeredCover(conn, data[5]);
    await conn.execute(`UPDATE t_product SET title=?, origin_price=?, member_price=?, category_id=?, category_name=?, cover_img=?, intro=?, badge=?, stock_qty=?, specification=?, storage_note=? WHERE id=?`, [...data, id]);
  });
  ctx.body = { code: 0, msg: '菜品已保存；每批可售份数应用于未开始预订的批次' };
}
export async function deleteProduct(ctx: Context) {
  const result: any = await query('UPDATE t_product SET is_deleted = 1, status = 0 WHERE id = ?', [positiveId((ctx.request.body as any).id)]);
  requireValue(result.affectedRows, '菜品不存在', 404);
  ctx.body = { code: 0, msg: '菜品已下架归档' };
}
export async function adjustBatchStock(ctx: Context) {
  const body=ctx.request.body as any, id=positiveId(body.product_id);
  requireValue(typeof body.batch_date==='string' && /^\d{4}-\d{2}-\d{2}$/.test(body.batch_date) && typeof body.batch_time==='string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.batch_time),'批次无效');
  requireValue(Number.isSafeInteger(body.available_qty) && body.available_qty>=0 && body.available_qty<=9999,'剩余份数须为0至9999的整数');
  await withTransaction(async conn=>{
    const [rows]: any=await conn.execute('SELECT id FROM t_product WHERE id=? AND is_deleted=0 FOR UPDATE',[id]);
    requireValue(rows.length,'菜品不存在',404);
    await conn.execute('INSERT INTO t_batch_stock(batch_date,batch_time,product_id,available_qty) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE available_qty=VALUES(available_qty)',[body.batch_date,body.batch_time,id,body.available_qty]);
  });
  ctx.body={code:0,msg:'本批剩余份数已调整'};
}
