# FlowVision Database Design

This document describes the complete database of FlowVision: every table, column, key and relationship, generated from the project schema (`database/flowvision-complete-schema.sql`).

## 1. Overview

| Item | Value |
|---|---|
| Database engine | MySQL-compatible (MariaDB 11 hosted, MySQL 8 / MariaDB locally), InnoDB storage engine |
| Character set | `utf8mb4`, collation `utf8mb4_unicode_ci` |
| Tables | 24 tables and 3 views |
| Relationships | 46 foreign keys |
| Primary keys | UUIDs stored as `CHAR(36)` (except `file_blobs` and `organization_settings`) |
| Time | Stored in UTC; days, working hours and QR dates are computed in Philippine time (UTC+8) |
| Access layer | Sequelize ORM; the schema file is the source of truth (the app never auto-creates tables) |

**Conventions**

- Every table has `created_at`; most also have `updated_at`, maintained by the database or the app.
- Every organization-owned table carries `org_id`, so each organization only ever sees its own data.
- Boolean values use `TINYINT(1)` (1 = yes, 0 = no).
- Fixed value sets use `ENUM`. JSON data (audit snapshots, visit event logs, page access) is stored in text columns.
- **Key** column legend: **PK** primary key, **FK** foreign key, **UQ** unique, **IX** indexed.

## 2. Tables at a glance

### Organization and setup

| No. | Table | Purpose | Columns |
|---:|---|---|---:|
| 1 | `organizations` | One row per organization (LGU) using FlowVision. | 9 |
| 2 | `organization_settings` | Working hours and working days of an organization (one row per organization). | 7 |
| 3 | `organization_holidays` | Holidays and other no-work days; processing time pauses on them. | 8 |
| 4 | `offices` | Offices of an organization; each office code is the prefix of its QR codes. | 15 |
| 5 | `document_types` | Document types offered on upload, with their processing time. | 11 |
| 6 | `document_templates` | Letterheads (logo, header, signature, footer) for documents drafted by the AI. | 17 |
| 7 | `knowledge_files` | Uploaded files whose text the AI uses as organization knowledge. | 16 |

### Users and access

| No. | Table | Purpose | Columns |
|---:|---|---|---:|
| 8 | `users` | User accounts and their role: ADMIN, DEPARTMENT_HEAD, STAFF or LIAISON (messenger). | 20 |
| 9 | `liaisons` | Messenger profile: duty status and delivery performance (one per LIAISON user). | 14 |
| 10 | `auth_sessions` | Signed-in sessions (sliding expiry). | 8 |
| 11 | `audit_logs` | Audit trail of administrative and document actions. | 9 |

### Document routing and tracking

| No. | Table | Purpose | Columns |
|---:|---|---|---:|
| 12 | `organization_routes` | Document Routes: the ordered offices a document passes through. | 8 |
| 13 | `route_steps` | The steps (offices) of a route, in order; the last step is the final checkpoint. | 9 |
| 14 | `documents` | Documents being tracked, with their current status and location. | 20 |
| 15 | `document_files` | Every file attached to a document (one QR covers all of them). | 8 |
| 16 | `qr_codes` | The permanent QR routing code of each document. | 7 |
| 17 | `document_tracking` | One row per office visit of a document, with its event log. | 12 |
| 18 | `approvals` | Final-checkpoint decisions (approve / return). | 10 |
| 19 | `issues` | Problems flagged on documents (delay, damage, missing, wrong routing). | 14 |

### Communication and AI

| No. | Table | Purpose | Columns |
|---:|---|---|---:|
| 20 | `messages` | Direct messages, document threads and office channels. | 11 |
| 21 | `notifications` | In-app notifications sent to users. | 10 |
| 22 | `ai_conversations` | AI Assistant chat threads (private to their owner). | 6 |
| 23 | `ai_messages` | Questions and answers inside an AI conversation. | 9 |

### File storage

| No. | Table | Purpose | Columns |
|---:|---|---|---:|
| 24 | `file_blobs` | File contents stored in the database in parts (used where the server disk is read-only). | 7 |

## 3. Relationships

Each foreign key, with what happens to the child rows when the parent row is deleted (**CASCADE** = deleted too, **SET NULL** = reference cleared, **RESTRICT** = delete is refused while children exist).

