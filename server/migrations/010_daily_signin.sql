CREATE TABLE IF NOT EXISTS t_user_sign_in (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  sign_date DATE NOT NULL,
  points_reward INT NOT NULL DEFAULT 10,
  create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_sign_date (user_id, sign_date),
  INDEX idx_user_date (user_id, sign_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
