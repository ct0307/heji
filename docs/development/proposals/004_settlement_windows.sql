-- 独立维护迁移：不改变旧财务事实，不能由普通迁移入口自动执行。
CREATE TABLE settlement_windows (
  bookId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  windowId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  requestId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  holderUserId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  holderMemberId CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  createdAt DATETIME(3) NOT NULL,
  expiresAt DATETIME(3) NOT NULL,
  closedAt DATETIME(3) NULL,
  cooldownUntil DATETIME(3) NOT NULL,
  FOREIGN KEY (bookId) REFERENCES books(id),
  FOREIGN KEY (bookId,requestId) REFERENCES transfer_requests(bookId,id),
  FOREIGN KEY (bookId,holderMemberId) REFERENCES book_members(bookId,id),
  FOREIGN KEY (bookId,holderUserId) REFERENCES book_members(bookId,userId),
  CHECK (expiresAt=DATE_ADD(createdAt,INTERVAL 30 SECOND)),
  CHECK (closedAt IS NULL OR closedAt>=createdAt),
  CHECK (cooldownUntil=DATE_ADD(COALESCE(closedAt,expiresAt),INTERVAL 30 SECOND))
) ENGINE=InnoDB;