| Child table | Column | References | Cardinality | On delete |
|---|---|---|---|---|
| `organization_settings` | `org_id` | `organizations.id` | 1 : 1 | CASCADE |
| `organization_settings` | `updated_by` | `users.id` | N : 1 | SET NULL |
| `organization_holidays` | `org_id` | `organizations.id` | N : 1 | CASCADE |
| `organization_holidays` | `created_by` | `users.id` | N : 1 | SET NULL |
| `offices` | `manager_id` | `users.id` | N : 1 | SET NULL |
| `offices` | `org_id` | `organizations.id` | N : 1 | CASCADE |
| `document_types` | `org_id` | `organizations.id` | N : 1 | CASCADE |
| `document_types` | `created_by` | `users.id` | N : 1 | SET NULL |
| `document_templates` | `org_id` | `organizations.id` | N : 1 | CASCADE |
| `document_templates` | `created_by` | `users.id` | N : 1 | SET NULL |
| `knowledge_files` | `org_id` | `organizations.id` | N : 1 | CASCADE |
| `knowledge_files` | `uploaded_by` | `users.id` | N : 1 | SET NULL |
| `users` | `office_id` | `offices.id` | N : 1 | SET NULL |
| `users` | `org_id` | `organizations.id` | N : 1 | CASCADE |
| `liaisons` | `org_id` | `organizations.id` | N : 1 | CASCADE |
| `liaisons` | `user_id` | `users.id` | 1 : 1 | CASCADE |
| `auth_sessions` | `user_id` | `users.id` | N : 1 | CASCADE |
| `audit_logs` | `user_id` | `users.id` | N : 1 | SET NULL |
| `organization_routes` | `created_by` | `users.id` | N : 1 | RESTRICT |
| `organization_routes` | `org_id` | `organizations.id` | N : 1 | CASCADE |
| `route_steps` | `office_id` | `offices.id` | N : 1 | RESTRICT |
| `route_steps` | `route_id` | `organization_routes.id` | N : 1 | CASCADE |
| `documents` | `current_office_id` | `offices.id` | N : 1 | SET NULL |
| `documents` | `org_id` | `organizations.id` | N : 1 | CASCADE |
| `documents` | `route_id` | `organization_routes.id` | N : 1 | RESTRICT |
| `documents` | `submitted_by` | `users.id` | N : 1 | RESTRICT |
| `document_files` | `document_id` | `documents.id` | N : 1 | CASCADE |
| `qr_codes` | `document_id` | `documents.id` | 1 : 1 | CASCADE |
| `document_tracking` | `document_id` | `documents.id` | N : 1 | CASCADE |
| `document_tracking` | `handler_id` | `users.id` | N : 1 | SET NULL |
| `document_tracking` | `liaison_id` | `users.id` | N : 1 | SET NULL |
| `document_tracking` | `office_id` | `offices.id` | N : 1 | RESTRICT |
| `approvals` | `document_id` | `documents.id` | N : 1 | CASCADE |
| `approvals` | `office_id` | `offices.id` | N : 1 | RESTRICT |
| `approvals` | `staff_id` | `users.id` | N : 1 | RESTRICT |
| `issues` | `assigned_to` | `users.id` | N : 1 | SET NULL |
| `issues` | `document_id` | `documents.id` | N : 1 | CASCADE |
| `issues` | `reported_by` | `users.id` | N : 1 | RESTRICT |
| `messages` | `document_id` | `documents.id` | N : 1 | SET NULL |
| `messages` | `recipient_id` | `users.id` | N : 1 | SET NULL |
| `messages` | `sender_id` | `users.id` | N : 1 | CASCADE |
| `notifications` | `document_id` | `documents.id` | N : 1 | SET NULL |
| `notifications` | `user_id` | `users.id` | N : 1 | CASCADE |
| `ai_conversations` | `org_id` | `organizations.id` | N : 1 | CASCADE |
| `ai_conversations` | `user_id` | `users.id` | N : 1 | CASCADE |
| `ai_messages` | `conversation_id` | `ai_conversations.id` | N : 1 | CASCADE |

`file_blobs.file_url` is not a foreign key: it holds the storage key of a file that belongs to `documents`, `document_files`, `knowledge_files`, `organizations` (logo) or `document_templates` (signature).

The Entity Relationship Diagram (Chen notation) is in `docs/diagrams/erd-chen.png`.

## 4. Data dictionary

### 4.1 `organizations`

