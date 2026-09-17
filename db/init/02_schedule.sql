-- 安运通 · 运输排班领域结构（MySQL 8.0, utf8mb4）
-- 依赖 01_schema.sql；仅在数据卷初始化时自动执行，既有库需手动导入本文件。

-- ===== 车辆档案（基线只有 waybills.vehicle_plate 字符串，无车辆实体） =====
CREATE TABLE IF NOT EXISTS vehicles (
  id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  enterprise_id           BIGINT UNSIGNED NOT NULL COMMENT '所属企业',
  plate                   VARCHAR(16) NOT NULL COMMENT '号牌（全局唯一）',
  vehicle_type            VARCHAR(32) NOT NULL DEFAULT '重型厢式货车' COMMENT '车型',
  load_tons               DECIMAL(8,2) NULL COMMENT '核定载重（吨）',
  transport_license_no    VARCHAR(64) NULL COMMENT '道路运输证号',
  transport_license_expires DATETIME NULL COMMENT '道路运输证有效期',
  active                  TINYINT NOT NULL DEFAULT 1,
  created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_vehicles_plate (plate),
  KEY idx_vehicles_ent (enterprise_id),
  CONSTRAINT fk_vehicles_ent FOREIGN KEY (enterprise_id) REFERENCES enterprises(id)
) ENGINE=InnoDB COMMENT='运输车辆档案';

-- 运单挂车辆实体（历史 vehicle_plate 字符串保留做双写过渡）
ALTER TABLE waybills
  ADD COLUMN vehicle_id BIGINT UNSIGNED NULL COMMENT '承运车辆实体（可空：历史/外牌数据）' AFTER vehicle_plate,
  ADD KEY idx_waybills_vehicle (vehicle_id),
  ADD CONSTRAINT fk_waybills_vehicle FOREIGN KEY (vehicle_id) REFERENCES vehicles(id);

-- ===== 人员证照（驾驶证/从业资格证/押运证，含有效期） =====
CREATE TABLE IF NOT EXISTS crew_licenses (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT UNSIGNED NOT NULL,
  license_type  ENUM('DRIVING','QUALIFICATION','ESCORT') NOT NULL COMMENT '驾驶证/从业资格证/押运证',
  license_no    VARCHAR(64) NOT NULL,
  expires_at    DATETIME NOT NULL COMMENT '证照有效期截止时刻',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_crew_license (user_id, license_type),
  KEY idx_licenses_expire (expires_at),
  CONSTRAINT fk_licenses_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB COMMENT='驾驶员/押运员证照';

-- ===== 资源每周可用时段（0=周日 … 6=周六，本地墙钟时间） =====
CREATE TABLE IF NOT EXISTS resource_availability (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  resource_type ENUM('VEHICLE','DRIVER','ESCORT') NOT NULL,
  resource_id   BIGINT UNSIGNED NOT NULL,
  weekday       TINYINT UNSIGNED NOT NULL COMMENT '0=周日 … 6=周六',
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  KEY idx_avail_res (resource_type, resource_id, weekday)
) ENGINE=InnoDB COMMENT='车/人每周可用时段规则';

-- ===== 资源不可用窗口（车辆维保 / 人员请假，具体到起止时刻） =====
CREATE TABLE IF NOT EXISTS resource_unavailability (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  resource_type ENUM('VEHICLE','DRIVER','ESCORT') NOT NULL,
  resource_id   BIGINT UNSIGNED NOT NULL,
  start_at      DATETIME NOT NULL,
  end_at        DATETIME NOT NULL,
  reason        VARCHAR(200) NOT NULL COMMENT '维保/请假等原因',
  created_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_unavail_res (resource_type, resource_id, start_at)
) ENGINE=InnoDB COMMENT='车辆维保/人员请假窗口';

-- ===== 排班留痕：复用 waybill_events，新增动作与级联变更明细 =====
-- 动作：assign 派车 / reassign 改派（换车换人）/ reschedule 链式顺延 / unassign 解绑回池
ALTER TABLE waybill_events
  ADD COLUMN changes JSON NULL COMMENT '排班变更明细（级联前后时间、更换的资源）' AFTER reason;
