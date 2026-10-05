# FlowVision database

FlowVision runs on the project's own schema: **17 tables + 3 views**, MariaDB 11 (hosted) or MySQL 8 (local).

- **Source of truth:** [`database/flowvision-complete-schema.sql`](../database/flowvision-complete-schema.sql). It's the phpMyAdmin export with `DEFINER` clauses removed so it imports anywhere.
- **Models:** `server/lib/models.ts` mirrors it column for column and never runs `sync()`.
- **No schema changes:** the app needs no extra columns or tables.

## How the app uses each table

| Table | What the app stores there |
| ----- | ------------------------- |
| `organizations` | One per LGU. `created_by` = the CLIENT who registered it. |
| `offices` | `code` is the **full QR prefix** `{ORGCODE}-{DEPT}-{OFFICE}` (e.g. `BAG-HR-HRMSO`, globally unique). `department` is the liaison pickup scope. `is_final_checkpoint` is kept in sync with the last step of the active route. `status` active/inactive. |
| `users` | `status`: `active`; `pending` = signed in with a temporary password (must change it); `inactive` = suspended. `full_name` is kept in sync with first/last name (the views use it). `department` copies the office's department. |
| `organization_routes` | Any number of **Document Routes** per org. `is_active = 1`: offered for new documents (names unique among these). `is_active = 0`: retired, or a snapshot of an edited route's earlier steps — editing keeps the route's id, and documents in flight/completed on the old steps move to that snapshot first. |
| `route_steps` | `step_number`, `office_id`, `sla_days`, `action_description`. The last step has `is_final_checkpoint = 1`. |
| `documents` | `route_id` is required, so even drafts are pinned to a route — the one the uploader picked (a route must exist before documents can be created). `category` = document type. `file_url` = `<uuid>/<original file name>` under `UPLOAD_DIR`. `file_type` = MIME type (or the extension when the MIME type is longer than 50 chars). The tracking number shown to people (`FV-1A2B3C4D`) is derived from the id. |
| `document_tracking` | **One row per office visit** — see below. |
| `approvals` | One row per (document, STAFF, office) at the final checkpoint. Every STAFF there gets a `PENDING` row when the document is received. The one who decides gets `APPROVED`/`RETURNED` + `approved_at`, and the other `PENDING` rows are removed. |
| `liaisons` | `available` = on/off duty. "Busy" is derived: a document is released to them (current visit `liaison_id`) or in their hands. Only free messengers can be given a document. Each delivery updates `total_deliveries`, `success_rate`, `average_delivery_time` (minutes), `deliveries_today` (resets per Manila day) and `last_delivery`. A failed delivery counts as a total without a success. |
| `qr_codes` | **One row per document, for its whole life.** `qr_code_data` = `{office code}-{8 random digits}` (e.g. `BAG-ADM-RECORDS-48213907`), unique. It is created on upload, printed as the QR label, and scanned at every hand-off. `office_code` is the origin: the uploader's assigned office code, or the organization's code for CLIENT accounts (the first segment its office codes share, else its name's initials). Replacing a lost label changes the digits, so the old label stops working. |
| `issues` | Always about a document (`document_id` is required). `issue_type` = category, `priority` = severity, `resolution_notes`. |
| `messages` | `conversation_type`: `DIRECT` (recipient_id), `GROUP` (a document's thread, document_id), `OFFICE` (everyone in the sender's office). `content`, `is_read`. |
| `notifications` | `title`, `message`, `action_url` (where clicking goes), `is_read`. |
| `auth_sessions` | Cookie sessions. `token` holds the **SHA-256** of the `fv_session` cookie, never the raw token. Logging out or revoking deletes the row. `expires_at` slides forward (renewed at most hourly). |
| `audit_logs` | `action`, `entity_type`, `entity_id`, `old_values` / `new_values` (JSON), `ip_address`. |

The views `active_documents_by_office`, `liaison_performance` and `pending_approvals` are not used by the app, but the data it writes keeps them meaningful. For example, `pending_approvals` lists exactly the documents waiting for each STAFF member.

## Document state

```
CREATED ──submit──► START ─┐
                           │ (staff scan QR = receive → release to a free messenger)
             ┌─────────────┘
             ▼
        PICKED_UP ──► IN_TRANSIT ──next office scans QR──► ARRIVED_AT_OFFICE (received) ──► … next leg …
             │                                                    │
             └──fail-delivery──► back to origin                   └─ final step: receive → approval
                                                                                ├─► COMPLETED
                                                                                └─► RETURNED ──resubmit──► START
```

### `document_tracking`: one row per office visit

| Column | Meaning |
| ------ | ------- |
| `step_number`, `office_id` | The route step / office being visited |
| `arrived_at` | When the document reached this office (submission for step 1, delivery otherwise) |
| `handler_id` | Who confirmed receipt — **received ⇔ not null** |
| `liaison_id` | Who carries it out: the requested liaison while the pickup is open (null = open to the department), then the actual carrier |
| `completed_at` | When it left the office (pickup) or was decided (final step) |
| `status` | `START`/`ARRIVED_AT_OFFICE` while there → `PICKED_UP` → `IN_TRANSIT` → `COMPLETED` once delivered onward (or approved), `RETURNED` if returned |
| `notes` | The visit's **event log**, as a JSON array (see below) |

The *current visit* is the latest row for the document's `current_step_number`. While the document is at an office, its `handler_id` and `liaison_id` give every sub-state:

| Received (`handler_id`) | Released (`liaison_id`) | Meaning |
| --- | --- | --- |
| no  | no  | Waiting at the office for its staff to scan the QR in |
| yes | no  | Received (by `handler_id`) and being processed |
| yes | yes | Released to that messenger, waiting for them to scan it at pickup |

**Step 0 is the origin**: the uploader's office, or `office_id` NULL for a CLIENT upload (the organization). Its `handler_id` is the uploader, so a messenger can be assigned right away; `documents.current_step_number` is 0 until the first office receives it.

While it is carried (`PICKED_UP` / `IN_TRANSIT`), `liaison_id` is the messenger carrying it. Staff of the next office scan the QR to receive it: that closes this visit and opens theirs, with `handler_id` = the person who scanned it.

While in transit, `current_step_number`/`current_office_id` still point at the **origin**; delivery advances both and opens the next visit. The destination is `route_steps(route_id, current_step_number + 1)`.

### The `notes` event log

Each visit's `notes` holds what happened there, oldest first:

```json
[
  {"id":"…","type":"ARRIVED","at":"2026-10-05T01:12:03.211Z","by":"<messenger id>","status":"ARRIVED_AT_OFFICE","meta":{"from_office_id":"…","received_by":"<employee id>","delivery_minutes":14}},
  {"id":"…","type":"RECEIVED","at":"2026-10-05T01:12:03.214Z","by":"<employee id>","status":"ARRIVED_AT_OFFICE"},
  {"id":"…","type":"PICKUP_REQUESTED","at":"…","by":"…","status":"ARRIVED_AT_OFFICE","meta":{"liaison_id":"<messenger id>","next_office_id":"…"}}
]
```

- **Event types:** `SUBMITTED`, `RESUBMITTED`, `ARRIVED`, `RECEIVED`, `APPROVAL_REQUESTED`, `PICKUP_REQUESTED`, `PICKED_UP`, `IN_TRANSIT`, `DELIVERY_FAILED`, `APPROVED`, `RETURNED`, `COMPLETED`, `NOTE`.
- **Timeline:** the document page merges every visit's log into one timeline with millisecond timestamps.
- **Foreign notes:** plain-text notes written by another tool are shown as a single note instead of being lost.

## Invariants enforced by the server

Every transition in `server/lib/documents.ts` runs in a transaction, with the document row locked (`SELECT … FOR UPDATE`), and sends notifications only after commit.

- Only the current office can receive or route a document; only after receipt; never from the final step.
- Only the carrying liaison can mark transit, deliver, or fail a delivery.
- A pickup can be claimed by the requested liaison, or (if open) by any liaison whose `department` matches the origin office's `department`.
- Only STAFF at the final-checkpoint office can decide, and only on their own approval row.
- Saving a route deactivates the previous one and re-syncs `offices.is_final_checkpoint`.

## Local development database

```bash
# with DB_* in .env pointing at a LOCAL MySQL/MariaDB
npm run db:reset     # drop + recreate all tables and views, then load demo data
```

`db:schema`, `db:seed` and `db:reset` **refuse to run against a non-local host** (`DB_HOST` other than `localhost` / `127.0.0.1`) unless you add `--remote`. Never run `db:schema` against the hosted database: it drops every table.