One row per organization (LGU) using FlowVision.

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `id` | CHAR(36) | No | PK |  | Primary key (UUID) |
| 2 | `name` | VARCHAR(255) | No |  |  | Organization name |
| 3 | `description` | TEXT | Yes |  | NULL | Description |
| 4 | `logo_url` | VARCHAR(500) | Yes |  | NULL | Storage key of the logo (printed on QR labels and letterheads) |
| 5 | `website` | VARCHAR(500) | Yes |  | NULL | Official website |
| 6 | `status` | ENUM('active','inactive') | No | IX | active | active or inactive |
| 7 | `created_by` | CHAR(36) | Yes |  | NULL | Admin who registered the organization |
| 8 | `created_at` | TIMESTAMP | No | IX | CURRENT_TIMESTAMP | When the row was created |
| 9 | `updated_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was last changed |

**Keys and indexes**

- Index `idx_organizations_status`: (`status`)
- Index `idx_organizations_created_at`: (`created_at`)

### 4.2 `organization_settings`

Working hours and working days of an organization (one row per organization).

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `org_id` | CHAR(36) | No | PK, FK |  | Organization (primary key; one row per organization) |
| 2 | `work_start` | CHAR(5) | No |  | 08:00 | Start of working hours, HH:MM (Philippine time) |
| 3 | `work_end` | CHAR(5) | No |  | 17:00 | End of working hours, HH:MM |
| 4 | `work_days` | VARCHAR(20) | No |  | 1,2,3,4,5 | Working days, e.g. 1,2,3,4,5 (0 = Sunday) |
| 5 | `updated_by` | CHAR(36) | Yes | FK | NULL | Admin who last changed it |
| 6 | `created_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was created |
| 7 | `updated_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was last changed |

**Keys and indexes**

- Foreign key `org_id` → `organizations.id` (on delete CASCADE)
- Foreign key `updated_by` → `users.id` (on delete SET NULL)

### 4.3 `organization_holidays`

Holidays and other no-work days; processing time pauses on them.

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `id` | CHAR(36) | No | PK |  | Primary key (UUID) |
| 2 | `org_id` | CHAR(36) | No | FK |  | Organization the row belongs to |
| 3 | `holiday_date` | DATE | No |  |  | The no-work day |
| 4 | `name` | VARCHAR(150) | No |  |  | Holiday name |
| 5 | `recurring` | TINYINT(1) | No |  | 0 | 1 = same month and day every year |
| 6 | `created_by` | CHAR(36) | Yes | FK | NULL | Admin who added it |
| 7 | `created_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was created |
| 8 | `updated_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was last changed |

**Keys and indexes**

- Unique `uq_organization_holidays_org_date`: (`org_id`, `holiday_date`)
- Foreign key `org_id` → `organizations.id` (on delete CASCADE)
- Foreign key `created_by` → `users.id` (on delete SET NULL)

### 4.4 `offices`

Offices of an organization; each office code is the prefix of its QR codes.

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `id` | CHAR(36) | No | PK |  | Primary key (UUID) |
| 2 | `org_id` | CHAR(36) | No | FK |  | Organization the row belongs to |
| 3 | `name` | VARCHAR(255) | No |  |  | Office name |
| 4 | `code` | VARCHAR(50) | No | UQ |  | Unique office code, used as the QR code prefix (e.g. BAG-ADM-RECORDS) |
| 5 | `address` | TEXT | Yes |  | NULL | Office address |
| 6 | `phone` | VARCHAR(20) | Yes |  | NULL | Contact number |
| 7 | `email` | VARCHAR(255) | Yes |  | NULL | Contact email |
| 8 | `latitude` | DECIMAL(10,8) | Yes |  | NULL | GPS latitude (not used yet) |
| 9 | `longitude` | DECIMAL(11,8) | Yes |  | NULL | GPS longitude (not used yet) |
| 10 | `manager_id` | CHAR(36) | Yes | FK | NULL | Office manager (not used yet) |
| 11 | `is_final_checkpoint` | TINYINT(1) | No |  | 0 | 1 = the office ends a route and approves documents (kept in sync with routes) |
| 12 | `department` | VARCHAR(100) | Yes |  | NULL | Department the office belongs to |
| 13 | `status` | ENUM('active','inactive') | No | IX | active | active or inactive |
| 14 | `created_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was created |
| 15 | `updated_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was last changed |

**Keys and indexes**

- Unique `uq_offices_code`: (`code`)
- Index `idx_offices_org_id`: (`org_id`)
- Index `idx_offices_status`: (`status`)
- Index `fk_offices_manager`: (`manager_id`)
- Foreign key `manager_id` → `users.id` (on delete SET NULL)
- Foreign key `org_id` → `organizations.id` (on delete CASCADE)

### 4.5 `document_types`

Document types offered on upload, with their processing time.

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `id` | CHAR(36) | No | PK |  | Primary key (UUID) |
| 2 | `org_id` | CHAR(36) | No | FK |  | Organization the row belongs to |
| 3 | `name` | VARCHAR(100) | No |  |  | Type name, e.g. Purchase Request |
| 4 | `description` | VARCHAR(500) | Yes |  | NULL | What the type covers (also read by the AI) |
| 5 | `processing_days` | INT | No |  | 0 | Processing time: working days |
| 6 | `processing_hours` | INT | No |  | 0 | Processing time: extra working hours (0 + 0 = no deadline) |
| 7 | `is_active` | TINYINT(1) | No |  | 1 | Offered on upload |
| 8 | `sort_order` | INT | No |  | 0 | Position in the list |
| 9 | `created_by` | CHAR(36) | Yes | FK | NULL | Admin who added it |
| 10 | `created_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was created |
| 11 | `updated_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was last changed |

**Keys and indexes**

- Unique `uq_document_types_org_name`: (`org_id`, `name`)
- Foreign key `org_id` → `organizations.id` (on delete CASCADE)
- Foreign key `created_by` → `users.id` (on delete SET NULL)

### 4.6 `document_templates`

Letterheads (logo, header, signature, footer) for documents drafted by the AI.

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `id` | CHAR(36) | No | PK |  | Primary key (UUID) |
| 2 | `org_id` | CHAR(36) | No | FK |  | Organization the row belongs to |
| 3 | `name` | VARCHAR(100) | No |  |  | Template name, e.g. Memorandum |
| 4 | `description` | VARCHAR(500) | Yes |  | NULL | When to use it (read by the AI to choose) |
| 5 | `show_logo` | TINYINT(1) | No |  | 1 | Print the organization logo |
| 6 | `header_text` | TEXT | Yes |  | NULL | Letterhead lines |
| 7 | `body_guide` | TEXT | Yes |  | NULL | Structure the AI follows for the body |
| 8 | `signatory_name` | VARCHAR(150) | Yes |  | NULL | Signature block: name |
| 9 | `signatory_title` | VARCHAR(150) | Yes |  | NULL | Signature block: position |
| 10 | `signature_url` | VARCHAR(500) | Yes |  | NULL | Storage key of the signature image |
| 11 | `footer_text` | VARCHAR(500) | Yes |  | NULL | Footer line |
| 12 | `is_default` | TINYINT(1) | No |  | 0 | Used when the AI picks none |
| 13 | `is_active` | TINYINT(1) | No |  | 1 | Offered to the AI |
| 14 | `sort_order` | INT | No |  | 0 | Position in the list |
| 15 | `created_by` | CHAR(36) | Yes | FK | NULL | Admin who added it |
| 16 | `created_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was created |
| 17 | `updated_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was last changed |

**Keys and indexes**

- Unique `uq_document_templates_org_name`: (`org_id`, `name`)
- Foreign key `org_id` → `organizations.id` (on delete CASCADE)
- Foreign key `created_by` → `users.id` (on delete SET NULL)

### 4.7 `knowledge_files`

Uploaded files whose text the AI uses as organization knowledge.

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `id` | CHAR(36) | No | PK |  | Primary key (UUID) |
| 2 | `org_id` | CHAR(36) | No | FK |  | Organization the row belongs to |
| 3 | `title` | VARCHAR(255) | No |  |  | Name shown in settings |
| 4 | `description` | TEXT | Yes |  | NULL | What the file is about |
| 5 | `file_url` | VARCHAR(500) | No |  |  | Storage key: knowledge/<uuid>/<file name> |
| 6 | `file_name` | VARCHAR(255) | No |  |  | Original file name |
| 7 | `file_type` | VARCHAR(100) | Yes |  | NULL | MIME type |
| 8 | `file_size` | BIGINT | No |  |  | Size in bytes |
| 9 | `content` | LONGTEXT | Yes |  | NULL | Text extracted from the file (searched by the AI) |
| 10 | `char_count` | INT | No |  | 0 | Length of the extracted text |
| 11 | `status` | ENUM('READY','NO_TEXT','FAILED') | No |  | READY | READY, NO_TEXT or FAILED |
| 12 | `error` | VARCHAR(500) | Yes |  | NULL | Why text extraction failed |
| 13 | `is_active` | TINYINT(1) | No |  | 1 | Used by the AI |
| 14 | `uploaded_by` | CHAR(36) | Yes | FK | NULL | Admin who uploaded it |
| 15 | `created_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was created |
| 16 | `updated_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was last changed |

**Keys and indexes**

- Index `idx_knowledge_files_org`: (`org_id`, `is_active`)
- Foreign key `org_id` → `organizations.id` (on delete CASCADE)
- Foreign key `uploaded_by` → `users.id` (on delete SET NULL)

### 4.8 `users`

User accounts and their role: ADMIN, DEPARTMENT_HEAD, STAFF or LIAISON (messenger).

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `id` | CHAR(36) | No | PK |  | Primary key (UUID) |
| 2 | `org_id` | CHAR(36) | No | FK |  | Organization the row belongs to |
| 3 | `email` | VARCHAR(255) | No | UQ |  | Login email (unique) |
| 4 | `password_hash` | VARCHAR(255) | No |  |  | bcrypt hash of the password |
| 5 | `first_name` | VARCHAR(100) | Yes |  | NULL | First name |
| 6 | `last_name` | VARCHAR(100) | Yes |  | NULL | Last name |
| 7 | `full_name` | VARCHAR(255) | Yes |  | NULL | Full name (kept in sync) |
| 8 | `account_type` | ENUM('ADMIN','DEPARTMENT_HEAD','STAFF','LIAISON') | No |  |  | Role: ADMIN, DEPARTMENT_HEAD, STAFF or LIAISON (messenger) |
| 9 | `office_id` | CHAR(36) | Yes | FK | NULL | Assigned office (NULL for an admin) |
| 10 | `avatar_url` | VARCHAR(500) | Yes |  | NULL | Profile picture (not used yet) |
| 11 | `phone` | VARCHAR(20) | Yes |  | NULL | Contact number |
| 12 | `position` | VARCHAR(100) | Yes |  | NULL | Job position |
| 13 | `department` | VARCHAR(100) | Yes |  | NULL | Department of the assigned office |
| 14 | `status` | ENUM('active','inactive','pending') | No | IX | pending | active, pending (temporary password) or inactive (suspended) |
| 15 | `last_login` | TIMESTAMP | Yes |  | NULL | Last sign-in time |
| 16 | `email_verified` | TINYINT(1) | No |  | 0 | Email verified (not used yet) |
| 17 | `two_factor_enabled` | TINYINT(1) | No |  | 0 | Two-factor authentication (not used yet) |
| 18 | `page_access` | TEXT | Yes |  | NULL | JSON list of pages the account may open (NULL = all pages of its role) |
| 19 | `created_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was created |
| 20 | `updated_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was last changed |

**Keys and indexes**

- Unique `uq_users_email`: (`email`)
- Index `idx_users_org_office`: (`org_id`, `office_id`, `account_type`)
- Index `idx_users_status`: (`status`)
- Index `fk_users_office`: (`office_id`)
- Foreign key `office_id` → `offices.id` (on delete SET NULL)
- Foreign key `org_id` → `organizations.id` (on delete CASCADE)

### 4.9 `liaisons`

Messenger profile: duty status and delivery performance (one per LIAISON user).

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `id` | CHAR(36) | No | PK |  | Primary key (UUID) |
| 2 | `user_id` | CHAR(36) | No | FK, UQ |  | The messenger (LIAISON) user |
| 3 | `org_id` | CHAR(36) | No | FK |  | Organization the row belongs to |
| 4 | `department` | VARCHAR(100) | Yes |  | NULL | Department of the messenger's office |
| 5 | `available` | TINYINT(1) | No | IX | 1 | 1 = on duty, 0 = off duty |
| 6 | `deliveries_today` | INT | No |  | 0 | Deliveries completed today (Philippine time) |
| 7 | `total_deliveries` | INT | No |  | 0 | All delivery attempts |
| 8 | `average_delivery_time` | INT | Yes |  | NULL | Average pickup-to-delivery time in minutes |
| 9 | `success_rate` | DECIMAL(5,2) | Yes |  | NULL | Percentage of successful deliveries |
| 10 | `last_delivery` | TIMESTAMP | Yes |  | NULL | Time of the last delivery |
| 11 | `phone` | VARCHAR(20) | Yes |  | NULL | Contact number |
| 12 | `vehicle_type` | VARCHAR(50) | Yes |  | NULL | Vehicle used (not used yet) |
| 13 | `created_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was created |
| 14 | `updated_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was last changed |

**Keys and indexes**

- Unique `uq_liaisons_user_id`: (`user_id`)
- Index `idx_liaisons_org_id`: (`org_id`)
- Index `idx_liaisons_available`: (`available`)
- Foreign key `org_id` → `organizations.id` (on delete CASCADE)
- Foreign key `user_id` → `users.id` (on delete CASCADE)

### 4.10 `auth_sessions`

Signed-in sessions (sliding expiry).

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `id` | CHAR(36) | No | PK |  | Primary key (UUID) |
| 2 | `user_id` | CHAR(36) | No | FK |  | Signed-in user |
| 3 | `token` | VARCHAR(500) | No |  |  | SHA-256 hash of the session cookie (the raw token is never stored) |
| 4 | `device_info` | VARCHAR(255) | Yes |  | NULL | Device information |
| 5 | `ip_address` | VARCHAR(45) | Yes |  | NULL | IP address at sign-in |
| 6 | `user_agent` | VARCHAR(500) | Yes |  | NULL | Browser user agent |
| 7 | `expires_at` | TIMESTAMP | No | IX |  | Session expiry (extended while the user is active) |
| 8 | `created_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was created |

