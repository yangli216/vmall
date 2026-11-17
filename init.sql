-- ====================================================================
-- 杭州临安潘小兜食品小作坊 · 微信云托管数据库初始化脚本
-- 许可证号：JY13301850326102 (含网络经营)
-- 实体工坊：浙江省杭州市临安区锦城街道临天八弄36号
-- 数据库：MySQL 8.0 / 字符集: utf8mb4
-- ====================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------
-- 1. 系统运营参数配置表
-- ----------------------------
DROP TABLE IF EXISTS `t_system_config`;
CREATE TABLE `t_system_config` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `config_key` VARCHAR(50) NOT NULL UNIQUE COMMENT '配置键名',
  `config_value` VARCHAR(255) NOT NULL COMMENT '配置值',
  `remark` VARCHAR(100) COMMENT '参数说明',
  `update_time` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统运营参数配置表';

-- 初始系统运营配置 (店主后台可动态调整)
INSERT INTO `t_system_config` (`config_key`, `config_value`, `remark`) VALUES
('MEMBER_ENTRY_MODE', 'CONSUME', '入会门槛模式：FREE(免费入会) / CONSUME(满额晋级) / MANUAL(手动)'),
('MEMBER_ENTRY_THRESHOLD', '68.00', '满额晋级会员消费金额门槛(元)'),
('RED_PACKET_MAX_DEDUCT_RATIO', '0.50', '红包积分单笔订单最高抵扣货款比例(0.10~1.00，默认50%防亏损)'),
('COMMISSION_RATE', '0.03', '新会员消费实付款给推荐人的返佣比例(默认3%)'),
('DELIVERY_BASE_FEE', '3.00', '作坊本地配送基础费用(元)'),
('DELIVERY_FREE_THRESHOLD', '38.00', '同城配送满额包邮免配送费门槛(元)'),
('DELIVERY_MAX_DISTANCE', '5.0', '作坊自配送最大覆盖半径(公里，超出仅限自提)'),
('WORKSHOP_ADDRESS', '浙江省杭州市临安区锦城街道临天八弄36号', '潘小兜实体工坊自提发货地址'),
('DELIVERY_PERSON_NAME', '潘坚 (潘师傅)', '默认自配送负责人姓名'),
('DELIVERY_PERSON_PHONE', '13735518290', '默认自配送负责人电话'),
('ADMIN_PASSCODE', '8899', '作坊掌柜身份验证主口令(用于绑定管理员OpenID)'),
('MEMBER_DISCOUNT_RATE', '0.88', '尊享会员折扣率(如0.88代表8.8折)'),
('WORKSHOP_ANNOUNCEMENT', '今日傍晚 16:30 准时出锅，临天八弄现捞保温直达', '作坊主页顶部出炉与营业公告'),
('BATCH_SCHEDULE_TIME', '16:30', '每日出锅截单时段(如16:30)');

-- ----------------------------
-- 2. 卤味商品主表
-- ----------------------------
DROP TABLE IF EXISTS `t_product`;
CREATE TABLE `t_product` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `title` VARCHAR(100) NOT NULL COMMENT '菜品名称',
  `cover_img` VARCHAR(500) NOT NULL COMMENT '实拍图链接',
  `category_id` INT DEFAULT 1 COMMENT '分类 (1:招牌, 2:牛肉, 3:鸭货, 4:素菜, 5:饮品)',
  `category_name` VARCHAR(50) DEFAULT '招牌必吃' COMMENT '分类名称',
  `intro` VARCHAR(255) COMMENT '匠心描述',
  `badge` VARCHAR(30) DEFAULT '传统柴火' COMMENT '角标',
  `origin_price` DECIMAL(10,2) NOT NULL COMMENT '原价/非会员价(元)',
  `member_price` DECIMAL(10,2) NOT NULL COMMENT '会员专享价(元)',
  `status` TINYINT(1) DEFAULT 1 COMMENT '状态：1在售中，0已沽清售罄',
  `stock_qty` INT DEFAULT 999 COMMENT '预估今日剩余份数',
  `sort_order` INT DEFAULT 0 COMMENT '排序权重',
  `create_time` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `update_time` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='卤味商品主表';

