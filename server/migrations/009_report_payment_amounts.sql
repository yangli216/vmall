ALTER TABLE t_order ADD COLUMN payer_paid_amount DECIMAL(10,2) NULL;
ALTER TABLE t_order ADD COLUMN payer_refund_amount DECIMAL(10,2) NULL;
ALTER TABLE t_order ADD INDEX idx_payment_booked(pay_time,payment_state);
ALTER TABLE t_order ADD INDEX idx_refund_booked(closed_time,payment_state);
-- Old positive-amount orders cannot reveal buyer cash after channel discounts.
-- Only the verified zero-amount branch can be backfilled without guessing.
UPDATE t_order SET payer_paid_amount=0 WHERE pay_amount=0 AND payment_state IN ('PAID','REFUNDING','REFUNDED') AND pay_time IS NOT NULL;
UPDATE t_order SET payer_refund_amount=0 WHERE pay_amount=0 AND payment_state='REFUNDED' AND closed_time IS NOT NULL;
