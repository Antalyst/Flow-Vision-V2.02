-- =============================================================================
-- FlowVision — ROLLBACK of 2026-10-13-rename-roles.sql   (MariaDB 11 / MySQL 8)
--
--   ADMIN            → CLIENT
--   DEPARTMENT_HEAD  → EMPLOYEE
--
-- Use only together with redeploying the PREVIOUS application code: the old code doesn't know
-- ADMIN / DEPARTMENT_HEAD, and the new code still signs in CLIENT / EMPLOYEE accounts but no
-- longer lists or notifies them correctly. Run one STEP at a time; every step can be rerun.
-- Accounts created after the migration as ADMIN / DEPARTMENT_HEAD are rolled back too.
-- =============================================================================

SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES');

-- STEP R1 — widen to old + new values.
ALTER TABLE `users`
  MODIFY `account_type` enum('CLIENT','EMPLOYEE','STAFF','LIAISON','ADMIN','DEPARTMENT_HEAD') NOT NULL COMMENT 'User role type';

-- STEP R2 — rename back.
START TRANSACTION;
UPDATE `users` SET `account_type` = 'CLIENT'   WHERE `account_type` = 'ADMIN';
UPDATE `users` SET `account_type` = 'EMPLOYEE' WHERE `account_type` = 'DEPARTMENT_HEAD';
SELECT account_type, COUNT(*) AS users FROM users GROUP BY account_type ORDER BY account_type;
COMMIT;   -- or ROLLBACK; if the counts are wrong

-- STEP R3 — narrow to the original enum (expects 0 below first).
SELECT COUNT(*) AS new_values_left FROM users WHERE account_type IN ('ADMIN', 'DEPARTMENT_HEAD');
SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES');   -- keep with the ALTER
ALTER TABLE `users`
  MODIFY `account_type` enum('CLIENT','EMPLOYEE','STAFF','LIAISON') NOT NULL COMMENT 'User role type';
