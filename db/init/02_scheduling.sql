-- 安运通 · 运输排班域结构（MySQL 8.0, utf8mb4）
-- 在 01_schema.sql 基础上新增：车辆台账、车辆不可用时段、人员证照、人员请假、排班改派留痕；
-- waybills 增加 vehicle_id（与 vehicle_plate 双写，车牌仅作冗余展示）。

-- 车辆台账
CREATE TABLE IF NOT EXISTS vehicles (
  id                     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  enterprise_id          BIGINT UNSIGNED NOT NULL,
  plate                  VARCHAR(16) NOT NULL COMMENT '号牌（与运单车牌双写）',
  load_tons              DECIMAL(8,2) NULL COMMENT '核定载质量（吨）',
  cargo_scope            VARCHAR(255) NULL COMMENT '允许运输货类说明',
  transport_license_no   VARCHAR(64) NULL COMMENT '道路运输证号',
  transport_license_until DATE NULL COMMENT '道路运输证有效期至',
  status                 ENUM('AVAILABLE','MAINTENANCE','RETIRED')
                         NOT NULL DEFAULT 'AVAILABLE' COMMENT '可用/维修中/停运',
  active                 TINYINT NOT NULL DEFAULT 1,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_vehicles_plate (plate),
  KEY idx_vehicles_ent (enterprise_id, status),
  CONSTRAINT fk_vehicles_enterprise FOREIGN KEY (enterprise_id) REFERENCES enterprises(id)
) ENGINE=InnoDB COMMENT='运输车辆台账';

-- 车辆不可用时段（维修/保养/年检/抛锚）
CREATE TABLE IF NOT EXISTS vehicle_unavailability (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  vehicle_id  BIGINT UNSIGNED NOT NULL,
  start_at    DATETIME NOT NULL,
  end_at      DATETIME NOT NULL,
  reason      VARCHAR(200) NOT NULL COMMENT '不可用原因（抛锚/保养/年检…）',
  created_by  BIGINT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_vu_vehicle_time (vehicle_id, start_at, end_at),
  CONSTRAINT fk_vu_vehicle FOREIGN KEY (vehicle_id) REFERENCES vehicles(id)
) ENGINE=InnoDB COMMENT='车辆不可用时段';

-- 人员证照：驾驶员（驾驶证 + 危货从业资格证）、押运员（押运从业资格证）
CREATE TABLE IF NOT EXISTS crew_qualifications (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id      BIGINT UNSIGNED NOT NULL,
  cert_type    ENUM('DRIVING_LICENSE','QUALIFICATION_CARD')
               NOT NULL COMMENT '驾驶证 / 从业资格证（押运员为押运从业资格）',
  cert_no      VARCHAR(64) NULL,
  valid_from   DATE NULL,
  valid_until  DATE NOT NULL COMMENT '有效期至（含当日）',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_qual_user (user_id),
  KEY idx_qual_until (valid_until),
  CONSTRAINT fk_qual_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB COMMENT='驾驶员/押运员证照';

-- 人员请假/不可排班时段
CREATE TABLE IF NOT EXISTS crew_leave (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  start_at   DATETIME NOT NULL,
  end_at     DATETIME NOT NULL,
  reason     VARCHAR(200) NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_leave_user_time (user_id, start_at, end_at),
  CONSTRAINT fk_leave_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB COMMENT='人员请假/不可排班时段';

-- 排班改派留痕：拖拽改时间、超时到达强确认、换车/换驾驶员/换押运员、链式顺延逐单留痕
CREATE TABLE IF NOT EXISTS schedule_adjustments (
  id                     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  waybill_id             BIGINT UNSIGNED NOT NULL,
  batch_id               CHAR(36) NOT NULL COMMENT '同一次改派批次号（链式顺延多单共享）',
  kind                   ENUM('RESCHEDULE','REASSIGN_VEHICLE','REASSIGN_DRIVER',
                              'REASSIGN_ESCORT','CHAIN_SHIFT')
                         NOT NULL COMMENT '改时间/换车/换驾驶员/换押运员/链式顺延',
  old_vehicle_id         BIGINT UNSIGNED NULL,
  new_vehicle_id         BIGINT UNSIGNED NULL,
  old_driver_id          BIGINT UNSIGNED NULL,
  new_driver_id          BIGINT UNSIGNED NULL,
  old_escort_id          BIGINT UNSIGNED NULL,
  new_escort_id          BIGINT UNSIGNED NULL,
  old_planned_departure  DATETIME NULL,
  new_planned_departure  DATETIME NULL,
  old_planned_arrival    DATETIME NULL,
  new_planned_arrival    DATETIME NULL,
  late_arrival_confirmed TINYINT NOT NULL DEFAULT 0 COMMENT '落点晚于原计划到达，已二次确认',
  reason                 VARCHAR(500) NOT NULL COMMENT '改派/超时确认原因，强制留痕',
  actor_id               BIGINT UNSIGNED NULL,
  actor_name             VARCHAR(64) NULL,
  idempotency_key        VARCHAR(64) NULL,
  created_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_sa_idem (idempotency_key),
  KEY idx_sa_waybill (waybill_id),
  KEY idx_sa_batch (batch_id),
  CONSTRAINT fk_sa_waybill FOREIGN KEY (waybill_id) REFERENCES waybills(id)
) ENGINE=InnoDB COMMENT='排班改派/链式顺延留痕';

-- 运单关联车辆（车辆/驾驶员/押运员三泳道的车辆维度来源）
ALTER TABLE waybills
  ADD COLUMN vehicle_id BIGINT UNSIGNED NULL COMMENT '承运车辆（vehicles.id）' AFTER vehicle_plate,
  ADD KEY idx_waybills_vehicle (vehicle_id),
  ADD CONSTRAINT fk_waybills_vehicle FOREIGN KEY (vehicle_id) REFERENCES vehicles(id);
