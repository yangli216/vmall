-- Prevent a lost HTTP response or double tap from applying an asset adjustment twice.
CREATE TABLE IF NOT EXISTS t_admin_mutation (
 operator_id BIGINT NOT NULL, request_id VARCHAR(64) NOT NULL,
 action VARCHAR(64) NOT NULL, request_hash CHAR(64) NOT NULL,
 create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY (operator_id,request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