**Keys and indexes**

- Index `idx_auth_sessions_user_id`: (`user_id`)
- Index `idx_auth_sessions_expires_at`: (`expires_at`)
- Foreign key `user_id` → `users.id` (on delete CASCADE)

### 4.11 `audit_logs`

Audit trail of administrative and document actions.

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `id` | CHAR(36) | No | PK |  | Primary key (UUID) |
| 2 | `user_id` | CHAR(36) | Yes | FK | NULL | User who performed the action |
| 3 | `action` | VARCHAR(100) | No | IX |  | Action code, e.g. USER_INVITE, ROUTE_CREATE, DOCUMENT_SUBMIT |
| 4 | `entity_type` | VARCHAR(50) | No | IX |  | Kind of record affected (document, user, office…) |
| 5 | `entity_id` | CHAR(36) | No |  |  | ID of the affected record |
| 6 | `old_values` | LONGTEXT | Yes |  | NULL | JSON snapshot before the change |
| 7 | `new_values` | LONGTEXT | Yes |  | NULL | JSON snapshot after the change |
| 8 | `ip_address` | VARCHAR(45) | Yes |  | NULL | IP address of the request |
| 9 | `created_at` | TIMESTAMP | No | IX | CURRENT_TIMESTAMP | When the row was created |

**Keys and indexes**

