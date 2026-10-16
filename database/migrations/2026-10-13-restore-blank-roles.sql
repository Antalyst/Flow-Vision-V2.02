-- =============================================================================
-- FlowVision — restore the 6 accounts whose role became blank on the hosted database
-- (u520834156_flowVsionDB, MariaDB 11.8). ONE-OFF for that database; do not run it anywhere else.
--
-- What happened: users.account_type was narrowed to enum('ADMIN','DEPARTMENT_HEAD','STAFF','LIAISON')
-- while these rows still held CLIENT / EMPLOYEE. Outside strict mode MariaDB stores a value the
-- enum no longer allows as '' (blank) instead of failing, so these accounts lost their role.
-- The application refuses to sign in an account with a blank role until this is run.
--
-- Each account's original role comes from the audit log (USER_INVITE new_values.account_type, or
-- ORG_REGISTER for the organization's founder) and matches its office assignment (CLIENT accounts
-- have no office; EMPLOYEE accounts have one). Only account_type changes, and only while it is blank.
-- Run one block at a time.
-- =============================================================================

SELECT DATABASE() AS current_database;   -- expected: u520834156_flowVsionDB

-- Expected: these 6 rows, all with a blank account_type.
SELECT id, account_type, office_id IS NOT NULL AS has_office, status FROM users WHERE account_type = '' ORDER BY created_at;

START TRANSACTION;

-- Was CLIENT → ADMIN (expected: 3 rows affected)
UPDATE users SET account_type = 'ADMIN' WHERE account_type = '' AND id IN (
  '2d3de893-b884-47b2-80bd-7e25b028990c',  -- registered the organization (ORG_REGISTER), no office
  '7d79bcb4-9665-4117-8269-0ed1d7d4db2f',  -- invited as CLIENT (USER_INVITE), no office
  'cfb75a81-2aea-4a42-ad61-adb63739ba10'   -- invited as CLIENT (USER_INVITE), no office
);

-- Was EMPLOYEE → DEPARTMENT_HEAD (expected: 3 rows affected)
UPDATE users SET account_type = 'DEPARTMENT_HEAD' WHERE account_type = '' AND id IN (
  '7410d6f1-e272-4ed8-bf36-5a4f6080b3f2',  -- invited as EMPLOYEE (USER_INVITE), has an office
  '22d9548e-8555-4ab7-bc82-2253295a9ba8',  -- invited as EMPLOYEE (USER_INVITE), has an office
  '2c42b71c-094c-4377-a6c1-8bdc95654fb7'   -- invited as EMPLOYEE (USER_INVITE), has an office
);

-- Expected: 0 blank rows left, and ADMIN / DEPARTMENT_HEAD each up by the counts above.
SELECT COUNT(*) AS blank_left FROM users WHERE account_type = '';
SELECT account_type, COUNT(*) AS users FROM users GROUP BY account_type ORDER BY account_type;

-- If both checks look right:
COMMIT;
-- Otherwise run ROLLBACK; instead and nothing changes.
