-- M2：只新增财务结构，不删除、清空或回填已有业务数据。
CREATE TABLE IF NOT EXISTS expenses (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  bookId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  createdByMemberId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  currentRevision BIGINT UNSIGNED NULL,
  createdAt DATETIME(3) NOT NULL,
  UNIQUE KEY uq_expense_book_id (bookId,id),
  INDEX ix_expense_book_created (bookId,createdAt,id),
  FOREIGN KEY (bookId,createdByMemberId) REFERENCES book_members(bookId,id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS expense_versions (
  expenseId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  bookId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  paidByMemberId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  amountFen BIGINT UNSIGNED NOT NULL,
  splitMode ENUM('EQUAL','EXACT') NOT NULL,
  category ENUM('FOOD','TRANSPORT','HOUSING','OTHER') NOT NULL,
  occurredOn DATE NOT NULL,
  note VARCHAR(1000) NOT NULL DEFAULT '',
  isVoided BOOLEAN NOT NULL DEFAULT FALSE,
  changedByMemberId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  createdAt DATETIME(3) NOT NULL,
  PRIMARY KEY (expenseId,revision),
  UNIQUE KEY uq_version_book_expense_revision (bookId,expenseId,revision),
  INDEX ix_version_book_date (bookId,occurredOn,expenseId),
  FOREIGN KEY (bookId,expenseId) REFERENCES expenses(bookId,id),
  FOREIGN KEY (bookId,paidByMemberId) REFERENCES book_members(bookId,id),
  FOREIGN KEY (bookId,changedByMemberId) REFERENCES book_members(bookId,id),
  CHECK (amountFen BETWEEN 1 AND 100000000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS expense_shares (
  bookId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expenseId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  memberId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  amountFen BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (expenseId,revision,memberId),
  INDEX ix_share_member (bookId,memberId),
  FOREIGN KEY (bookId,expenseId,revision) REFERENCES expense_versions(bookId,expenseId,revision),
  FOREIGN KEY (bookId,memberId) REFERENCES book_members(bookId,id),
  CHECK (amountFen <= 100000000)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS transfer_requests (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  bookId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind ENUM('NORMAL','REVERSAL') NOT NULL,
  fromMemberId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  toMemberId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  amountFen BIGINT UNSIGNED NOT NULL,
  occurredOn DATE NOT NULL,
  note VARCHAR(1000) NOT NULL DEFAULT '',
  initiatorMemberId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  counterpartyMemberId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('PENDING','CONFIRMED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  reversalOfTransferId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  pendingReversalId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS (CASE WHEN kind='REVERSAL' AND status='PENDING' THEN reversalOfTransferId ELSE NULL END) STORED,
  createdAt DATETIME(3) NOT NULL,
  UNIQUE KEY uq_request_book_id (bookId,id),
  UNIQUE KEY uq_pending_reversal (bookId,pendingReversalId),
  INDEX ix_request_status (bookId,status,createdAt,id),
  FOREIGN KEY (bookId,fromMemberId) REFERENCES book_members(bookId,id),
  FOREIGN KEY (bookId,toMemberId) REFERENCES book_members(bookId,id),
  FOREIGN KEY (bookId,initiatorMemberId) REFERENCES book_members(bookId,id),
  FOREIGN KEY (bookId,counterpartyMemberId) REFERENCES book_members(bookId,id),
  CHECK (fromMemberId <> toMemberId AND initiatorMemberId <> counterpartyMemberId),
  CHECK (amountFen BETWEEN 1 AND 100000000),
  CHECK ((kind='NORMAL' AND reversalOfTransferId IS NULL AND initiatorMemberId=fromMemberId AND counterpartyMemberId=toMemberId) OR (kind='REVERSAL' AND reversalOfTransferId IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS confirmed_transfers (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  bookId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  requestId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  kind ENUM('NORMAL','REVERSAL') NOT NULL,
  fromMemberId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  toMemberId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  amountFen BIGINT UNSIGNED NOT NULL,
  occurredOn DATE NOT NULL,
  confirmedByMemberId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  confirmedAt DATETIME(3) NOT NULL,
  reversalOfTransferId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL UNIQUE,
  UNIQUE KEY uq_transfer_book_id (bookId,id),
  INDEX ix_transfer_from (bookId,fromMemberId),
  INDEX ix_transfer_to (bookId,toMemberId),
  FOREIGN KEY (bookId,requestId) REFERENCES transfer_requests(bookId,id),
  FOREIGN KEY (bookId,fromMemberId) REFERENCES book_members(bookId,id),
  FOREIGN KEY (bookId,toMemberId) REFERENCES book_members(bookId,id),
  FOREIGN KEY (bookId,confirmedByMemberId) REFERENCES book_members(bookId,id),
  FOREIGN KEY (bookId,reversalOfTransferId) REFERENCES confirmed_transfers(bookId,id),
  CHECK (fromMemberId <> toMemberId),
  CHECK (amountFen BETWEEN 1 AND 100000000),
  CHECK ((kind='NORMAL' AND reversalOfTransferId IS NULL) OR (kind='REVERSAL' AND reversalOfTransferId IS NOT NULL))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS idempotency_records (
  actorId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bookId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  requestKey VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  requestHash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  httpStatus SMALLINT UNSIGNED NOT NULL,
  responseBody JSON NOT NULL,
  responseEtag VARCHAR(80) CHARACTER SET ascii NULL,
  responseLocation VARCHAR(255) CHARACTER SET ascii NULL,
  createdAt DATETIME(3) NOT NULL,
  PRIMARY KEY (actorId,bookId,operation,requestKey),
  FOREIGN KEY (actorId) REFERENCES users(id),
  FOREIGN KEY (bookId) REFERENCES books(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS financial_audit_details (
  eventId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  revision BIGINT UNSIGNED NULL,
  changeSummary JSON NOT NULL,
  FOREIGN KEY (eventId) REFERENCES audit_events(id)
) ENGINE=InnoDB;

ALTER TABLE expenses ADD CONSTRAINT fk_expense_current_version FOREIGN KEY (id,currentRevision) REFERENCES expense_versions(expenseId,revision);
ALTER TABLE transfer_requests ADD CONSTRAINT fk_request_original_transfer FOREIGN KEY (bookId,reversalOfTransferId) REFERENCES confirmed_transfers(bookId,id);