- Index `idx_audit_logs_user_id`: (`user_id`)
- Index `idx_audit_logs_created_at`: (`created_at`)
- Index `idx_audit_logs_entity`: (`entity_type`, `entity_id`)
- Index `idx_audit_logs_action`: (`action`)
- Foreign key `user_id` → `users.id` (on delete SET NULL)

### 4.12 `organization_routes`

Document Routes: the ordered offices a document passes through.

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `id` | CHAR(36) | No | PK |  | Primary key (UUID) |
| 2 | `org_id` | CHAR(36) | No | FK |  | Organization the row belongs to |
| 3 | `name` | VARCHAR(255) | No |  |  | Route name (unique among active routes) |
| 4 | `description` | TEXT | Yes |  | NULL | Route description |
| 5 | `is_active` | TINYINT(1) | No | IX | 1 | 1 = offered for new documents; 0 = retired or a snapshot of an edited route |
| 6 | `created_by` | CHAR(36) | No | FK |  | Admin who created the route |
| 7 | `created_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was created |
| 8 | `updated_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was last changed |

**Keys and indexes**

- Index `idx_organization_routes_org_id`: (`org_id`)
- Index `idx_organization_routes_is_active`: (`is_active`)
- Index `idx_organization_routes_created_by`: (`created_by`)
- Foreign key `created_by` → `users.id` (on delete RESTRICT)
- Foreign key `org_id` → `organizations.id` (on delete CASCADE)

### 4.13 `route_steps`

The steps (offices) of a route, in order; the last step is the final checkpoint.

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `id` | CHAR(36) | No | PK |  | Primary key (UUID) |
| 2 | `route_id` | CHAR(36) | No | FK |  | Route the step belongs to |
| 3 | `step_number` | INT | No |  |  | Order of the step (1, 2, 3…) |
| 4 | `office_id` | CHAR(36) | No | FK |  | Office at this step |
| 5 | `sla_days` | INT | Yes |  | NULL | Older per-step processing days (fallback only) |
| 6 | `sla_hours` | INT | No |  | 0 | Older per-step processing hours (fallback only) |
| 7 | `action_description` | VARCHAR(255) | Yes |  | NULL | What the office does at this step, e.g. Review |
| 8 | `is_final_checkpoint` | TINYINT(1) | No |  | 0 | 1 = last step, where the document is approved or returned |
| 9 | `created_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was created |

**Keys and indexes**

- Unique `uq_route_step`: (`route_id`, `step_number`)
- Index `idx_route_steps_office_id`: (`office_id`)
- Foreign key `office_id` → `offices.id` (on delete RESTRICT)
- Foreign key `route_id` → `organization_routes.id` (on delete CASCADE)

### 4.14 `documents`

Documents being tracked, with their current status and location.

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `id` | CHAR(36) | No | PK |  | Primary key (UUID) |
| 2 | `org_id` | CHAR(36) | No | FK |  | Organization the row belongs to |
| 3 | `route_id` | CHAR(36) | No | FK |  | Document Route the document follows |
| 4 | `title` | VARCHAR(255) | No |  |  | Document title |
| 5 | `description` | TEXT | Yes |  | NULL | Document description |
| 6 | `category` | VARCHAR(100) | Yes |  | NULL | Document type name (from document_types) |
| 7 | `priority` | ENUM('LOW','NORMAL','HIGH','URGENT') | No |  | NORMAL | LOW, NORMAL, HIGH or URGENT (set automatically from the document and its processing time) |
| 8 | `status` | ENUM('CREATED','START','PICKED_UP','IN_TRANSIT','ARRIVED_AT_OFFICE','COMPLETED','RETURNED') | No |  | CREATED | CREATED, START, PICKED_UP, IN_TRANSIT, ARRIVED_AT_OFFICE, COMPLETED or RETURNED |
| 9 | `submitted_by` | CHAR(36) | No | FK |  | User who uploaded the document |
| 10 | `current_step_number` | INT | No |  | 1 | Current route step (0 = still at its origin) |
| 11 | `current_office_id` | CHAR(36) | Yes | FK | NULL | Office the document is at now (NULL = the organization, for an admin upload at its origin) |
| 12 | `target_completion_date` | TIMESTAMP | Yes |  | NULL | Deadline, from the document type processing time in working hours |
| 13 | `file_url` | VARCHAR(500) | Yes |  | NULL | Storage key of the first attached file |
| 14 | `file_size` | INT | Yes |  | NULL | Size of the first file in bytes |
| 15 | `file_type` | VARCHAR(50) | Yes |  | NULL | MIME type of the first file |
| 16 | `pages` | INT | Yes |  | NULL | Number of pages / sheets |
| 17 | `submitted_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When it was submitted onto its route |
| 18 | `completed_at` | TIMESTAMP | Yes |  | NULL | When it was approved at the final checkpoint |
| 19 | `created_at` | TIMESTAMP | No | IX | CURRENT_TIMESTAMP | When the row was created |
| 20 | `updated_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was last changed |

**Keys and indexes**

- Index `idx_documents_search`: (`org_id`, `status`, `created_at`)
- Index `idx_documents_route_id`: (`route_id`)
- Index `idx_documents_submitted_by`: (`submitted_by`)
- Index `idx_documents_current_office`: (`current_office_id`)
- Index `idx_documents_created_at`: (`created_at`)
- Foreign key `current_office_id` → `offices.id` (on delete SET NULL)
- Foreign key `org_id` → `organizations.id` (on delete CASCADE)
- Foreign key `route_id` → `organization_routes.id` (on delete RESTRICT)
- Foreign key `submitted_by` → `users.id` (on delete RESTRICT)

### 4.15 `document_files`

Every file attached to a document (one QR covers all of them).

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `id` | CHAR(36) | No | PK |  | Primary key (UUID) |
| 2 | `document_id` | CHAR(36) | No | FK |  | Document the file belongs to |
| 3 | `file_url` | VARCHAR(500) | No |  |  | Storage key: <uuid>/<original file name> |
| 4 | `file_name` | VARCHAR(255) | No |  |  | Original file name |
| 5 | `file_type` | VARCHAR(100) | Yes |  | NULL | MIME type (or extension) |
| 6 | `file_size` | INT | No |  | 0 | Size in bytes |
| 7 | `sort_order` | INT | No |  | 0 | Order within the document |
| 8 | `created_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was created |

