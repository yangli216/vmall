CREATE TABLE IF NOT EXISTS t_product_category (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_deleted TINYINT NOT NULL DEFAULT 0,
  create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_active_sort (is_deleted, sort_order, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT IGNORE INTO t_product_category (id, name, sort_order) VALUES
  (1, '招牌必吃', 50),
  (2, '秘制酱牛肉', 40),
  (3, '麻辣鸭副件', 30),
  (4, '爽脆下酒菜', 20),
  (5, '手工饮品', 10);
