export type AccountType = 'CLIENT' | 'EMPLOYEE' | 'STAFF' | 'LIAISON'
export type DocumentStatus =
  | 'CREATED'
  | 'START'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'ARRIVED_AT_OFFICE'
  | 'COMPLETED'
  | 'RETURNED'
export type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'

export interface Office {
  id: string
  code: string
  name: string
  department_code: string
  department_name: string
  location?: string | null
  is_final_checkpoint: boolean
  is_active?: boolean
  member_count?: number
}

export interface UserSummary {
  id: string
  first_name: string
  last_name: string
  account_type: AccountType
  office?: Pick<Office, 'id' | 'name'> | Office | null
}

export interface LiaisonProfile {
  id: string
  user_id: string
  department_code: string
  /** BUSY = a document was released to them or is in their hands (derived). Only AVAILABLE messengers can be given a document. */
  availability: 'AVAILABLE' | 'BUSY' | 'OFF_DUTY'
  active_jobs?: number
  deliveries_today?: number
  total_deliveries: number
  successful_deliveries: number
  failed_deliveries: number
  success_rate: number
  avg_delivery_minutes: number | null
  last_active_at: string | null
}

export interface CurrentUser {
  id: string
  email: string
  first_name: string
  last_name: string
  phone: string | null
  account_type: AccountType
  status: string
  must_change_password: boolean
  organization: { id: string; name: string } | null
  office: Office | null
  has_approval_authority: boolean
  liaison: LiaisonProfile | null
}

export interface FlowDocument {
  id: string
  tracking_number: string
  /** Routing code printed on the document's QR label, e.g. BAG-ADM-RECORDS-48213907. */
  qr_code: string | null
  title: string
  description: string | null
  document_type: string | null
  priority: Priority
  status: DocumentStatus
  route_id: string | null
  route_name: string | null
  current_step_number: number | null
  current_office_id: string | null
  received_at: string | null
  pickup_requested_at: string | null
  assigned_liaison_id: string | null
  submitted_by: string
  file_name: string | null
  file_mime: string | null
  file_size: number | null
  /** Files under this document (a bulk upload has several, all under one QR). */
  file_count?: number
  /** Pages/sheets of the paper document (entered for photos; otherwise the number of files). */
  pages?: number | null
  target_date: string | null
  /** When the document should be done: submission time + its route's total processing time. */
  target_at: string | null
  submitted_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
  total_steps?: number
  next_office_name?: string | null
  step_sla_hours?: number | null
  step_entered_at?: string | null
  currentOffice?: Office | null
  submitter?: UserSummary | null
  liaison?: UserSummary | null
  /** Who scanned it in at the office it is at now. */
  received_by?: UserSummary | null
  /** Where it comes from: the uploader's assigned office, or their organization for CLIENT accounts. */
  origin?: DocumentOrigin
}

export interface DocumentOrigin {
  kind: 'OFFICE' | 'ORGANIZATION'
  office_id: string | null
  name: string
}

export interface RouteStep {
  id: string
  step_number: number
  office_id: string
  action_label: string
  /** Processing time at this step: whole days plus hours (0–23). */
  sla_days: number
  sla_hours: number
  /** sla_days * 24 + sla_hours */
  total_hours: number
  is_final_checkpoint: boolean
  office?: Pick<Office, 'id' | 'code' | 'name' | 'department_code' | 'department_name'>
}

/** A Document Route. `is_active` = offered for new documents; inactive ones are retired or earlier steps kept for documents in flight. */
export interface OrgRoute {
  id: string
  name: string
  description: string | null
  is_active: boolean
  created_at: string
  updated_at: string
  steps: RouteStep[]
  /** Only on GET /routes and route edits. */
  in_flight_documents?: number
}

export interface TrackingEvent {
  id: number
  event_type: string
  status_after: DocumentStatus
  step_number: number | null
  remarks: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  actor?: UserSummary | null
  office?: Pick<Office, 'id' | 'code' | 'name'> | null
  document?: Pick<FlowDocument, 'id' | 'tracking_number' | 'title' | 'priority' | 'status'>
}

