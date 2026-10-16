-- =============================================================================
-- FlowVision — rename stored user roles            (MariaDB 11 / MySQL 8)
--
--   CLIENT    → ADMIN
--   EMPLOYEE  → DEPARTMENT_HEAD
--   STAFF     (unchanged)
--   LIAISON   (unchanged — the messenger role)
--
-- The only place roles are stored is users.account_type:
--   enum('CLIENT','EMPLOYEE','STAFF','LIAISON') NOT NULL, no default, no CHECK, no trigger,
--   part of index idx_users_org_office (org_id, office_id, account_type).
-- Nothing else stores the role as a column. audit_logs.old_values / new_values (JSON) keep the
-- role an account had when the event was logged; those historical records are NOT changed.
-- No user id, password, organization, office, document or history row is touched.
--
-- Run it by hand, one STEP at a time, checking the result of each step before the next.
-- MariaDB commits DDL (ALTER TABLE) implicitly: only STEP 2 is a real transaction.
-- Every step can be run again safely.
--
-- Deployment order (see the report):
--   STEP 1 (widen)  →  deploy the new application code  →  STEP 2 (rename)  →  check  →  STEP 3 (narrow)
-- The new code treats a not-yet-renamed CLIENT / EMPLOYEE account as ADMIN / DEPARTMENT_HEAD
-- when it signs in, so the gap between deploying and STEP 2 doesn't lock anyone out.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- STEP 0 — inspect (read-only). Stop and investigate if anything is unexpected.
-- -----------------------------------------------------------------------------

-- Expected: enum('CLIENT','EMPLOYEE','STAFF','LIAISON'), NOT NULL, no default.
SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'account_type';

-- Make sure you are on the intended database (check the name carefully).
SELECT DATABASE() AS current_database;

-- Current role counts. Expected values: CLIENT, EMPLOYEE, STAFF, LIAISON only.
SELECT account_type, COUNT(*) AS users FROM users GROUP BY account_type ORDER BY account_type;

-- Must return no rows: values outside the known set (e.g. '' left by a non-strict insert).
SELECT id, email, account_type FROM users
WHERE account_type NOT IN ('CLIENT', 'EMPLOYEE', 'STAFF', 'LIAISON', 'ADMIN', 'DEPARTMENT_HEAD');

-- Expected: no rows (nothing role-dependent besides the enum itself).
SELECT TRIGGER_NAME, EVENT_MANIPULATION FROM information_schema.TRIGGERS
WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'users';
SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'users';

-- Strict mode makes STEP 3 fail loudly instead of silently blanking a value it doesn't know.
SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES');
SELECT @@SESSION.sql_mode;

-- -----------------------------------------------------------------------------
-- STEP 1 — widen the enum to old + new values. Old and new code both keep working.
-- (Appending enum members is an in-place change; existing values keep their meaning.)
-- -----------------------------------------------------------------------------
ALTER TABLE `users`
  MODIFY `account_type` enum('CLIENT','EMPLOYEE','STAFF','LIAISON','ADMIN','DEPARTMENT_HEAD') NOT NULL COMMENT 'User role type';

-- -----------------------------------------------------------------------------
-- STEP 2 — rename the values (deploy the new application code first).
-- -----------------------------------------------------------------------------
START TRANSACTION;

UPDATE `users` SET `account_type` = 'ADMIN'           WHERE `account_type` = 'CLIENT';
UPDATE `users` SET `account_type` = 'DEPARTMENT_HEAD' WHERE `account_type` = 'EMPLOYEE';

-- Expected: only ADMIN, DEPARTMENT_HEAD, STAFF, LIAISON, with the same totals as in STEP 0
-- (ADMIN = old CLIENT count, DEPARTMENT_HEAD = old EMPLOYEE count).
SELECT account_type, COUNT(*) AS users FROM users GROUP BY account_type ORDER BY account_type;

-- If the counts are right:
COMMIT;
-- If not, run ROLLBACK; instead of COMMIT and investigate.

-- -----------------------------------------------------------------------------
-- STEP 3 — narrow the enum to the new values only.
-- Run only after STEP 2 is committed and this check returns 0:
-- -----------------------------------------------------------------------------
SELECT COUNT(*) AS old_values_left FROM users WHERE account_type IN ('CLIENT', 'EMPLOYEE');

-- Strict mode, in the same statement batch: without it MariaDB would silently turn any
-- CLIENT / EMPLOYEE still present into a blank role instead of failing. Keep these two together.
SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES');
ALTER TABLE `users`
  MODIFY `account_type` enum('ADMIN','DEPARTMENT_HEAD','STAFF','LIAISON') NOT NULL COMMENT 'User role type';

-- Final check. Expected: enum('ADMIN','DEPARTMENT_HEAD','STAFF','LIAISON').
SELECT COLUMN_TYPE FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'account_type';
SELECT account_type, COUNT(*) AS users FROM users GROUP BY account_type ORDER BY account_type;
