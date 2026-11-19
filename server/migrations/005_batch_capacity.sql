ALTER TABLE t_order ADD COLUMN capacity_reserved TINYINT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS t_batch_capacity (
 batch_date DATE NOT NULL, batch_time VARCHAR(5) NOT NULL,
 reserved_orders INT NOT NULL DEFAULT 0,
 PRIMARY KEY (batch_date,batch_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- Fulfilled orders still consume kitchen capacity, including after-sales refunds.
UPDATE t_order SET capacity_reserved=1 WHERE payment_state<>'LEGACY' AND batch_date IS NOT NULL AND batch_time IS NOT NULL AND (order_status IN (10,20,25,30,40,70) OR (order_status=50 AND refund_origin_status>20));
INSERT INTO t_batch_capacity(batch_date,batch_time,reserved_orders) SELECT batch_date,batch_time,COUNT(*) FROM t_order WHERE capacity_reserved=1 GROUP BY batch_date,batch_time ON DUPLICATE KEY UPDATE reserved_orders=VALUES(reserved_orders);
INSERT IGNORE INTO t_system_config(config_key,config_value,remark) VALUES ('BATCH_MAX_ORDERS','0','每批接单上限，0不限；未付款占名额，已备好或发出不释放');
