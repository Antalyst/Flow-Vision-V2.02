import { DataTypes, type Model, type ModelAttributes, type ModelOptions, type ModelStatic } from 'sequelize'
import { sequelize } from './db.ts'

// Models mirror database/flowvision-complete-schema.sql (the project's MariaDB/MySQL
// schema) column for column. sync() is never called — the SQL file is the source of
// truth. Rows are typed loosely (any column is readable); API responses are shaped
// by serializers.ts, not by these models.
export type Row = Model & Record<string, any>
type Table = ModelStatic<Row>

const define = (name: string, attributes: ModelAttributes<Row>, options?: ModelOptions<Row>): Table =>
  sequelize.define<Row>(name, attributes, options)

const uuidPk = { type: DataTypes.CHAR(36), primaryKey: true, defaultValue: DataTypes.UUIDV4 }
const createdOnly = { updatedAt: false } as const

export const ACCOUNT_TYPES = ['CLIENT', 'EMPLOYEE', 'STAFF', 'LIAISON'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]
export const DOCUMENT_STATUSES = ['CREATED', 'START', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED_AT_OFFICE', 'COMPLETED', 'RETURNED'] as const
export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const
export type Priority = (typeof PRIORITIES)[number]
export const ISSUE_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
export const ISSUE_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const
// issues.issue_type is free text; these are the values the app offers.
export const ISSUE_TYPES = ['MISSING_DOCUMENT', 'DELAY', 'DAMAGE', 'INCORRECT_ROUTING', 'SYSTEM', 'OTHER'] as const

export const Organization = define('organizations', {
  id: uuidPk,
  name: { type: DataTypes.STRING(255), allowNull: false },
  description: DataTypes.TEXT,
  logo_url: DataTypes.STRING(500),
  website: DataTypes.STRING(500),
  status: { type: DataTypes.ENUM('active', 'inactive'), allowNull: false, defaultValue: 'active' },
  created_by: DataTypes.CHAR(36),
})

export const Office = define('offices', {
  id: uuidPk,
  org_id: { type: DataTypes.CHAR(36), allowNull: false },
  name: { type: DataTypes.STRING(255), allowNull: false },
  // Globally unique and printed on QR labels: {ORGCODE}-{DEPT}-{OFFICE}, e.g. BAG-HR-HRMSO
  code: { type: DataTypes.STRING(50), allowNull: false, unique: true },
  address: DataTypes.TEXT,
  phone: DataTypes.STRING(20),
  email: DataTypes.STRING(255),
  latitude: DataTypes.DECIMAL(10, 8),
  longitude: DataTypes.DECIMAL(11, 8),
  manager_id: DataTypes.CHAR(36),
  is_final_checkpoint: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  department: DataTypes.STRING(100),
  status: { type: DataTypes.ENUM('active', 'inactive'), allowNull: false, defaultValue: 'active' },
})

export const User = define(
  'users',
  {
    id: uuidPk,
    org_id: { type: DataTypes.CHAR(36), allowNull: false },
    email: { type: DataTypes.STRING(255), allowNull: false, unique: true },
    password_hash: { type: DataTypes.STRING(255), allowNull: false },
    first_name: DataTypes.STRING(100),
    last_name: DataTypes.STRING(100),
    full_name: DataTypes.STRING(255),
    account_type: { type: DataTypes.ENUM(...ACCOUNT_TYPES), allowNull: false },
    office_id: DataTypes.CHAR(36),
    avatar_url: DataTypes.STRING(500),
    phone: DataTypes.STRING(20),
    position: DataTypes.STRING(100),
    department: DataTypes.STRING(100),
    // active · inactive (suspended) · pending (signed in with a temporary password)
    status: { type: DataTypes.ENUM('active', 'inactive', 'pending'), allowNull: false, defaultValue: 'pending' },
    last_login: DataTypes.DATE,
    email_verified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    two_factor_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // JSON list of the pages the account may open, set by whoever manages it. NULL = every page of its role.
    page_access: DataTypes.TEXT,
  },
  {
    defaultScope: { attributes: { exclude: ['password_hash'] } },
    scopes: { withPassword: { attributes: { include: ['password_hash'] } } },
  },
)
// create() and scoped queries still carry the hash in memory — never let it serialise.
User.prototype.toJSON = function toJSON(this: Row) {
  const values = this.get({ plain: true })
  delete values.password_hash
  return values
}

export const OrganizationRoute = define('organization_routes', {
  id: uuidPk,
  org_id: { type: DataTypes.CHAR(36), allowNull: false },
  name: { type: DataTypes.STRING(255), allowNull: false },
  description: DataTypes.TEXT,
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  created_by: { type: DataTypes.CHAR(36), allowNull: false },
})

export const RouteStep = define(
  'route_steps',
  {
    id: uuidPk,
    route_id: { type: DataTypes.CHAR(36), allowNull: false },
    step_number: { type: DataTypes.INTEGER, allowNull: false },
    office_id: { type: DataTypes.CHAR(36), allowNull: false },
    sla_days: DataTypes.INTEGER,
    // Added to sla_days: a step takes sla_days * 24 + sla_hours hours.
    sla_hours: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    action_description: DataTypes.STRING(255),
    is_final_checkpoint: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  createdOnly,
)

export const Document = define('documents', {
  id: uuidPk,
  org_id: { type: DataTypes.CHAR(36), allowNull: false },
  route_id: { type: DataTypes.CHAR(36), allowNull: false },
  title: { type: DataTypes.STRING(255), allowNull: false },
  description: DataTypes.TEXT,
  category: DataTypes.STRING(100),
  priority: { type: DataTypes.ENUM(...PRIORITIES), allowNull: false, defaultValue: 'NORMAL' },
  status: { type: DataTypes.ENUM(...DOCUMENT_STATUSES), allowNull: false, defaultValue: 'CREATED' },
  submitted_by: { type: DataTypes.CHAR(36), allowNull: false },
  current_step_number: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  current_office_id: DataTypes.CHAR(36),
  target_completion_date: DataTypes.DATE,
  // "<uuid>/<original file name>" under UPLOAD_DIR — the folder keeps the original name
  file_url: DataTypes.STRING(500),
  file_size: DataTypes.INTEGER,
  file_type: DataTypes.STRING(50),
  // How many pages/sheets the document has: the number of files, or (photos only) as entered.
  pages: DataTypes.INTEGER,
  submitted_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  completed_at: DataTypes.DATE,
})

/**
 * One row per office visit (step 0 = the origin, before the first office on the route).
 * arrived_at = when the document reached the office,
 * handler_id = who confirmed receipt, liaison_id = who carries it out (requested or
 * actual), completed_at = when it left (or was decided). `notes` holds the visit's
 * event log as a JSON array — see tracking-log.ts.
 */
export const DocumentTracking = define('document_tracking', {
  id: uuidPk,
  document_id: { type: DataTypes.CHAR(36), allowNull: false },
  step_number: { type: DataTypes.INTEGER, allowNull: false },
  // Step 0 is the document's origin; NULL there means the organization itself (a CLIENT upload).
  office_id: DataTypes.CHAR(36),
  status: { type: DataTypes.ENUM(...DOCUMENT_STATUSES), allowNull: false },
  handler_id: DataTypes.CHAR(36),
  liaison_id: DataTypes.CHAR(36),
  arrived_at: DataTypes.DATE,
  completed_at: DataTypes.DATE,
  notes: DataTypes.TEXT,
})

/** One row per (document, staff, office). PENDING rows feed the pending_approvals view. */
export const Approval = define('approvals', {
  id: uuidPk,
  document_id: { type: DataTypes.CHAR(36), allowNull: false },
  staff_id: { type: DataTypes.CHAR(36), allowNull: false },
  office_id: { type: DataTypes.CHAR(36), allowNull: false },
  step_number: { type: DataTypes.INTEGER, allowNull: false },
  status: { type: DataTypes.ENUM('PENDING', 'APPROVED', 'RETURNED'), allowNull: false, defaultValue: 'PENDING' },
  remarks: DataTypes.TEXT,
  approved_at: DataTypes.DATE,
})

export const Liaison = define('liaisons', {
  id: uuidPk,
  user_id: { type: DataTypes.CHAR(36), allowNull: false, unique: true },
  org_id: { type: DataTypes.CHAR(36), allowNull: false },
  department: DataTypes.STRING(100),
  available: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  deliveries_today: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  total_deliveries: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  average_delivery_time: DataTypes.INTEGER,
  success_rate: DataTypes.DECIMAL(5, 2),
  last_delivery: DataTypes.DATE,
  phone: DataTypes.STRING(20),
  vehicle_type: DataTypes.STRING(50),
})

/** One row per document: its permanent routing code ({OFFICE_CODE}{MMDDYY}{6 digits}, older ones {OFFICE_CODE}-{8 digits}), issued on upload and scanned at every hand-off. */
export const QrCode = define(
  'qr_codes',
  {
    id: uuidPk,
    document_id: { type: DataTypes.CHAR(36), allowNull: false, unique: true },
    qr_code_data: { type: DataTypes.STRING(500), allowNull: false, unique: true },
    format: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'QR' },
    size: { type: DataTypes.STRING(20), allowNull: false, defaultValue: '25mm' },
    office_code: DataTypes.STRING(50),
  },
  createdOnly,
)

export const Issue = define('issues', {
  id: uuidPk,
  document_id: { type: DataTypes.CHAR(36), allowNull: false },
  title: { type: DataTypes.STRING(255), allowNull: false },
  description: DataTypes.TEXT,
  issue_type: DataTypes.STRING(100),
  priority: { type: DataTypes.ENUM(...ISSUE_PRIORITIES), allowNull: false, defaultValue: 'MEDIUM' },
  status: { type: DataTypes.ENUM(...ISSUE_STATUSES), allowNull: false, defaultValue: 'OPEN' },
  reported_by: { type: DataTypes.CHAR(36), allowNull: false },
  assigned_to: DataTypes.CHAR(36),
  resolution_notes: DataTypes.TEXT,
  reported_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  resolved_at: DataTypes.DATE,
})

/** DIRECT (recipient_id) · GROUP (a document's thread, document_id) · OFFICE (sender's office). */
export const Message = define('messages', {
  id: uuidPk,
  document_id: DataTypes.CHAR(36),
  sender_id: { type: DataTypes.CHAR(36), allowNull: false },
  recipient_id: DataTypes.CHAR(36),
  conversation_type: { type: DataTypes.ENUM('DIRECT', 'GROUP', 'OFFICE', 'BROADCAST'), allowNull: false, defaultValue: 'DIRECT' },
  content: { type: DataTypes.TEXT, allowNull: false },
  attachment_url: DataTypes.STRING(500),
  is_read: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  read_at: DataTypes.DATE,
})

export const Notification = define(
  'notifications',
  {
    id: uuidPk,
    user_id: { type: DataTypes.CHAR(36), allowNull: false },
    document_id: DataTypes.CHAR(36),
    type: { type: DataTypes.STRING(50), allowNull: false },
    title: DataTypes.STRING(255),
    message: { type: DataTypes.TEXT, allowNull: false },
    is_read: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    read_at: DataTypes.DATE,
    action_url: DataTypes.STRING(500),
  },
  createdOnly,
)

/** Cookie sessions. `token` holds the SHA-256 of the cookie value, never the raw token. */
export const AuthSession = define(
  'auth_sessions',
  {
    id: uuidPk,
    user_id: { type: DataTypes.CHAR(36), allowNull: false },
    token: { type: DataTypes.STRING(500), allowNull: false },
    device_info: DataTypes.STRING(255),
    ip_address: DataTypes.STRING(45),
    user_agent: DataTypes.STRING(500),
    expires_at: { type: DataTypes.DATE, allowNull: false },
  },
  createdOnly,
)

export const AuditLog = define(
  'audit_logs',
  {
    id: uuidPk,
    user_id: DataTypes.CHAR(36),
    action: { type: DataTypes.STRING(100), allowNull: false },
    entity_type: { type: DataTypes.STRING(50), allowNull: false },
    entity_id: { type: DataTypes.CHAR(36), allowNull: false },
    old_values: DataTypes.JSON,
    new_values: DataTypes.JSON,
    ip_address: DataTypes.STRING(45),
  },
  createdOnly,
)

/** Every file attached to a document, in order (documents.file_url is the first one). One QR covers them all. */
export const DocumentFile = define(
  'document_files',
  {
    id: uuidPk,
    document_id: { type: DataTypes.CHAR(36), allowNull: false },
    file_url: { type: DataTypes.STRING(500), allowNull: false },
    file_name: { type: DataTypes.STRING(255), allowNull: false },
    file_type: DataTypes.STRING(100),
    file_size: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  createdOnly,
)

/** Organization Settings: the document types offered when uploading (and given to the AI). */
export const DocumentType = define('document_types', {
  id: uuidPk,
  org_id: { type: DataTypes.CHAR(36), allowNull: false },
  name: { type: DataTypes.STRING(100), allowNull: false },
  description: DataTypes.STRING(500),
  // How long a document of this type may take, from submission: days + hours. 0 + 0 = no deadline.
  processing_days: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  processing_hours: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  created_by: DataTypes.CHAR(36),
})

export const KNOWLEDGE_STATUSES = ['READY', 'NO_TEXT', 'FAILED'] as const

/** Organization Settings: uploaded files whose extracted text is the AI's organization knowledge. */
export const KnowledgeFile = define('knowledge_files', {
  id: uuidPk,
  org_id: { type: DataTypes.CHAR(36), allowNull: false },
  title: { type: DataTypes.STRING(255), allowNull: false },
  description: DataTypes.TEXT,
  // "knowledge/<uuid>/<original name>" under UPLOAD_DIR
  file_url: { type: DataTypes.STRING(500), allowNull: false },
  file_name: { type: DataTypes.STRING(255), allowNull: false },
  file_type: DataTypes.STRING(100),
  file_size: { type: DataTypes.BIGINT, allowNull: false },
  content: DataTypes.TEXT('long'),
  char_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  status: { type: DataTypes.ENUM(...KNOWLEDGE_STATUSES), allowNull: false, defaultValue: 'READY' },
  error: DataTypes.STRING(500),
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  uploaded_by: DataTypes.CHAR(36),
})

/** AI Assistant: one chat thread, private to the user who started it. */
export const AiConversation = define('ai_conversations', {
  id: uuidPk,
  org_id: { type: DataTypes.CHAR(36), allowNull: false },
  user_id: { type: DataTypes.CHAR(36), allowNull: false },
  title: { type: DataTypes.STRING(255), allowNull: false },
})

/** AI Assistant: one question or answer. `tools` is a JSON list of the lookups behind an answer. */
export const AiMessage = define(
  'ai_messages',
  {
    id: uuidPk,
    conversation_id: { type: DataTypes.CHAR(36), allowNull: false },
    role: { type: DataTypes.ENUM('user', 'assistant'), allowNull: false },
    content: { type: DataTypes.TEXT('medium'), allowNull: false },
    model: DataTypes.STRING(100),
    tools: DataTypes.TEXT,
    is_error: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    failed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // Set explicitly (millisecond precision) so a question always sorts before its answer.
    created_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  },
  { timestamps: false },
)

// ---------------------------------------------------------------------------
// Associations
// ---------------------------------------------------------------------------
Organization.hasMany(Office, { foreignKey: 'org_id', as: 'offices' })
Office.belongsTo(Organization, { foreignKey: 'org_id', as: 'organization' })
User.belongsTo(Organization, { foreignKey: 'org_id', as: 'organization' })

Office.hasMany(User, { foreignKey: 'office_id', as: 'members' })
User.belongsTo(Office, { foreignKey: 'office_id', as: 'office' })

OrganizationRoute.hasMany(RouteStep, { foreignKey: 'route_id', as: 'steps' })
RouteStep.belongsTo(OrganizationRoute, { foreignKey: 'route_id', as: 'route' })
RouteStep.belongsTo(Office, { foreignKey: 'office_id', as: 'office' })

Document.belongsTo(OrganizationRoute, { foreignKey: 'route_id', as: 'route' })
Document.belongsTo(Office, { foreignKey: 'current_office_id', as: 'currentOffice' })
Document.belongsTo(User, { foreignKey: 'submitted_by', as: 'submitter' })
Document.hasMany(DocumentTracking, { foreignKey: 'document_id', as: 'visits' })
Document.hasOne(QrCode, { foreignKey: 'document_id', as: 'qr' })
Document.hasMany(DocumentFile, { foreignKey: 'document_id', as: 'files' })

DocumentTracking.belongsTo(Document, { foreignKey: 'document_id', as: 'document' })
DocumentTracking.belongsTo(Office, { foreignKey: 'office_id', as: 'office' })
DocumentTracking.belongsTo(User, { foreignKey: 'handler_id', as: 'handler' })
DocumentTracking.belongsTo(User, { foreignKey: 'liaison_id', as: 'liaison' })

Approval.belongsTo(Document, { foreignKey: 'document_id', as: 'document' })
Approval.belongsTo(Office, { foreignKey: 'office_id', as: 'office' })
Approval.belongsTo(User, { foreignKey: 'staff_id', as: 'staff' })

User.hasOne(Liaison, { foreignKey: 'user_id', as: 'liaisonProfile' })
Liaison.belongsTo(User, { foreignKey: 'user_id', as: 'user' })

Issue.belongsTo(Document, { foreignKey: 'document_id', as: 'document' })
Issue.belongsTo(User, { foreignKey: 'reported_by', as: 'reporter' })
Issue.belongsTo(User, { foreignKey: 'assigned_to', as: 'assignee' })

Message.belongsTo(User, { foreignKey: 'sender_id', as: 'sender' })
Message.belongsTo(User, { foreignKey: 'recipient_id', as: 'recipient' })

KnowledgeFile.belongsTo(User, { foreignKey: 'uploaded_by', as: 'uploader' })

AiConversation.hasMany(AiMessage, { foreignKey: 'conversation_id', as: 'messages' })
AiMessage.belongsTo(AiConversation, { foreignKey: 'conversation_id', as: 'conversation' })

export { sequelize }
