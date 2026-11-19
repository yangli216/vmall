import { PoolConnection } from 'mysql2/promise';
import { requireValue } from '../domain/errors';
import { fen, yuan } from '../domain/pricing';
export async function changeBalance(conn: PoolConnection, userId: number, kind: 'NORMAL_POINT' | 'RED_PACKET', delta: number, event: string, orderId: number | null, reason: string, operatorId: number | null = null) {
  const field = kind === 'NORMAL_POINT' ? 'normal_points' : 'red_packet_points';
  const [rows]: any = await conn.execute(`SELECT ${field} AS balance FROM t_user WHERE id = ? FOR UPDATE`, [userId]);
  requireValue(rows.length > 0, '账户不存在', 404);
  const before = kind === 'NORMAL_POINT' ? Number(rows[0].balance) : fen(rows[0].balance);
  const after = before + delta;
  requireValue(Number.isSafeInteger(delta) && after >= 0, '账户余额不足', 409);
  const format = (v: number) => kind === 'NORMAL_POINT' ? String(v) : yuan(v);
  await conn.execute(`UPDATE t_user SET ${field} = ? WHERE id = ?`, [format(after), userId]);
  await conn.execute(`INSERT INTO t_account_flow (user_id, order_id, account_type, event_type, amount, before_val, after_val, reason, operator_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, orderId, kind, event, format(delta), format(before), format(after), reason, operatorId]);
}

type RewardKind = 'NORMAL_POINT' | 'RED_PACKET';
async function rewardDebt(conn: PoolConnection, userId: number, kind: RewardKind) {
  const field = kind === 'NORMAL_POINT' ? 'normal_points_debt' : 'red_packet_debt';
  const [rows]: any = await conn.execute(`SELECT ${field} AS debt FROM t_user WHERE id=? FOR UPDATE`, [userId]);
  requireValue(rows.length, '账户不存在', 404);
  return {field, value:kind === 'NORMAL_POINT' ? Number(rows[0].debt) : fen(rows[0].debt)};
}
async function writeDebt(conn: PoolConnection, userId: number, kind: RewardKind, field: string, before: number, after: number, orderId: number, reason: string) {
  const format = (v: number) => kind === 'NORMAL_POINT' ? String(v) : yuan(v);
  await conn.execute(`UPDATE t_user SET ${field}=? WHERE id=?`, [format(after),userId]);
  await conn.execute(`INSERT INTO t_account_flow (user_id,order_id,account_type,event_type,amount,before_val,after_val,reason) VALUES (?,?,?,?,?,?,?,?)`,
    [userId,orderId,`${kind}_DEBT`,after>before?'REFUND_REWARD_DEBT':'REWARD_DEBT_SETTLE',format(after-before),format(before),format(after),reason]);
}
// Refunds never fail just because an already-issued reward has been spent.
// Track the unreturned portion separately and offset future earned rewards only.
export async function recoverReward(conn: PoolConnection, userId: number, kind: RewardKind, amount: number, orderId: number) {
  requireValue(Number.isSafeInteger(amount) && amount >= 0, '奖励冲正数量无效');
  if (!amount) return;
  const debt = await rewardDebt(conn,userId,kind);
  if (kind === 'RED_PACKET') {
    const [forfeits]: any = await conn.execute('SELECT forfeited_red_rewards,red_packet_points FROM t_user WHERE id=? FOR UPDATE',[userId]);
    const previouslyReturned = Math.min(fen(forfeits[0].forfeited_red_rewards),amount);
    if (previouslyReturned) {
      await conn.execute('UPDATE t_user SET forfeited_red_rewards=forfeited_red_rewards-? WHERE id=?',[yuan(previouslyReturned),userId]);
      await conn.execute(`INSERT INTO t_account_flow(user_id,order_id,account_type,event_type,amount,before_val,after_val,reason) VALUES (?,?,'RED_PACKET','REFUND_FORFEITED_REWARD',0,?,?,?)`,
        [userId,orderId,forfeits[0].red_packet_points,forfeits[0].red_packet_points,`退款奖励中${yuan(previouslyReturned)}元已随退会清零，本次不重复扣回`]);
      amount -= previouslyReturned;
    }
  }
  const field = kind === 'NORMAL_POINT' ? 'normal_points' : 'red_packet_points';
  const [rows]: any = await conn.execute(`SELECT ${field} AS balance FROM t_user WHERE id=? FOR UPDATE`,[userId]);
  const balance = kind === 'NORMAL_POINT' ? Number(rows[0].balance) : fen(rows[0].balance);
  const recovered = Math.min(balance,amount);
  if (recovered) await changeBalance(conn,userId,kind,-recovered,'REFUND_REWARD_REVERSE',orderId,'退款冲回已发奖励');
  if (amount>recovered) await writeDebt(conn,userId,kind,debt.field,debt.value,debt.value+amount-recovered,orderId,'已用奖励待冲回，后续同类奖励先抵回');
}
export async function creditReward(conn: PoolConnection, userId: number, kind: RewardKind, amount: number, event: string, orderId: number, reason: string) {
  requireValue(Number.isSafeInteger(amount) && amount >= 0, '奖励数量无效');
  if (!amount) return;
  const debt = await rewardDebt(conn,userId,kind);
  const offset = Math.min(debt.value,amount);
  if (offset) await writeDebt(conn,userId,kind,debt.field,debt.value,debt.value-offset,orderId,'本次奖励先抵回历史退款已用奖励');
  if (amount>offset) await changeBalance(conn,userId,kind,amount-offset,event,orderId,reason);
}
