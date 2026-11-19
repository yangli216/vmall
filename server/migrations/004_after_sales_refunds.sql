ALTER TABLE t_user ADD COLUMN normal_points_debt INT NOT NULL DEFAULT 0;
ALTER TABLE t_user ADD COLUMN red_packet_debt DECIMAL(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE t_user ADD COLUMN forfeited_red_rewards DECIMAL(10,2) NOT NULL DEFAULT 0.00;
-- Prior opt-outs already forfeited these balances; do not charge them again on refund.
UPDATE t_user u SET forfeited_red_rewards=COALESCE((SELECT -SUM(f.amount) FROM t_account_flow f WHERE f.user_id=u.id AND f.account_type='RED_PACKET' AND f.event_type='MEMBER_EXIT'),0);
ALTER TABLE t_order ADD COLUMN earned_normal_points INT NOT NULL DEFAULT 0;
ALTER TABLE t_order ADD COLUMN refund_origin_status INT NULL;
ALTER TABLE t_order ADD COLUMN refund_reason VARCHAR(255) NOT NULL DEFAULT '';
-- Previously completed non-legacy orders already recorded their earned points in the ledger.
UPDATE t_order o SET earned_normal_points = COALESCE((SELECT SUM(f.amount) FROM t_account_flow f WHERE f.order_id=o.id AND f.account_type='NORMAL_POINT' AND f.event_type='ORDER_EARN'),0) WHERE o.completed_time IS NOT NULL AND o.payment_state<>'LEGACY';