**Keys and indexes**

- Index `idx_document_files_document`: (`document_id`, `sort_order`)
- Foreign key `document_id` → `documents.id` (on delete CASCADE)

### 4.16 `qr_codes`

The permanent QR routing code of each document.

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `id` | CHAR(36) | No | PK |  | Primary key (UUID) |
| 2 | `document_id` | CHAR(36) | No | FK, UQ |  | Document the code belongs to |
| 3 | `qr_code_data` | VARCHAR(500) | No | UQ |  | Routing code on the QR label: {OFFICE_CODE}{MMDDYY}{6 digits} |
| 4 | `format` | VARCHAR(50) | No |  | QR | Code format (QR) |
| 5 | `size` | VARCHAR(20) | No |  | 25mm | Printed label size |
| 6 | `office_code` | VARCHAR(50) | Yes |  | NULL | Origin office (or organization) code used as prefix |
| 7 | `created_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was created |

**Keys and indexes**

- Unique `uq_qr_codes_document`: (`document_id`)
- Unique `uq_qr_codes_data`: (`qr_code_data`)
- Foreign key `document_id` → `documents.id` (on delete CASCADE)

### 4.17 `document_tracking`

One row per office visit of a document, with its event log.

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `id` | CHAR(36) | No | PK |  | Primary key (UUID) |
| 2 | `document_id` | CHAR(36) | No | FK |  | Document visited |
| 3 | `step_number` | INT | No |  |  | Route step of this visit (0 = origin) |
| 4 | `office_id` | CHAR(36) | Yes | FK | NULL | Office visited (NULL = the organization, for step 0 of an admin upload) |
| 5 | `status` | ENUM('CREATED','START','PICKED_UP','IN_TRANSIT','ARRIVED_AT_OFFICE','COMPLETED','RETURNED') | No | IX |  | Document status during this visit |
| 6 | `handler_id` | CHAR(36) | Yes | FK | NULL | Person who received (scanned in) the document at this office |
| 7 | `liaison_id` | CHAR(36) | Yes | FK | NULL | Messenger the document was released to / carried by |
| 8 | `arrived_at` | TIMESTAMP | Yes |  | NULL | When the document reached the office |
| 9 | `completed_at` | TIMESTAMP | Yes |  | NULL | When it left the office (pickup) or was decided |
| 10 | `notes` | TEXT | Yes |  | NULL | JSON event log of the visit (received, released, picked up, notes…) |
| 11 | `created_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was created |
| 12 | `updated_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was last changed |

**Keys and indexes**

- Index `idx_document_tracking_timeline`: (`document_id`, `created_at`)
- Index `idx_document_tracking_office_id`: (`office_id`)
- Index `idx_document_tracking_status`: (`status`)
- Index `idx_document_tracking_handler_id`: (`handler_id`)
- Index `idx_document_tracking_liaison_id`: (`liaison_id`)
- Foreign key `document_id` → `documents.id` (on delete CASCADE)
- Foreign key `handler_id` → `users.id` (on delete SET NULL)
- Foreign key `liaison_id` → `users.id` (on delete SET NULL)
- Foreign key `office_id` → `offices.id` (on delete RESTRICT)

### 4.18 `approvals`

Final-checkpoint decisions (approve / return).

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `id` | CHAR(36) | No | PK |  | Primary key (UUID) |
| 2 | `document_id` | CHAR(36) | No | FK |  | Document reference |
| 3 | `staff_id` | CHAR(36) | No | FK |  | Department head or staff member asked to decide |
| 4 | `office_id` | CHAR(36) | No | FK |  | Final-checkpoint office |
| 5 | `step_number` | INT | No |  |  | Route step of the final checkpoint |
| 6 | `status` | ENUM('PENDING','APPROVED','RETURNED') | No | IX | PENDING | PENDING, APPROVED or RETURNED |
| 7 | `remarks` | TEXT | Yes |  | NULL | Decision remarks (required when returning) |
| 8 | `approved_at` | TIMESTAMP | Yes |  | NULL | When the decision was made |
| 9 | `created_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was created |
| 10 | `updated_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was last changed |

**Keys and indexes**

- Unique `uq_approvals_doc_staff_office`: (`document_id`, `staff_id`, `office_id`)
- Index `idx_approvals_pending`: (`status`, `created_at`)
- Index `idx_approvals_staff_id`: (`staff_id`)
- Index `idx_approvals_office_id`: (`office_id`)
- Foreign key `document_id` → `documents.id` (on delete CASCADE)
- Foreign key `office_id` → `offices.id` (on delete RESTRICT)
- Foreign key `staff_id` → `users.id` (on delete RESTRICT)

### 4.19 `issues`

Problems flagged on documents (delay, damage, missing, wrong routing).

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `id` | CHAR(36) | No | PK |  | Primary key (UUID) |
| 2 | `document_id` | CHAR(36) | No | FK |  | Document the issue is about |
| 3 | `title` | VARCHAR(255) | No |  |  | Issue title |
| 4 | `description` | TEXT | Yes |  | NULL | Details |
| 5 | `issue_type` | VARCHAR(100) | Yes |  | NULL | MISSING_DOCUMENT, DELAY, DAMAGE, INCORRECT_ROUTING, SYSTEM or OTHER |
| 6 | `priority` | ENUM('LOW','MEDIUM','HIGH','CRITICAL') | No | IX | MEDIUM | Severity: LOW, MEDIUM, HIGH or CRITICAL |
| 7 | `status` | ENUM('OPEN','IN_PROGRESS','RESOLVED','CLOSED') | No | IX | OPEN | OPEN, IN_PROGRESS, RESOLVED or CLOSED |
| 8 | `reported_by` | CHAR(36) | No | FK |  | User who reported it |
| 9 | `assigned_to` | CHAR(36) | Yes | FK | NULL | User assigned to resolve it |
| 10 | `resolution_notes` | TEXT | Yes |  | NULL | How it was resolved |
| 11 | `reported_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When it was reported |
| 12 | `resolved_at` | TIMESTAMP | Yes |  | NULL | When it was resolved or closed |
| 13 | `created_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was created |
| 14 | `updated_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was last changed |

