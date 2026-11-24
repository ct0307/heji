-- M1：仅建立本项目表，不包含删除、覆盖或示例账号。
CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  email VARCHAR(254) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL UNIQUE,
  displayName VARCHAR(40) NOT NULL,
  passwordHash VARCHAR(255) CHARACTER SET ascii NOT NULL,
  createdAt DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sessions (
  idHash BINARY(32) PRIMARY KEY,
  userId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  createdAt DATETIME(3) NOT NULL,
  expiresAt DATETIME(3) NOT NULL,
  absoluteExpiresAt DATETIME(3) NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id),
  INDEX ix_sessions_expiry (expiresAt)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS books (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  createdByUserId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  financialVersion BIGINT UNSIGNED NOT NULL DEFAULT 0,
  isArchived BOOLEAN NOT NULL DEFAULT FALSE,
  createdAt DATETIME(3) NOT NULL,
  FOREIGN KEY (createdByUserId) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS book_members (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  bookId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  userId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('ACTIVE','LEFT') NOT NULL DEFAULT 'ACTIVE',
  joinedAt DATETIME(3) NOT NULL,
  leftAt DATETIME(3) NULL,
  UNIQUE KEY uq_member_user (bookId,userId),
  UNIQUE KEY uq_member_book_id (bookId,id),
  INDEX ix_member_user (userId,status,bookId),
  FOREIGN KEY (bookId) REFERENCES books(id),
  FOREIGN KEY (userId) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS invitations (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  bookId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tokenHash BINARY(32) NOT NULL UNIQUE,
  createdByUserId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expiresAt DATETIME(3) NOT NULL,
  revokedAt DATETIME(3) NULL,
  consumedAt DATETIME(3) NULL,
  usedByMemberId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  createdAt DATETIME(3) NOT NULL,
  FOREIGN KEY (bookId) REFERENCES books(id),
  FOREIGN KEY (createdByUserId) REFERENCES users(id),
  FOREIGN KEY (bookId,usedByMemberId) REFERENCES book_members(bookId,id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_events (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  bookId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actorUserId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  eventType VARCHAR(50) CHARACTER SET ascii NOT NULL,
  entityId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  createdAt DATETIME(3) NOT NULL,
  FOREIGN KEY (bookId) REFERENCES books(id),
  FOREIGN KEY (actorUserId) REFERENCES users(id),
  INDEX ix_audit_book_time (bookId,createdAt,id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS rate_limits (
  keyHash BINARY(32) PRIMARY KEY,
  windowStartedAt DATETIME(3) NOT NULL,
  attempts INT UNSIGNED NOT NULL,
  INDEX ix_rate_expiry (windowStartedAt)
) ENGINE=InnoDB;