-- 初始精品菜品种子数据
INSERT INTO `t_product` (`title`, `cover_img`, `category_id`, `category_name`, `intro`, `badge`, `origin_price`, `member_price`, `status`, `sort_order`) VALUES
('古法五香酱卤牛肉 (半斤装)', 'https://images.unsplash.com/photo-1544025162-d76694265947?w=400&q=80', 1, '招牌必吃', '老卤慢煨6小时，肉香紧实纹理清晰，切片直接下酒', '传统柴火', 48.00, 42.00, 1, 100),
('秘制甜辣鸭翅中 (8只份装)', 'https://images.unsplash.com/photo-1527477321055-43615b62e739?w=400&q=80', 1, '招牌必吃', '微甜带辣，外皮胶质浓郁连骨头都有味，现捞出锅', '今日现出', 30.00, 26.80, 1, 90),
('爽口双拼素菜 (卤藕片+海带结)', 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80', 4, '爽脆下酒素', '现捞红油凉拌，爽口解腻佐餐必备', '现拌素味', 12.00, 12.00, 1, 80);

-- 初始示例会员种子数据 (用于后台快速演示会员画像)
INSERT INTO `t_user` (`openid`, `phone`, `nickname`, `avatar_url`, `is_member`, `is_admin`, `member_card_no`, `invite_code`, `normal_points`, `red_packet_points`, `total_consume_amount`) VALUES
('wx_admin_pan', '13735518290', '掌柜潘师傅', 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120', 1, 1, 'NO.0001', 'PXD-8888', 500, 120.00, 1280.00),
('wx_user_wang', '13958001122', '临安王姐', 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=120', 1, 0, 'NO.8802', 'PXD-8802', 180, 36.50, 156.00),
('wx_user_zhang', '13867112233', '锦城老张', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=120', 0, 0, 'NO.8803', 'PXD-8803', 42, 0.00, 42.00);

-- ----------------------------
-- 3. 用户与会员账户表
-- ----------------------------
DROP TABLE IF EXISTS `t_user`;
CREATE TABLE `t_user` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `openid` VARCHAR(64) NOT NULL UNIQUE COMMENT '微信用户OpenID(云托管免鉴权注入)',
  `phone` VARCHAR(20) DEFAULT '' COMMENT '用户手机号',
  `nickname` VARCHAR(50) DEFAULT '临安食客' COMMENT '微信昵称',
  `avatar_url` VARCHAR(500) DEFAULT '' COMMENT '头像URL',
  `is_member` TINYINT(1) DEFAULT 0 COMMENT '会员身份：0非会员，1尊享会员',
  `is_admin` TINYINT(1) DEFAULT 0 COMMENT '是否作坊掌柜管理员：1是，0否',
  `member_card_no` VARCHAR(32) DEFAULT '' COMMENT '会员卡编号如PXD-8801',
  `referrer_id` BIGINT NULL COMMENT '上级推荐人ID(所属会员)',
  `invite_code` VARCHAR(32) NOT NULL UNIQUE COMMENT '专属邀请码(用于裂变新会员)',
  `normal_points` INT DEFAULT 0 COMMENT '普通积分余额(1元=1分，满100减5元)',
  `red_packet_points` DECIMAL(10,2) DEFAULT 0.00 COMMENT '红包积分钱包(1分=1元直冲抵扣，来自推荐返利)',
  `total_consume_amount` DECIMAL(10,2) DEFAULT 0.00 COMMENT '累计消费实付金额',
  `create_time` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `update_time` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_referrer` (`referrer_id`),
  INDEX `idx_invite_code` (`invite_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户与会员账户表';

-- ----------------------------
-- 4. 订单主表
-- ----------------------------
DROP TABLE IF EXISTS `t_order`;
CREATE TABLE `t_order` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `order_sn` VARCHAR(32) NOT NULL UNIQUE COMMENT '订单号如PXD20261116001',
  `user_id` BIGINT NOT NULL COMMENT '下单用户ID',
  `delivery_type` TINYINT NOT NULL COMMENT '履约方式：1作坊自送，2到店自提',
  `delivery_address` VARCHAR(255) DEFAULT '' COMMENT '收货地址(自送模式下)',
  `receiver_name` VARCHAR(50) DEFAULT '' COMMENT '收货人姓名',
  `receiver_phone` VARCHAR(20) DEFAULT '' COMMENT '收货人联系电话',
  `pickup_code` VARCHAR(10) DEFAULT '' COMMENT '4位数提货码(自提模式下，如6802)',
  `expect_time_slot` VARCHAR(50) DEFAULT '今日 16:30 傍晚批次' COMMENT '预约出炉送达时段',
  `order_remark` VARCHAR(255) DEFAULT '' COMMENT '口味备注(如微辣/少卤/多葱)',
  
  -- 金额明细
  `goods_total_amount` DECIMAL(10,2) NOT NULL COMMENT '商品原价总金额',
  `member_discount_amount` DECIMAL(10,2) DEFAULT 0.00 COMMENT '会员8.8折优惠减免金额',
  `normal_points_deduct` DECIMAL(10,2) DEFAULT 0.00 COMMENT '普通积分满减抵扣金额',
  `used_normal_points` INT DEFAULT 0 COMMENT '消耗的普通积分点数',
  `red_packet_deduct` DECIMAL(10,2) DEFAULT 0.00 COMMENT '红包积分直接冲抵现金金额',
  `used_red_packet_points` DECIMAL(10,2) DEFAULT 0.00 COMMENT '消耗的红包积分点数',
  `delivery_fee` DECIMAL(10,2) DEFAULT 0.00 COMMENT '作坊自送补贴运费',
  `pay_amount` DECIMAL(10,2) NOT NULL COMMENT '微信真实支付扣款金额',
  
  -- 状态机
  `order_status` TINYINT NOT NULL DEFAULT 10 COMMENT '10:待付款, 20:已付款/待出锅备餐, 30:潘师傅自送中, 40:已完成送达, 50:已退款',
  `delivery_person_name` VARCHAR(50) DEFAULT '潘坚' COMMENT '自送人姓名',
  `delivery_person_phone` VARCHAR(20) DEFAULT '13800000000' COMMENT '自送人电话',
  
  `pay_time` DATETIME NULL COMMENT '微信支付完成时间',
  `create_time` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `update_time` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_user` (`user_id`),
  INDEX `idx_status` (`order_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单主表';

-- ----------------------------
-- 5. 订单商品明细表
-- ----------------------------
DROP TABLE IF EXISTS `t_order_item`;
CREATE TABLE `t_order_item` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `order_id` BIGINT NOT NULL,
  `product_id` BIGINT NOT NULL,
  `product_title` VARCHAR(100) NOT NULL,
  `product_img` VARCHAR(500) NOT NULL,
  `price` DECIMAL(10,2) NOT NULL COMMENT '成交单价(折后或原价)',
  `quantity` INT NOT NULL DEFAULT 1 COMMENT '购买份数',
  `subtotal` DECIMAL(10,2) NOT NULL,
  `create_time` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_order` (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单商品明细表';

-- ----------------------------
-- 6. 推荐佣金结算流水表 (核心防刷审计表)
-- ----------------------------
DROP TABLE IF EXISTS `t_commission_flow`;
CREATE TABLE `t_commission_flow` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `referrer_user_id` BIGINT NOT NULL COMMENT '获得佣金的推荐人ID',
  `buyer_user_id` BIGINT NOT NULL COMMENT '实际下单消费的新会员ID',
  `order_id` BIGINT NOT NULL COMMENT '关联订单ID',
  `order_cash_base` DECIMAL(10,2) NOT NULL COMMENT '参与计佣的真实现金基数(实付微信金额-运费)',
  `commission_rate` DECIMAL(4,2) NOT NULL DEFAULT 0.03 COMMENT '执行返佣比例(如0.03)',
  `reward_red_points` DECIMAL(10,2) NOT NULL COMMENT '折算获得的红包积分点数',
  `status` TINYINT DEFAULT 1 COMMENT '1:正常到账, 2:订单退款已扣回冲正',
  `create_time` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_referrer` (`referrer_user_id`),
  INDEX `idx_order` (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='推荐返利红包流水表';

-- ----------------------------
-- 7. 掌柜人工积分/红包调整审计日志表
-- ----------------------------
DROP TABLE IF EXISTS `t_point_adjust_log`;
CREATE TABLE `t_point_adjust_log` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `user_id` BIGINT NOT NULL COMMENT '被调整的会员ID',
  `adjust_type` VARCHAR(20) NOT NULL COMMENT '调整类型：NORMAL_POINT(普通积分) / RED_PACKET(红包积分)',
  `amount` DECIMAL(10,2) NOT NULL COMMENT '变动数值(正数为赠送加分，负数为扣减)',
  `before_val` DECIMAL(10,2) NOT NULL COMMENT '变动前数值',
  `after_val` DECIMAL(10,2) NOT NULL COMMENT '变动后数值',
  `operator_name` VARCHAR(50) DEFAULT '掌柜潘师傅' COMMENT '操作人',
  `reason` VARCHAR(255) NOT NULL COMMENT '调整原因备注(如老客生日礼遇/线下补偿)',
  `create_time` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='掌柜人工积分红包调整审计日志表';

SET FOREIGN_KEY_CHECKS = 1;