**Keys and indexes**

- Index `idx_issues_document_id`: (`document_id`)
- Index `idx_issues_status`: (`status`)
- Index `idx_issues_priority`: (`priority`)
- Index `idx_issues_reported_by`: (`reported_by`)
- Index `idx_issues_assigned_to`: (`assigned_to`)
- Foreign key `assigned_to` → `users.id` (on delete SET NULL)
- Foreign key `document_id` → `documents.id` (on delete CASCADE)
- Foreign key `reported_by` → `users.id` (on delete RESTRICT)

### 4.20 `messages`

Direct messages, document threads and office channels.

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `id` | CHAR(36) | No | PK |  | Primary key (UUID) |
| 2 | `document_id` | CHAR(36) | Yes | FK | NULL | Document thread (for GROUP messages) |
| 3 | `sender_id` | CHAR(36) | No | FK |  | User who sent the message |
| 4 | `recipient_id` | CHAR(36) | Yes | FK | NULL | Recipient (for DIRECT messages) |
| 5 | `conversation_type` | ENUM('DIRECT','GROUP','OFFICE','BROADCAST') | No |  | DIRECT | DIRECT, GROUP (document thread) or OFFICE (BROADCAST is reserved) |
| 6 | `content` | TEXT | No |  |  | Message text |
| 7 | `attachment_url` | VARCHAR(500) | Yes |  | NULL | Attachment (not used yet) |
| 8 | `is_read` | TINYINT(1) | No | IX | 0 | Read status |
| 9 | `read_at` | TIMESTAMP | Yes |  | NULL | When it was read |
| 10 | `created_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was created |
| 11 | `updated_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was last changed |

**Keys and indexes**

- Index `idx_messages_timeline`: (`sender_id`, `recipient_id`, `created_at`)
- Index `idx_messages_document_id`: (`document_id`)
- Index `idx_messages_recipient_id`: (`recipient_id`)
- Index `idx_messages_is_read`: (`is_read`)
- Foreign key `document_id` → `documents.id` (on delete SET NULL)
- Foreign key `recipient_id` → `users.id` (on delete SET NULL)
- Foreign key `sender_id` → `users.id` (on delete CASCADE)

### 4.21 `notifications`