type OfficeLite = Pick<Office, 'id' | 'code' | 'name'>

/** One office visit: everything that happened inside the office up to the hand-over to the next. */
export interface RoutingVisit {
  id: string
  step_number: number
  office: OfficeLite | null
  state: 'AT_OFFICE' | 'IN_TRANSIT' | 'TRANSFERRED' | 'APPROVED' | 'RETURNED' | 'CLOSED'
  arrived_at: string
  arrival: {
    kind: 'ARRIVED' | 'SUBMITTED' | 'RESUBMITTED'
    from_office: OfficeLite | null
    messenger: UserSummary | null
    by_hand: boolean
    delivery_minutes: number | null
  } | null
  received_at: string | null
  received_by: UserSummary | null
  released_at: string | null
  released_by: UserSummary | null
  messenger: UserSummary | null
  picked_up_at: string | null
  decided_at: string | null
  decided_by: UserSummary | null
  left_at: string | null
  to_office: OfficeLite | null
  durations: { waiting_receipt: number | null; processing: number | null; waiting_pickup: number | null; total: number | null }
  events: Array<{ id: string; type: string; at: string; actor: UserSummary | null; remarks: string | null; messenger: UserSummary | null }>
}

export interface Approval {
  id: string
  document_id: string
  office_id: string
  status: 'PENDING' | 'APPROVED' | 'RETURNED'
  requested_at: string
  decided_at: string | null
  remarks: string | null
  document?: FlowDocument
  decider?: UserSummary | null
  office?: Pick<Office, 'id' | 'code' | 'name'>
}

export interface QrInfo {
  id: string
  payload: string
  status: string
  created_at: string
  svg: string
  dataUrl: string
}

export interface DocumentPermissions {
  canEdit: boolean
  canSubmit: boolean
  canResubmit: boolean
  /** Receiving takes a scan of the QR label on the scanner page. */
  canScanReceive: boolean
  canRequestPickup: boolean
  /** Swap the assigned messenger for another free one, until it is picked up. */
  canReassign: boolean
  canCancelPickup: boolean
  canPickup: boolean
  canStartTransit: boolean
  canReportFailure: boolean
  canApprove: boolean
}

export interface Message {
  id: number
  thread_type: 'DIRECT' | 'DOCUMENT' | 'OFFICE'
  sender_id: string
  recipient_id: string | null
  document_id: string | null
  office_id: string | null
  body: string
  created_at: string
  sender?: UserSummary
}

export interface AppNotification {
  id: number
  type: string
  title: string
  body: string | null
  document_id: string | null
  link: string | null
  is_read: boolean
  created_at: string
}

export interface Issue {
  id: string
  title: string
  description: string | null
  category: string
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED'
  resolution: string | null
  created_at: string
  resolved_at: string | null
  document?: Pick<FlowDocument, 'id' | 'tracking_number' | 'title' | 'status'> | null
  reporter?: UserSummary | null
  assignee?: UserSummary | null
  reported_by: string
  assigned_to: string | null
}

/** Organization Settings: a document type offered when uploading. */
export interface DocumentTypeItem {
  id: string
  name: string
  description: string | null
  /** How long documents of this type may take, from submission. 0 + 0 = no deadline. */
  processing_days: number
  processing_hours: number
  /** processing_days × 24 + processing_hours */
  total_hours: number
  is_active: boolean
  sort_order: number
  /** How many documents are filed under it (settings page only). */
  usage?: number
}

/** Organization Settings: a file whose text the AI uses as organization knowledge. */
export interface KnowledgeFileItem {
  id: string
  title: string
  description: string | null
  file_name: string
  file_type: string | null
  file_size: number
  char_count: number
  status: 'READY' | 'NO_TEXT' | 'FAILED'
  error: string | null
  is_active: boolean
  created_at: string
  uploader?: UserSummary | null
}

/** One file of a document (bulk uploads have several under one QR code). */
export interface DocumentFileInfo {
  id: string
  name: string
  type: string | null
  size: number
  /** Opens the file (the session cookie authorizes it). */
  url: string
}
