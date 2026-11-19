import { requireValue } from './errors';

// Money is calculated as integer fen. Decimal input is validated, never silently truncated.
export function fen(value: unknown, label = '金额'): number {
  requireValue(typeof value === 'string' || typeof value === 'number', `${label}无效`);
  const s = String(value);
  requireValue(/^\d+(\.\d{1,2})?$/.test(s), `${label}须为非负金额，最多两位小数`);
  const [whole, fraction = ''] = s.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  requireValue(Number.isSafeInteger(result) && result <= 100000000, `${label}超出范围`);
  return result;
}
export const yuan = (value: number): string => (value / 100).toFixed(2);
export interface CartItem { product_id: number; quantity: number; }
export function normalizeItems(input: unknown): CartItem[] {
  requireValue(Array.isArray(input) && input.length > 0 && input.length <= 50, '购物车须包含1至50种菜品');
  const merged = new Map<number, number>();
  for (const item of input) {
    requireValue(item && typeof item === 'object', '购物车格式无效');
    requireValue(Number.isSafeInteger(item.product_id) && item.product_id > 0, '商品ID无效');
    requireValue(Number.isSafeInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 99, '每种菜品须购买1至99份');
    const quantity = (merged.get(item.product_id) || 0) + item.quantity;
    requireValue(quantity <= 99, '每种菜品最多购买99份');
    merged.set(item.product_id, quantity);
  }
  return [...merged].sort((a, b) => a[0] - b[0]).map(([product_id, quantity]) => ({ product_id, quantity }));
}
export function priceOrder(products: any[], input: CartItem[], user: any, config: Record<string, string>, options: any) {
  requireValue(options.delivery_type === 1 || options.delivery_type === 2, '请选择作坊自送或到店自提');
  for (const key of ['use_normal_points', 'use_red_packet_points']) {
    requireValue(options[key] === undefined || typeof options[key] === 'boolean', '积分选项格式无效');
  }
  let origin = 0, base = 0;
  const verifiedItems = input.map(item => {
    const p = products.find(p => Number(p.id) === item.product_id);
    requireValue(p && !p.is_deleted, '购物车包含已下架菜品，请重新选择', 409);
    requireValue(p.status === 1, `「${p.title}」已售罄`, 409);
    requireValue(Number(p.stock_qty) >= item.quantity, `「${p.title}」剩余份数不足`, 409);
    const originPrice = fen(p.origin_price), price = user.is_member === 1 ? fen(p.member_price) : originPrice;
    requireValue(price > 0 && price <= originPrice, '菜品价格异常，请联系掌柜', 409);
    origin += originPrice * item.quantity;
    base += price * item.quantity;
    return { product_id: item.product_id, title: p.title, cover_img: p.cover_img,
      price: yuan(price), quantity: item.quantity, subtotal: yuan(price * item.quantity) };
  });
  requireValue(base > 0 && base <= 1000000, '单笔货款须在0至10000元之间');
  // A partial 5-yuan voucher is never consumed for goods below 5 yuan.
  const normal = options.use_normal_points && user.normal_points >= 100 && base >= 500 ? 500 : 0;
  const remaining = base - normal;
  const ratio = Number(config.RED_PACKET_MAX_DEDUCT_RATIO);
  const maxRed = Math.min(fen(user.red_packet_points || 0), Math.floor(base * Math.round(ratio * 100) / 100), remaining);
  const requested = options.custom_red_amount === undefined ? maxRed : fen(options.custom_red_amount, '红包抵扣');
  const red = options.use_red_packet_points && user.is_member === 1 ? Math.min(requested, maxRed) : 0;
  const goodsCash = remaining - red;
  const delivery = options.delivery_type === 1 && base < fen(config.DELIVERY_FREE_THRESHOLD) ? fen(config.DELIVERY_BASE_FEE) : 0;
  return {
    goods_origin_total: yuan(origin), goods_member_total: yuan(base), member_discount: yuan(origin - base),
    normal_deduct: yuan(normal), used_normal_points: normal ? 100 : 0,
    red_deduct: yuan(red), used_red_points: yuan(red), delivery_fee: yuan(delivery),
    final_pay_amount: yuan(goodsCash + delivery), commission_cash_base: yuan(goodsCash),
    predict_commission: yuan(Math.floor((goodsCash * Math.round(Number(config.COMMISSION_RATE) * 100) + 50) / 100)),
    verified_items: verifiedItems
  };
}