In-app notifications sent to users.

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `id` | CHAR(36) | No | PK |  | Primary key (UUID) |
| 2 | `user_id` | CHAR(36) | No | FK |  | Recipient |
| 3 | `document_id` | CHAR(36) | Yes | FK | NULL | Related document |
| 4 | `type` | VARCHAR(50) | No |  |  | Event code, e.g. DOCUMENT_INCOMING, APPROVAL_REQUESTED |
| 5 | `title` | VARCHAR(255) | Yes |  | NULL | Notification title |
| 6 | `message` | TEXT | No |  |  | Notification text |
| 7 | `is_read` | TINYINT(1) | No |  | 0 | Read status |
| 8 | `read_at` | TIMESTAMP | Yes |  | NULL | When it was read |
| 9 | `action_url` | VARCHAR(500) | Yes |  | NULL | Page opened when the notification is clicked |
| 10 | `created_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was created |

**Keys and indexes**

- Index `idx_notifications_user_unread`: (`user_id`, `is_read`, `created_at`)
- Index `idx_notifications_document_id`: (`document_id`)
- Foreign key `document_id` → `documents.id` (on delete SET NULL)
- Foreign key `user_id` → `users.id` (on delete CASCADE)

### 4.22 `ai_conversations`

AI Assistant chat threads (private to their owner).

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `id` | CHAR(36) | No | PK |  | Primary key (UUID) |
| 2 | `org_id` | CHAR(36) | No | FK |  | Organization the row belongs to |
| 3 | `user_id` | CHAR(36) | No | FK |  | Owner; only this user can read the conversation |
| 4 | `title` | VARCHAR(255) | No |  |  | Title taken from the first question |
| 5 | `created_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the row was created |
| 6 | `updated_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | Last activity (newest first in the list) |

**Keys and indexes**

- Index `idx_ai_conversations_user`: (`user_id`, `updated_at`)
- Foreign key `org_id` → `organizations.id` (on delete CASCADE)
- Foreign key `user_id` → `users.id` (on delete CASCADE)

### 4.23 `ai_messages`

Questions and answers inside an AI conversation.

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `id` | CHAR(36) | No | PK |  | Primary key (UUID) |
| 2 | `conversation_id` | CHAR(36) | No | FK |  | Conversation the message belongs to |
| 3 | `role` | ENUM('user','assistant') | No |  |  | user (question) or assistant (answer) |
| 4 | `content` | MEDIUMTEXT | No |  |  | Message text (Markdown; answers may contain canvases) |
| 5 | `model` | VARCHAR(100) | Yes |  | NULL | AI model that wrote the answer |
| 6 | `tools` | TEXT | Yes |  | NULL | JSON list of data lookups behind the answer |
| 7 | `is_error` | TINYINT(1) | No |  | 0 | 1 = error notice shown instead of an answer |
| 8 | `failed` | TINYINT(1) | No |  | 0 | 1 = question that got no answer |
| 9 | `created_at` | TIMESTAMP(3) | No |  | CURRENT_TIMESTAMP | Time with milliseconds (keeps the thread order) |

**Keys and indexes**

- Index `idx_ai_messages_conversation`: (`conversation_id`, `created_at`)
- Foreign key `conversation_id` → `ai_conversations.id` (on delete CASCADE)

### 4.24 `file_blobs`

File contents stored in the database in parts (used where the server disk is read-only).

| No. | Field | Data type | Null | Key | Default | Description |
|---:|---|---|:-:|:-:|---|---|
| 1 | `file_url` | VARCHAR(255) | No | PK |  | Storage key of the file (same as the file_url of its owner) |
| 2 | `part` | INT | No | PK | 0 | Part number; files are stored in parts of up to 3 MB |
| 3 | `data` | MEDIUMBLOB | No |  |  | Bytes of this part |
| 4 | `size` | INT | No |  | 0 | Size of this part in bytes |
| 5 | `uploaded_by` | CHAR(36) | Yes |  | NULL | User uploading a large file in parts |
| 6 | `complete` | TINYINT(1) | No | IX | 1 | 0 = upload still arriving, 1 = stored file |
| 7 | `created_at` | TIMESTAMP | No |  | CURRENT_TIMESTAMP | When the part was stored |

**Keys and indexes**

- Primary key: (`file_url`, `part`)
- Index `idx_file_blobs_staged`: (`complete`, `created_at`)

## 5. Views

Read-only reporting views defined in the schema (the application itself reads the tables directly).

| View | Shows | Based on |
|---|---|---|
| `active_documents_by_office` | Documents in progress (START, PICKED_UP, IN_TRANSIT, ARRIVED_AT_OFFICE) with their current office and submitter | `documents`, `offices`, `users` |
| `liaison_performance` | Each messenger with availability, deliveries today, total deliveries, average delivery time, success rate, last delivery | `liaisons`, `users` |
| `pending_approvals` | Documents waiting for a decision, per staff member and office, with the time they have been pending | `documents`, `approvals`, `users`, `offices` |

## 6. Enumerated values

| Table.column | Values | Meaning |
|---|---|---|
| `users.account_type` | ADMIN · DEPARTMENT_HEAD · STAFF · LIAISON | Organization administrator · head of an office · office staff · messenger |
| `users.status` | active · pending · inactive | Can sign in · must change a temporary password · suspended |
| `documents.status`, `document_tracking.status` | CREATED · START · PICKED_UP · IN_TRANSIT · ARRIVED_AT_OFFICE · COMPLETED · RETURNED | Draft · at origin · picked up by a messenger · in transit · at an office · approved · returned to the uploader |
| `documents.priority` | LOW · NORMAL · HIGH · URGENT | Set automatically from the document text, type and processing time |
| `approvals.status` | PENDING · APPROVED · RETURNED | Waiting · approved (document completed) · returned with remarks |
| `issues.priority` | LOW · MEDIUM · HIGH · CRITICAL | Severity |
| `issues.status` | OPEN · IN_PROGRESS · RESOLVED · CLOSED | Issue lifecycle |
| `issues.issue_type` | MISSING_DOCUMENT · DELAY · DAMAGE · INCORRECT_ROUTING · SYSTEM · OTHER | Category (free text column; these are the values the app offers) |
| `messages.conversation_type` | DIRECT · GROUP · OFFICE · BROADCAST | Person to person · document thread · office channel · reserved |
| `knowledge_files.status` | READY · NO_TEXT · FAILED | Text extracted · no readable text · extraction failed |
| `ai_messages.role` | user · assistant | Question · answer |
| `offices.status`, `organizations.status` | active · inactive | In use · disabled |

## 7. Integrity and security rules

- **Organization isolation:** every query is filtered by `org_id`; issues are scoped through their document.
- **Referential integrity:** enforced by the foreign keys above. Offices, users, routes and documents reference their organization with ON DELETE CASCADE, and a document's files, QR code, visits, approvals and issues are deleted with the document. References that must not disappear (who submitted a document, who created a route, who reported an issue) use RESTRICT.
- **Uniqueness:** login email (`users.email`), office code (`offices.code`), one QR code per document and per code value (`qr_codes`), one approval per (document, staff, office), one step number per route, one messenger profile per user.
- **Workflow consistency:** every document status change runs in a database transaction with the document row locked (`SELECT … FOR UPDATE`).
- **Passwords** are stored only as bcrypt hashes; **sessions** store only the SHA-256 hash of the session token.
- **History is kept:** a retired or edited route stays in `organization_routes` (`is_active = 0`) so completed documents keep their path; audit snapshots are never rewritten.
