-- =============================================================================
-- FlowVision — project database schema (MariaDB 11 / MySQL 8)
-- Exported from the hosted database; DEFINER clauses removed so it imports anywhere.
-- Apply to a LOCAL database with: npm run db:schema   (drops and recreates every table)
-- =============================================================================

-- phpMyAdmin SQL Dump
-- version 5.2.2
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1
-- Generation Time: Oct 04, 2026 at 11:34 PM
-- Server version: 11.8.9-MariaDB-log
-- PHP Version: 7.2.34

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `u520834156_flowVsionDB`
--

-- --------------------------------------------------------

--
-- Stand-in structure for view `active_documents_by_office`
-- (See below for the actual view)
--
CREATE TABLE `active_documents_by_office` (
`id` char(36)
,`title` varchar(255)
,`priority` enum('LOW','NORMAL','HIGH','URGENT')
,`status` enum('CREATED','START','PICKED_UP','IN_TRANSIT','ARRIVED_AT_OFFICE','COMPLETED','RETURNED')
,`current_office_id` char(36)
,`office_name` varchar(255)
,`submitted_by` varchar(255)
,`created_at` timestamp
);

-- --------------------------------------------------------

--
-- Table structure for table `approvals`
--

CREATE TABLE `approvals` (
  `id` char(36) NOT NULL,
  `document_id` char(36) NOT NULL COMMENT 'Document reference',
  `staff_id` char(36) NOT NULL COMMENT 'STAFF user reference',
  `office_id` char(36) NOT NULL COMMENT 'Office (final checkpoint)',
  `step_number` int(11) NOT NULL COMMENT 'Route step number',
  `status` enum('PENDING','APPROVED','RETURNED') NOT NULL DEFAULT 'PENDING' COMMENT 'Approval status',
  `remarks` text DEFAULT NULL COMMENT 'Approval remarks/notes',
  `approved_at` timestamp NULL DEFAULT NULL COMMENT 'Approval time',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Document approval records (final checkpoint only)';

-- --------------------------------------------------------

--
-- Table structure for table `audit_logs`
--

CREATE TABLE `audit_logs` (
  `id` char(36) NOT NULL,
  `user_id` char(36) DEFAULT NULL COMMENT 'User who performed action',
  `action` varchar(100) NOT NULL COMMENT 'Action performed',
  `entity_type` varchar(50) NOT NULL COMMENT 'Entity type (document, user, etc)',
  `entity_id` char(36) NOT NULL COMMENT 'Entity ID',
  `old_values` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'Previous values' CHECK (json_valid(`old_values`)),
  `new_values` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'New values' CHECK (json_valid(`new_values`)),
  `ip_address` varchar(45) DEFAULT NULL COMMENT 'Source IP address',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Complete audit trail of all system actions';

-- --------------------------------------------------------

--
-- Table structure for table `auth_sessions`
--

CREATE TABLE `auth_sessions` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL COMMENT 'User reference',
  `token` varchar(500) NOT NULL COMMENT 'JWT token',
  `device_info` varchar(255) DEFAULT NULL COMMENT 'Device information',
  `ip_address` varchar(45) DEFAULT NULL COMMENT 'IP address',
  `user_agent` varchar(500) DEFAULT NULL COMMENT 'Browser user agent',
  `expires_at` timestamp NOT NULL COMMENT 'Token expiration',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Active authentication sessions';

-- --------------------------------------------------------

--
-- Table structure for table `documents`
--

CREATE TABLE `documents` (
  `id` char(36) NOT NULL,
  `org_id` char(36) NOT NULL COMMENT 'Organization reference',
  `route_id` char(36) NOT NULL COMMENT 'Route reference',
  `title` varchar(255) NOT NULL COMMENT 'Document title',
  `description` text DEFAULT NULL COMMENT 'Document description',
  `category` varchar(100) DEFAULT NULL COMMENT 'Document category',
  `priority` enum('LOW','NORMAL','HIGH','URGENT') NOT NULL DEFAULT 'NORMAL' COMMENT 'Priority level',
  `status` enum('CREATED','START','PICKED_UP','IN_TRANSIT','ARRIVED_AT_OFFICE','COMPLETED','RETURNED') NOT NULL DEFAULT 'CREATED' COMMENT 'Current status',
  `submitted_by` char(36) NOT NULL COMMENT 'Submitter (CLIENT)',
  `current_step_number` int(11) NOT NULL DEFAULT 1 COMMENT 'Current step in route',
  `current_office_id` char(36) DEFAULT NULL COMMENT 'Current office location',
  `target_completion_date` timestamp NULL DEFAULT NULL COMMENT 'Expected completion date',
  `file_url` varchar(500) DEFAULT NULL COMMENT 'Uploaded file URL/path',
  `file_size` int(11) DEFAULT NULL COMMENT 'File size in bytes',
  `file_type` varchar(50) DEFAULT NULL COMMENT 'MIME type',
  `pages` int(11) DEFAULT NULL COMMENT 'Number of pages',
  `submitted_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `completed_at` timestamp NULL DEFAULT NULL COMMENT 'Completion timestamp',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Documents being routed through the system';

-- --------------------------------------------------------

--
-- Table structure for table `document_tracking`
--

CREATE TABLE `document_tracking` (
  `id` char(36) NOT NULL,
  `document_id` char(36) NOT NULL COMMENT 'Document reference',
  `step_number` int(11) NOT NULL COMMENT 'Step number',
  `office_id` char(36) DEFAULT NULL COMMENT 'Office location (NULL = the organization itself, for step 0 of a CLIENT upload)',
  `status` enum('CREATED','START','PICKED_UP','IN_TRANSIT','ARRIVED_AT_OFFICE','COMPLETED','RETURNED') NOT NULL COMMENT 'Event status',
  `handler_id` char(36) DEFAULT NULL COMMENT 'Employee handling document',
  `liaison_id` char(36) DEFAULT NULL COMMENT 'Liaison handling delivery',
  `arrived_at` timestamp NULL DEFAULT NULL COMMENT 'Arrival time at office',
  `completed_at` timestamp NULL DEFAULT NULL COMMENT 'Completion time',
  `notes` text DEFAULT NULL COMMENT 'Event notes',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Document movement tracking history';

-- --------------------------------------------------------

--
-- Table structure for table `issues`
--

CREATE TABLE `issues` (
  `id` char(36) NOT NULL,
  `document_id` char(36) NOT NULL COMMENT 'Document reference',
  `title` varchar(255) NOT NULL COMMENT 'Issue title',
  `description` text DEFAULT NULL COMMENT 'Detailed description',
  `issue_type` varchar(100) DEFAULT NULL COMMENT 'Type of issue (lost, damaged, delayed)',
  `priority` enum('LOW','MEDIUM','HIGH','CRITICAL') NOT NULL DEFAULT 'MEDIUM' COMMENT 'Priority level',
  `status` enum('OPEN','IN_PROGRESS','RESOLVED','CLOSED') NOT NULL DEFAULT 'OPEN' COMMENT 'Issue status',
  `reported_by` char(36) NOT NULL COMMENT 'User who reported',
  `assigned_to` char(36) DEFAULT NULL COMMENT 'User assigned to resolve',
  `resolution_notes` text DEFAULT NULL COMMENT 'How issue was resolved',
  `reported_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `resolved_at` timestamp NULL DEFAULT NULL COMMENT 'Resolution time',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Document issues and problem tracking';

-- --------------------------------------------------------

--
-- Table structure for table `liaisons`
--

CREATE TABLE `liaisons` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL COMMENT 'User reference',
  `org_id` char(36) NOT NULL COMMENT 'Organization reference',
  `department` varchar(100) DEFAULT NULL COMMENT 'Department/Office assignment',
  `available` tinyint(1) NOT NULL DEFAULT 1 COMMENT 'Availability status',
  `deliveries_today` int(11) NOT NULL DEFAULT 0 COMMENT 'Deliveries completed today',
  `total_deliveries` int(11) NOT NULL DEFAULT 0 COMMENT 'Total deliveries count',
  `average_delivery_time` int(11) DEFAULT NULL COMMENT 'Average delivery time (minutes)',
  `success_rate` decimal(5,2) DEFAULT NULL COMMENT 'Success rate percentage',
  `last_delivery` timestamp NULL DEFAULT NULL COMMENT 'Last delivery time',
  `phone` varchar(20) DEFAULT NULL COMMENT 'Contact phone',
  `vehicle_type` varchar(50) DEFAULT NULL COMMENT 'Vehicle used',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Liaison/courier profiles and performance metrics';

-- --------------------------------------------------------

--
-- Stand-in structure for view `liaison_performance`
-- (See below for the actual view)
--
CREATE TABLE `liaison_performance` (
`id` char(36)
,`full_name` varchar(255)
,`email` varchar(255)
,`available` tinyint(1)
,`deliveries_today` int(11)
,`total_deliveries` int(11)
,`average_delivery_time` int(11)
,`success_rate` decimal(5,2)
,`last_delivery` timestamp
);

-- --------------------------------------------------------

--
-- Table structure for table `messages`
--

CREATE TABLE `messages` (
  `id` char(36) NOT NULL,
  `document_id` char(36) DEFAULT NULL COMMENT 'Related document (optional)',
  `sender_id` char(36) NOT NULL COMMENT 'Sender user ID',
  `recipient_id` char(36) DEFAULT NULL COMMENT 'Recipient for direct messages',
  `conversation_type` enum('DIRECT','GROUP','OFFICE','BROADCAST') NOT NULL DEFAULT 'DIRECT' COMMENT 'Message type',
  `content` text NOT NULL COMMENT 'Message content',
  `attachment_url` varchar(500) DEFAULT NULL COMMENT 'Attached file URL',
  `is_read` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'Read status',
  `read_at` timestamp NULL DEFAULT NULL COMMENT 'Read timestamp',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Direct and group messaging system';

-- --------------------------------------------------------

--
-- Table structure for table `notifications`
--

CREATE TABLE `notifications` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL COMMENT 'Recipient user ID',
  `document_id` char(36) DEFAULT NULL COMMENT 'Related document (optional)',
  `type` varchar(50) NOT NULL COMMENT 'Notification type',
  `title` varchar(255) DEFAULT NULL COMMENT 'Notification title',
  `message` text NOT NULL COMMENT 'Notification message',
  `is_read` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'Read status',
  `read_at` timestamp NULL DEFAULT NULL COMMENT 'Read timestamp',
  `action_url` varchar(500) DEFAULT NULL COMMENT 'Action link/URL',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='System notifications for all users';

-- --------------------------------------------------------

--
-- Table structure for table `offices`
--

CREATE TABLE `offices` (
  `id` char(36) NOT NULL,
  `org_id` char(36) NOT NULL COMMENT 'Organization reference',
  `name` varchar(255) NOT NULL COMMENT 'Office name',
  `code` varchar(50) NOT NULL COMMENT 'Unique office code (for QR)',
  `address` text DEFAULT NULL COMMENT 'Office address',
  `phone` varchar(20) DEFAULT NULL COMMENT 'Contact phone',
  `email` varchar(255) DEFAULT NULL COMMENT 'Contact email',
  `latitude` decimal(10,8) DEFAULT NULL COMMENT 'GPS latitude',
  `longitude` decimal(11,8) DEFAULT NULL COMMENT 'GPS longitude',
  `manager_id` char(36) DEFAULT NULL COMMENT 'Office manager user ID',
  `is_final_checkpoint` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'Is this the final approval checkpoint',
  `department` varchar(100) DEFAULT NULL COMMENT 'Department name',
  `status` enum('active','inactive') NOT NULL DEFAULT 'active' COMMENT 'Office status',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Office locations within organizations';

-- --------------------------------------------------------

--
-- Table structure for table `organizations`
--

CREATE TABLE `organizations` (
  `id` char(36) NOT NULL,
  `name` varchar(255) NOT NULL COMMENT 'Organization name',
  `description` text DEFAULT NULL COMMENT 'Organization details',
  `logo_url` varchar(500) DEFAULT NULL COMMENT 'Logo image URL',
  `website` varchar(500) DEFAULT NULL COMMENT 'Official website',
  `status` enum('active','inactive') NOT NULL DEFAULT 'active' COMMENT 'Organization status',
  `created_by` char(36) DEFAULT NULL COMMENT 'Creator user ID',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp() COMMENT 'Creation time',
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp() COMMENT 'Last update'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Organizations using FlowVision system';

-- --------------------------------------------------------

--
-- Table structure for table `organization_routes`
--

CREATE TABLE `organization_routes` (
  `id` char(36) NOT NULL,
  `org_id` char(36) NOT NULL COMMENT 'Organization reference',
  `name` varchar(255) NOT NULL COMMENT 'Route name',
  `description` text DEFAULT NULL COMMENT 'Route details',
  `is_active` tinyint(1) NOT NULL DEFAULT 1 COMMENT 'Is this the active route',
  `created_by` char(36) NOT NULL COMMENT 'Creator (CLIENT)',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Document routing paths for organizations';

-- --------------------------------------------------------

--
-- Stand-in structure for view `pending_approvals`
-- (See below for the actual view)
--
CREATE TABLE `pending_approvals` (
`id` char(36)
,`title` varchar(255)
,`priority` enum('LOW','NORMAL','HIGH','URGENT')
,`staff_id` char(36)
,`staff_name` varchar(255)
,`office_name` varchar(255)
,`pending_since` timestamp
);

-- --------------------------------------------------------

--
-- Table structure for table `qr_codes`
--

CREATE TABLE `qr_codes` (
  `id` char(36) NOT NULL,
  `document_id` char(36) NOT NULL COMMENT 'Document reference',
  `qr_code_data` varchar(500) NOT NULL COMMENT 'Routing code on the QR label: {OFFICE_CODE}-{8 digits}',
  `format` varchar(50) NOT NULL DEFAULT 'QR' COMMENT 'QR code format',
  `size` varchar(20) NOT NULL DEFAULT '25mm' COMMENT 'Standard size',
  `office_code` varchar(50) DEFAULT NULL COMMENT 'Organization-office code',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='One permanent QR routing code per document, issued on upload';

-- --------------------------------------------------------

--
-- Table structure for table `route_steps`
--

CREATE TABLE `route_steps` (
  `id` char(36) NOT NULL,
  `route_id` char(36) NOT NULL COMMENT 'Organization route reference',
  `step_number` int(11) NOT NULL COMMENT 'Step sequence number',
  `office_id` char(36) NOT NULL COMMENT 'Office at this step',
  `sla_days` int(11) DEFAULT NULL COMMENT 'Service level agreement days',
  `sla_hours` int(11) NOT NULL DEFAULT 0 COMMENT 'Service level agreement hours (added to sla_days)',
  `action_description` varchar(255) DEFAULT NULL COMMENT 'Action to perform at this step',
  `is_final_checkpoint` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'Is this the final approval step',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Sequential steps within organization routes';

-- --------------------------------------------------------

--
-- Table structure for table `users`
--

CREATE TABLE `users` (
  `id` char(36) NOT NULL,
  `org_id` char(36) NOT NULL COMMENT 'Organization reference',
  `email` varchar(255) NOT NULL COMMENT 'User email',
  `password_hash` varchar(255) NOT NULL COMMENT 'Hashed password',
  `first_name` varchar(100) DEFAULT NULL COMMENT 'First name',
  `last_name` varchar(100) DEFAULT NULL COMMENT 'Last name',
  `full_name` varchar(255) DEFAULT NULL COMMENT 'Full name',
  `account_type` enum('CLIENT','EMPLOYEE','STAFF','LIAISON') NOT NULL COMMENT 'User role type',
  `office_id` char(36) DEFAULT NULL COMMENT 'Assigned office',
  `avatar_url` varchar(500) DEFAULT NULL COMMENT 'Profile picture URL',
  `phone` varchar(20) DEFAULT NULL COMMENT 'Contact phone',
  `position` varchar(100) DEFAULT NULL COMMENT 'Job position',
  `department` varchar(100) DEFAULT NULL COMMENT 'Department',
  `status` enum('active','inactive','pending') NOT NULL DEFAULT 'pending' COMMENT 'Account status',
  `last_login` timestamp NULL DEFAULT NULL COMMENT 'Last login time',
  `email_verified` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'Email verification status',
  `two_factor_enabled` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'Two-factor authentication',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='User accounts with role-based access';

--
-- Indexes for dumped tables
--

--
-- Indexes for table `approvals`
--
ALTER TABLE `approvals`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_approvals_doc_staff_office` (`document_id`,`staff_id`,`office_id`),
  ADD KEY `idx_approvals_pending` (`status`,`created_at`),
  ADD KEY `idx_approvals_staff_id` (`staff_id`),
  ADD KEY `idx_approvals_office_id` (`office_id`);

--
-- Indexes for table `audit_logs`
--
ALTER TABLE `audit_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_audit_logs_user_id` (`user_id`),
  ADD KEY `idx_audit_logs_created_at` (`created_at`),
  ADD KEY `idx_audit_logs_entity` (`entity_type`,`entity_id`),
  ADD KEY `idx_audit_logs_action` (`action`);

--
-- Indexes for table `auth_sessions`
--
ALTER TABLE `auth_sessions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_auth_sessions_user_id` (`user_id`),
  ADD KEY `idx_auth_sessions_expires_at` (`expires_at`);

--
-- Indexes for table `documents`
--
ALTER TABLE `documents`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_documents_search` (`org_id`,`status`,`created_at`),
  ADD KEY `idx_documents_route_id` (`route_id`),
  ADD KEY `idx_documents_submitted_by` (`submitted_by`),
  ADD KEY `idx_documents_current_office` (`current_office_id`),
  ADD KEY `idx_documents_created_at` (`created_at`);

--
-- Indexes for table `document_tracking`
--
ALTER TABLE `document_tracking`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_document_tracking_timeline` (`document_id`,`created_at`),
  ADD KEY `idx_document_tracking_office_id` (`office_id`),
  ADD KEY `idx_document_tracking_status` (`status`),
  ADD KEY `idx_document_tracking_handler_id` (`handler_id`),
  ADD KEY `idx_document_tracking_liaison_id` (`liaison_id`);

--
-- Indexes for table `issues`
--
ALTER TABLE `issues`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_issues_document_id` (`document_id`),
  ADD KEY `idx_issues_status` (`status`),
  ADD KEY `idx_issues_priority` (`priority`),
  ADD KEY `idx_issues_reported_by` (`reported_by`),
  ADD KEY `idx_issues_assigned_to` (`assigned_to`);

--
-- Indexes for table `liaisons`
--
ALTER TABLE `liaisons`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_liaisons_user_id` (`user_id`),
  ADD KEY `idx_liaisons_org_id` (`org_id`),
  ADD KEY `idx_liaisons_available` (`available`);

--
-- Indexes for table `messages`
--
ALTER TABLE `messages`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_messages_timeline` (`sender_id`,`recipient_id`,`created_at`),
  ADD KEY `idx_messages_document_id` (`document_id`),
  ADD KEY `idx_messages_recipient_id` (`recipient_id`),
  ADD KEY `idx_messages_is_read` (`is_read`);

--
-- Indexes for table `notifications`
--
ALTER TABLE `notifications`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_notifications_user_unread` (`user_id`,`is_read`,`created_at`),
  ADD KEY `idx_notifications_document_id` (`document_id`);

--
-- Indexes for table `offices`
--
ALTER TABLE `offices`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_offices_code` (`code`),
  ADD KEY `idx_offices_org_id` (`org_id`),
  ADD KEY `idx_offices_status` (`status`),
  ADD KEY `fk_offices_manager` (`manager_id`);

--
-- Indexes for table `organizations`
--
ALTER TABLE `organizations`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_organizations_status` (`status`),
  ADD KEY `idx_organizations_created_at` (`created_at`);

--
-- Indexes for table `organization_routes`
--
ALTER TABLE `organization_routes`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_organization_routes_org_id` (`org_id`),
  ADD KEY `idx_organization_routes_is_active` (`is_active`),
  ADD KEY `idx_organization_routes_created_by` (`created_by`);

--
-- Indexes for table `qr_codes`
--
ALTER TABLE `qr_codes`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_qr_codes_document` (`document_id`),
  ADD UNIQUE KEY `uq_qr_codes_data` (`qr_code_data`);

--
-- Indexes for table `route_steps`
--
ALTER TABLE `route_steps`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_route_step` (`route_id`,`step_number`),
  ADD KEY `idx_route_steps_office_id` (`office_id`);

--
-- Indexes for table `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_users_email` (`email`),
  ADD KEY `idx_users_org_office` (`org_id`,`office_id`,`account_type`),
  ADD KEY `idx_users_status` (`status`),
  ADD KEY `fk_users_office` (`office_id`);

-- --------------------------------------------------------

--
-- Structure for view `active_documents_by_office`
--
DROP TABLE IF EXISTS `active_documents_by_office`;

CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `active_documents_by_office`  AS SELECT `d`.`id` AS `id`, `d`.`title` AS `title`, `d`.`priority` AS `priority`, `d`.`status` AS `status`, `d`.`current_office_id` AS `current_office_id`, `o`.`name` AS `office_name`, `u`.`full_name` AS `submitted_by`, `d`.`created_at` AS `created_at` FROM ((`documents` `d` left join `offices` `o` on(`d`.`current_office_id` = `o`.`id`)) left join `users` `u` on(`d`.`submitted_by` = `u`.`id`)) WHERE `d`.`status` in ('START','PICKED_UP','IN_TRANSIT','ARRIVED_AT_OFFICE') ;

-- --------------------------------------------------------

--
-- Structure for view `liaison_performance`
--
DROP TABLE IF EXISTS `liaison_performance`;

CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `liaison_performance`  AS SELECT `l`.`id` AS `id`, `u`.`full_name` AS `full_name`, `u`.`email` AS `email`, `l`.`available` AS `available`, `l`.`deliveries_today` AS `deliveries_today`, `l`.`total_deliveries` AS `total_deliveries`, `l`.`average_delivery_time` AS `average_delivery_time`, `l`.`success_rate` AS `success_rate`, `l`.`last_delivery` AS `last_delivery` FROM (`liaisons` `l` left join `users` `u` on(`l`.`user_id` = `u`.`id`)) ;

-- --------------------------------------------------------

--
-- Structure for view `pending_approvals`
--
DROP TABLE IF EXISTS `pending_approvals`;

CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `pending_approvals`  AS SELECT `d`.`id` AS `id`, `d`.`title` AS `title`, `d`.`priority` AS `priority`, `a`.`staff_id` AS `staff_id`, `u`.`full_name` AS `staff_name`, `o`.`name` AS `office_name`, `a`.`created_at` AS `pending_since` FROM (((`documents` `d` join `approvals` `a` on(`d`.`id` = `a`.`document_id`)) join `users` `u` on(`a`.`staff_id` = `u`.`id`)) join `offices` `o` on(`a`.`office_id` = `o`.`id`)) WHERE `a`.`status` = 'PENDING' ;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `approvals`
--
ALTER TABLE `approvals`
  ADD CONSTRAINT `fk_approvals_document` FOREIGN KEY (`document_id`) REFERENCES `documents` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_approvals_office` FOREIGN KEY (`office_id`) REFERENCES `offices` (`id`),
  ADD CONSTRAINT `fk_approvals_staff` FOREIGN KEY (`staff_id`) REFERENCES `users` (`id`);

--
-- Constraints for table `audit_logs`
--
ALTER TABLE `audit_logs`
  ADD CONSTRAINT `fk_audit_logs_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `auth_sessions`
--
ALTER TABLE `auth_sessions`
  ADD CONSTRAINT `fk_sessions_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `documents`
--
ALTER TABLE `documents`
  ADD CONSTRAINT `fk_documents_office` FOREIGN KEY (`current_office_id`) REFERENCES `offices` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_documents_organization` FOREIGN KEY (`org_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_documents_route` FOREIGN KEY (`route_id`) REFERENCES `organization_routes` (`id`),
  ADD CONSTRAINT `fk_documents_submitted_by` FOREIGN KEY (`submitted_by`) REFERENCES `users` (`id`);

--
-- Constraints for table `document_tracking`
--
ALTER TABLE `document_tracking`
  ADD CONSTRAINT `fk_tracking_document` FOREIGN KEY (`document_id`) REFERENCES `documents` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_tracking_handler` FOREIGN KEY (`handler_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_tracking_liaison` FOREIGN KEY (`liaison_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_tracking_office` FOREIGN KEY (`office_id`) REFERENCES `offices` (`id`);

--
-- Constraints for table `issues`
--
ALTER TABLE `issues`
  ADD CONSTRAINT `fk_issues_assigned_to` FOREIGN KEY (`assigned_to`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_issues_document` FOREIGN KEY (`document_id`) REFERENCES `documents` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_issues_reported_by` FOREIGN KEY (`reported_by`) REFERENCES `users` (`id`);

--
-- Constraints for table `liaisons`
--
ALTER TABLE `liaisons`
  ADD CONSTRAINT `fk_liaisons_organization` FOREIGN KEY (`org_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_liaisons_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `messages`
--
ALTER TABLE `messages`
  ADD CONSTRAINT `fk_messages_document` FOREIGN KEY (`document_id`) REFERENCES `documents` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_messages_recipient` FOREIGN KEY (`recipient_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_messages_sender` FOREIGN KEY (`sender_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `notifications`
--
ALTER TABLE `notifications`
  ADD CONSTRAINT `fk_notifications_document` FOREIGN KEY (`document_id`) REFERENCES `documents` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_notifications_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `offices`
--
ALTER TABLE `offices`
  ADD CONSTRAINT `fk_offices_manager` FOREIGN KEY (`manager_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_offices_organization` FOREIGN KEY (`org_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `organization_routes`
--
ALTER TABLE `organization_routes`
  ADD CONSTRAINT `fk_routes_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  ADD CONSTRAINT `fk_routes_organization` FOREIGN KEY (`org_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `qr_codes`
--
ALTER TABLE `qr_codes`
  ADD CONSTRAINT `fk_qr_codes_document` FOREIGN KEY (`document_id`) REFERENCES `documents` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `route_steps`
--
ALTER TABLE `route_steps`
  ADD CONSTRAINT `fk_route_steps_office` FOREIGN KEY (`office_id`) REFERENCES `offices` (`id`),
  ADD CONSTRAINT `fk_route_steps_route` FOREIGN KEY (`route_id`) REFERENCES `organization_routes` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `users`
--
ALTER TABLE `users`
  ADD CONSTRAINT `fk_users_office` FOREIGN KEY (`office_id`) REFERENCES `offices` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_users_organization` FOREIGN KEY (`org_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE;

-- --------------------------------------------------------

--
-- Table structure for table `document_types` (Organization Settings)
--

CREATE TABLE `document_types` (
  `id` char(36) NOT NULL,
  `org_id` char(36) NOT NULL COMMENT 'Organization reference',
  `name` varchar(100) NOT NULL COMMENT 'Shown in the upload form, e.g. Purchase Request',
  `description` varchar(500) DEFAULT NULL COMMENT 'What this type covers (also given to the AI)',
  `processing_days` int(11) NOT NULL DEFAULT 0 COMMENT 'How long a document of this type may take: days',
  `processing_hours` int(11) NOT NULL DEFAULT 0 COMMENT '… plus hours (0–23); 0 + 0 = no deadline',
  `is_active` tinyint(1) NOT NULL DEFAULT 1 COMMENT 'Offered when uploading',
  `sort_order` int(11) NOT NULL DEFAULT 0 COMMENT 'Position in the list',
  `created_by` char(36) DEFAULT NULL COMMENT 'CLIENT who added it',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_document_types_org_name` (`org_id`,`name`),
  CONSTRAINT `fk_document_types_org` FOREIGN KEY (`org_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_document_types_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Document types an organization offers when uploading';

-- --------------------------------------------------------

--
-- Table structure for table `document_files` (several files under one document and one QR)
--

CREATE TABLE `document_files` (
  `id` char(36) NOT NULL,
  `document_id` char(36) NOT NULL COMMENT 'Document reference',
  `file_url` varchar(500) NOT NULL COMMENT '"<uuid>/<original name>" under UPLOAD_DIR',
  `file_name` varchar(255) NOT NULL COMMENT 'Original file name',
  `file_type` varchar(100) DEFAULT NULL COMMENT 'MIME type (or extension)',
  `file_size` int(11) NOT NULL DEFAULT 0 COMMENT 'Bytes',
  `sort_order` int(11) NOT NULL DEFAULT 0 COMMENT 'Order within the document',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_document_files_document` (`document_id`,`sort_order`),
  CONSTRAINT `fk_document_files_document` FOREIGN KEY (`document_id`) REFERENCES `documents` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Every file attached to a document (documents.file_url is the first one)';

-- --------------------------------------------------------

--
-- Table structure for table `file_blobs` (uploaded file bytes when FILE_STORAGE=db, e.g. on Vercel)
--

CREATE TABLE `file_blobs` (
  `file_url` varchar(255) NOT NULL COMMENT 'Same key as documents / document_files / knowledge_files .file_url',
  `part` int(11) NOT NULL DEFAULT 0 COMMENT 'Files are kept in parts of a few MB, read and written one at a time',
  `data` mediumblob NOT NULL COMMENT 'This part of the file',
  `size` int(11) NOT NULL DEFAULT 0 COMMENT 'Bytes in this part',
  `uploaded_by` char(36) DEFAULT NULL COMMENT 'Who is uploading it (for a large upload sent in parts)',
  `complete` tinyint(1) NOT NULL DEFAULT 1 COMMENT '0 = a large upload still arriving in parts, not attached to anything yet',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`file_url`,`part`),
  KEY `idx_file_blobs_staged` (`complete`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Uploaded files, stored in the database where the server disk is read-only';

-- --------------------------------------------------------

--
-- Table structure for table `knowledge_files` (Organization Settings)
--

CREATE TABLE `knowledge_files` (
  `id` char(36) NOT NULL,
  `org_id` char(36) NOT NULL COMMENT 'Organization reference',
  `title` varchar(255) NOT NULL COMMENT 'Name shown in settings',
  `description` text DEFAULT NULL COMMENT 'What the file is about',
  `file_url` varchar(500) NOT NULL COMMENT '"knowledge/<uuid>/<original name>" under UPLOAD_DIR',
  `file_name` varchar(255) NOT NULL COMMENT 'Original file name',
  `file_type` varchar(100) DEFAULT NULL COMMENT 'MIME type',
  `file_size` bigint(20) NOT NULL COMMENT 'Bytes',
  `content` longtext DEFAULT NULL COMMENT 'Text extracted from the file, used as AI knowledge',
  `char_count` int(11) NOT NULL DEFAULT 0 COMMENT 'Length of content',
  `status` enum('READY','NO_TEXT','FAILED') NOT NULL DEFAULT 'READY' COMMENT 'Whether text could be extracted',
  `error` varchar(500) DEFAULT NULL COMMENT 'Why extraction failed',
  `is_active` tinyint(1) NOT NULL DEFAULT 1 COMMENT 'Used by the AI',
  `uploaded_by` char(36) DEFAULT NULL COMMENT 'CLIENT who uploaded it',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_knowledge_files_org` (`org_id`,`is_active`),
  CONSTRAINT `fk_knowledge_files_org` FOREIGN KEY (`org_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_knowledge_files_uploader` FOREIGN KEY (`uploaded_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Files whose text the AI uses as organization knowledge';

-- --------------------------------------------------------

--
-- Table structure for table `ai_conversations` (AI Assistant chat history)
--

CREATE TABLE `ai_conversations` (
  `id` char(36) NOT NULL,
  `org_id` char(36) NOT NULL COMMENT 'Organization reference',
  `user_id` char(36) NOT NULL COMMENT 'Owner: only this user can read the conversation',
  `title` varchar(255) NOT NULL COMMENT 'From the first question',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_ai_conversations_user` (`user_id`,`updated_at`),
  CONSTRAINT `fk_ai_conversations_org` FOREIGN KEY (`org_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ai_conversations_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI Assistant conversations, one per chat thread';

-- --------------------------------------------------------

--
-- Table structure for table `ai_messages` (AI Assistant chat history)
--

CREATE TABLE `ai_messages` (
  `id` char(36) NOT NULL,
  `conversation_id` char(36) NOT NULL COMMENT 'Conversation reference',
  `role` enum('user','assistant') NOT NULL COMMENT 'Who wrote it',
  `content` mediumtext NOT NULL COMMENT 'Markdown; assistant answers may contain <canvas> blocks',
  `model` varchar(100) DEFAULT NULL COMMENT 'AI model that wrote an answer',
  `tools` text DEFAULT NULL COMMENT 'JSON list of lookups the assistant ran for this answer',
  `is_error` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'Assistant error notice (left out of the AI history)',
  `failed` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'Question that got no answer (left out of the AI history)',
  `created_at` timestamp(3) NOT NULL DEFAULT current_timestamp(3) COMMENT 'Millisecond precision keeps the order of a thread',
  PRIMARY KEY (`id`),
  KEY `idx_ai_messages_conversation` (`conversation_id`,`created_at`),
  CONSTRAINT `fk_ai_messages_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `ai_conversations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Messages of AI Assistant conversations';
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
