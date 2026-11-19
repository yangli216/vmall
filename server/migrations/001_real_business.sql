-- Additive migration for existing databases. Run via npm run migrate; never re-import init.sql in production.
ALTER TABLE t_user ADD COLUMN member_opt_out TINYINT NOT NULL DEFAULT 0;
ALTER TABLE t_user ADD COLUMN member_source VARCHAR(16) NOT NULL DEFAULT 'MANUAL';
ALTER TABLE t_user ADD COLUMN referrer_bound_time DATETIME NULL;
ALTER TABLE t_product ADD COLUMN is_deleted TINYINT NOT NULL DEFAULT 0;
ALTER TABLE t_product ADD COLUMN specification VARCHAR(100) NOT NULL DEFAULT '';
ALTER TABLE t_product ADD COLUMN storage_note VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE t_order ADD COLUMN request_id VARCHAR(64) NULL;
ALTER TABLE t_order ADD COLUMN request_hash CHAR(64) NULL;
ALTER TABLE t_order ADD UNIQUE KEY uk_user_request (user_id, request_id);
ALTER TABLE t_order ADD COLUMN batch_date DATE NULL;
ALTER TABLE t_order ADD COLUMN batch_time VARCHAR(5) NULL;
ALTER TABLE t_order ADD COLUMN expires_at DATETIME NULL;
ALTER TABLE t_order ADD COLUMN payment_state VARCHAR(20) NOT NULL DEFAULT 'LEGACY';
ALTER TABLE t_order ADD COLUMN transaction_id VARCHAR(64) NULL;
ALTER TABLE t_order ADD UNIQUE KEY uk_transaction (transaction_id);
ALTER TABLE t_order ADD COLUMN prepay_id VARCHAR(128) NULL;
ALTER TABLE t_order ADD COLUMN stock_reserved TINYINT NOT NULL DEFAULT 0;
ALTER TABLE t_order ADD COLUMN commission_rate DECIMAL(4,2) NOT NULL DEFAULT 0.03;
ALTER TABLE t_order ADD COLUMN referrer_id BIGINT NULL;
ALTER TABLE t_order ADD COLUMN closed_time DATETIME NULL;
ALTER TABLE t_order ADD COLUMN completed_time DATETIME NULL;
ALTER TABLE t_order ADD COLUMN dispatched_time DATETIME NULL;
ALTER TABLE t_order ADD COLUMN refund_sn VARCHAR(64) NULL;
ALTER TABLE t_order ADD COLUMN refund_error VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE t_order ADD KEY idx_batch (batch_date, batch_time, delivery_type, order_status);
ALTER TABLE t_order ADD KEY idx_expiry (order_status, expires_at);
CREATE TABLE IF NOT EXISTS t_account_flow (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id BIGINT NOT NULL, order_id BIGINT NULL,
 account_type VARCHAR(20) NOT NULL, event_type VARCHAR(32) NOT NULL,
 amount DECIMAL(12,2) NOT NULL, before_val DECIMAL(12,2) NOT NULL, after_val DECIMAL(12,2) NOT NULL,
 reason VARCHAR(255) NOT NULL, operator_id BIGINT NULL, create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 INDEX idx_user (user_id,id), INDEX idx_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS t_admin_audit (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, operator_id BIGINT NOT NULL,
 action VARCHAR(100) NOT NULL, target_id VARCHAR(64) NOT NULL DEFAULT '',
 create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- Existing orders stay LEGACY: their historical payment cannot be established from old status alone.
-- Retain balances and historical commission records; new orders record balance changes from migration onward.
INSERT IGNORE INTO t_system_config (config_key, config_value, remark) VALUES
 ('DELIVERY_AREAS','','可自送小区白名单，逗号分隔；未配置时仅支持自提'),
 ('BATCH_CUTOFF_TIME','16:00','预约批次截单时间'),
 ('BOOKING_DAYS','1','可预约未来天数'),('SHOP_OPEN','1','1营业0休息'),
 ('ORDER_EXPIRE_MINUTES','15','未付款订单有效分钟');
CREATE TABLE IF NOT EXISTS t_batch_stock (
 batch_date DATE NOT NULL, batch_time VARCHAR(5) NOT NULL, product_id BIGINT NOT NULL,
 available_qty INT NOT NULL, PRIMARY KEY (batch_date,batch_time,product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
ALTER TABLE t_order ADD COLUMN paid_goods_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE t_order ADD COLUMN benefits_released TINYINT NOT NULL DEFAULT 0;
ALTER TABLE t_order ADD UNIQUE KEY uk_refund (refund_sn);
