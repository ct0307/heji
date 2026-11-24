-- 待批准的持久DDL提案；此文件不在活动迁移目录，不自动执行。
-- 汇总是可重建派生数据，账本锁和事实所在事务维护成员引用及非负结果。
-- 不设外键，便于同源连接级临时表演练；原始事实表的成员约束保持不变。
-- 数值必须有符号，以接收UPSERT减贡献的负候选值；提交前真实汇总应非负。
CREATE TABLE finance_member_totals (
  bookId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  memberId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  paidFen DECIMAL(65,0) NOT NULL DEFAULT 0,
  shareFen DECIMAL(65,0) NOT NULL DEFAULT 0,
  outgoingFen DECIMAL(65,0) NOT NULL DEFAULT 0,
  incomingFen DECIMAL(65,0) NOT NULL DEFAULT 0,
  PRIMARY KEY (bookId,memberId)
) ENGINE=InnoDB;

CREATE TABLE finance_daily_members (
  bookId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  occurredOn DATE NOT NULL,
  memberId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  paidFen DECIMAL(65,0) NOT NULL DEFAULT 0,
  shareFen DECIMAL(65,0) NOT NULL DEFAULT 0,
  PRIMARY KEY (bookId,occurredOn,memberId)
) ENGINE=InnoDB;

CREATE TABLE finance_daily_categories (
  bookId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  occurredOn DATE NOT NULL,
  category ENUM('FOOD','TRANSPORT','HOUSING','OTHER') NOT NULL,
  amountFen DECIMAL(65,0) NOT NULL DEFAULT 0,
  PRIMARY KEY (bookId,occurredOn,category)
) ENGINE=InnoDB;
