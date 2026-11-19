CREATE TABLE IF NOT EXISTS t_support_ticket (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, order_id BIGINT NOT NULL, user_id BIGINT NOT NULL,
 request_id VARCHAR(64) NOT NULL, request_hash CHAR(64) NOT NULL,
 category VARCHAR(20) NOT NULL, description VARCHAR(1000) NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'OPEN', resolution VARCHAR(1000) NOT NULL DEFAULT '',
 operator_id BIGINT NULL,
 active_order_id BIGINT GENERATED ALWAYS AS (CASE WHEN status IN ('OPEN','PROCESSING') THEN order_id ELSE NULL END) STORED,
 create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 UNIQUE KEY uk_request (user_id,request_id), UNIQUE KEY uk_active_order (active_order_id),
 INDEX idx_user (user_id,id), INDEX idx_status (status,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
