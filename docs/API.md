# FlowVision API

The API is served by Nitro from the same origin as the app, under `/api` (`http://localhost:3000/api` in dev). Every endpoint is a file in `server/api/`, e.g. `POST /api/documents/:id/pickup-request` → `server/api/documents/[id]/pickup-request.post.ts`. All bodies are JSON unless noted.

**Auth.** Signing in sets an httpOnly `fv_session` cookie (SameSite=Lax, `Secure` in production, sliding 14 days). Browsers send it automatically. During SSR, `useApi()` forwards it via `useRequestFetch`. There are no bearer tokens to manage. Mutating requests (`POST/PUT/PATCH/DELETE`) that carry an `Origin` header must come from the app's own host, or they get a `403`.

**Errors** use h3's shape:

```json
{ "statusCode": 409, "statusMessage": "CONFLICT", "message": "Scan the document’s QR code to receive it before releasing it", "data": { "code": "CONFLICT" } }
```

Common statuses: `400` validation, `401` not signed in / session expired, `403` wrong role, not your office, or cross-origin, `404` not found **in your organization**, `409` invalid state transition, `413` body too large, `429` rate limited.

Role column: **C**lient, **E**mployee, **S**taff, **L**iaison. "All" means any signed-in user; everything is scoped to the caller's organization.

## Auth

| Method | Path                    | Role | Body / notes |
| ------ | ----------------------- | ---- | ------------ |
| POST   | `/auth/register`        | —    | `organization_name, first_name, last_name, email, password` → creates org + CLIENT, sets the session cookie, returns `{ user }` |
| POST   | `/auth/login`           | —    | `email, password` → sets the session cookie, returns `{ user }` |
| POST   | `/auth/logout`          | All  | Revokes the session and clears the cookie |
| GET    | `/auth/me`              | All  | Current user incl. `office`, `has_approval_authority`, `liaison` |
| PATCH  | `/auth/me`              | All  | `first_name, last_name, phone` |
| POST   | `/auth/change-password` | All  | `current_password, new_password` — signs out every other session |

Login and register allow 20 **failed** attempts per IP per 15 minutes; change-password, 20 per user.

## Documents

| Method | Path                               | Role | Notes |
| ------ | ---------------------------------- | ---- | ----- |
| GET    | `/documents`                       | All  | Query: `scope` (`all` · `mine` · `office` · `incoming` · `carrying` · `pickups`), `status` (comma list), `priority`, `office` (CLIENT only: id of the office it is at now), `staff` (EMPLOYEE only: a STAFF member of their office — documents they uploaded or handled; another id → 400), `type` (document type name), `q`, `page`, `limit`. Default scope: C→all, E/S→office, L→carrying. `q` matches the title, the QR code (`BCC100726123456`, or part of it), the upload date typed as `MMDDYY` (the QR code's date segment, e.g. `100726`), or a tracking number (`FV-1A2B3C4D`, the start of the document id). Rows include `qr_code`, `received_by` (who scanned it in at the current office) and `liaison` (the messenger it was released to or is carried by). Rows include `total_steps`, `next_office_name`, `step_sla_hours` (from the step's `sla_days`), `step_entered_at`. |
| POST   | `/documents`                       | C, E, S | **multipart/form-data**: `title`*, `route_id` (required when the org has 2+ active routes), `description`, `document_type`, `priority` (LOW·NORMAL·HIGH·URGENT), `target_date` (YYYY-MM-DD), `file` (PDF/image/Word/Excel ≤ 20 MB), `submit` (`true` default; `false` saves a draft) |
| GET    | `/documents/:id`                   | All  | `{ document, route, tracking[], approvals[], pending_approval, active_qr, permissions }`. `permissions` tells the UI which actions the caller may take now. |
| PATCH  | `/documents/:id`                   | C / uploader | Edit a **draft** (multipart, same fields as create, incl. `route_id`) |
| DELETE | `/documents/:id`                   | C / uploader | Delete a draft |
| GET    | `/documents/:id/file`              | All  | Streams the attachment — a plain link works because the cookie authenticates it |
| GET    | `/documents/:id/timeline`          | All  | Tracking events only |
| POST   | `/documents/:id/submit`            | C / uploader | Draft → START, or RETURNED → START. `route_id` optional: switches to another active route (required if the document's route was retired or edited after it ran on it) |
| POST   | `/documents/:id/pickup-request`    | E, S | **Release to a messenger.** At your office, received, not the final step. `liaison_user_id`* must be a messenger who is on duty and free (nothing to pick up or deliver), else `409 MESSENGER_BUSY` / `MESSENGER_UNAVAILABLE`. `remarks` optional. Notifies the messenger and the next office. Returns `{ document }`. |
| DELETE | `/documents/:id/pickup-request`    | E, S | Cancel the release before pickup; the messenger is told and freed |
| POST   | `/documents/:id/pass-staff`        | E, S | **Pass to the next staff** of the same office. Only the receiver, before a messenger is assigned. `remarks` optional. Clears the receipt: another staff member scans it in before it can be passed again or released. Notifies the office. Returns `{ document }`. |
| DELETE | `/documents/:id/pass-staff`        | E, S | Take a pass back before the next staff scans it in (the passer only) |
| POST   | `/documents/:id/transit`           | L    | PICKED_UP → IN_TRANSIT (carrying liaison only) |
| POST   | `/documents/:id/fail-delivery`     | L    | `remarks`* — back to the origin office, counts as a failed delivery |
| POST   | `/documents/:id/notes`             | All  | `remarks`* — adds a NOTE to the timeline |

## Document Routes

An organization can have any number of routes. Whoever uploads a document picks the route it follows.

| Method | Path                | Role | Notes |
| ------ | ------------------- | ---- | ----- |
| GET    | `/routes`           | All  | `{ data: [route] }` — active routes A–Z, each with steps + offices and `in_flight_documents` |
| POST   | `/routes`           | C    | `name`* (unique among active routes), `description`, `steps: [{ office_id, action_label, sla_days }]` (1–30). The last step's office becomes a final checkpoint. |
| PATCH  | `/routes/:id`       | C    | Any of `name`, `description`, `steps`. The route keeps its id. If the steps change, documents in flight or completed on it move to an inactive copy of the old steps (`moved_documents` in the response) and finish there. |
| DELETE | `/routes/:id`       | C    | Deleted if no document ever used it, otherwise retired (`is_active = 0`, `retired: true`). Documents in flight still finish. |
| POST   | `/routes/:id/steps` | C    | `steps: [...]` (or one step's fields) appended to route `:id` (an edit, as above) |
## Approvals

| Method | Path              | Role | Notes |
| ------ | ----------------- | ---- | ----- |
| GET    | `/approvals`      | S    | `status` = PENDING (default) · APPROVED · RETURNED. Empty list + `has_approval_authority: false` for staff outside the final checkpoint. |
| PATCH  | `/approvals/:id`  | S    | `decision` = APPROVED · RETURNED, `remarks` (required for RETURNED). Requires approval authority **and** the approval's office = your office. |

## QR codes

| Method | Path                           | Role | Notes |
| ------ | ------------------------------ | ---- | ----- |
| GET    | `/qr/:document_id`             | All  | The document's QR label: `{ payload, svg, dataUrl }` |
| POST   | `/qr/generate/:document_id`    | E, S | Replace a lost or damaged label while the document is at your office (same office prefix, new digits; the old label stops working) |
| POST   | `/qr/verify`                   | L, E, S | `payload` → dry run: `{ action: PICKUP·RECEIVE·null, reason, tone, document, from_office, to_office, messenger, received_by }` |
| POST   | `/qr/scan`                     | L, E, S | `payload`, `action` (optional guard) → performs the pickup or the receipt |

**Payload:** `{OFFICE_CODE}{MMDDYY}{6 random digits}`, e.g. `BCC100726123456` — the origin office code, the upload date (Philippine time) and 6 random digits. Labels printed in the older `{OFFICE_CODE}-{8 digits}` format (e.g. `BCL-54967520`) still scan. Each document gets one code when it is uploaded, from its origin: the uploader's assigned office, or the organization for CLIENT accounts (the first segment its office codes share, else its name's initials). Each document also carries `origin: { kind: OFFICE·ORGANIZATION, office_id, name }`. The same code is used at every hand-off until the document is done.

What a scan does:

| Who scans | Document is… | Action |
| --- | --- | --- |
| Messenger | at an office, released to **them** | `PICKUP` → `PICKED_UP`. The office, the uploader and the **next office** are notified. |
| Office staff (E/S) | waiting at **their** office, not yet received | `RECEIVE`: records them as the receiver |
| Office staff (E/S) | being carried to **their** office (the next step) | `RECEIVE`: drop-off. Opens their visit, received by them; the messenger's delivery is counted. |
| Anyone else | — | `action: null` with a `reason`. For example, only the next office's staff can receive a carried document. |

## Organization

| Method | Path                          | Role       | Notes |
| ------ | ----------------------------- | ---------- | ----- |
| GET    | `/offices`                    | All        | `active=all` to include inactive. Includes `member_count`. |
| POST   | `/offices`                    | C          | `name`, `code` (the QR prefix, e.g. `BAG-HR-HRMSO`, unique), `department`, `location` (address) |
| PATCH  | `/offices/:id`                | C          | Same fields + `is_active` |
| GET    | `/users`                      | All        | CLIENT: full roster. Others: directory (id, name, role, office). `account_type`, `q` filters. |
| POST   | `/users`                      | C          | `account_type, email, first_name, last_name, phone, office_id` (required for non-CLIENT) → `{ user, temporary_password }` |
| PATCH  | `/users/:id`                  | C          | `first_name, last_name, phone, account_type, office_id, status` (ACTIVE · SUSPENDED) |
| POST   | `/users/:id/reset-password`   | C          | → `{ temporary_password }`, signs the user out everywhere |
| GET    | `/liaisons`                   | C, E, S    | `department`, `available=true`, `free=true` (only messengers who can take a document now), `q`. Free messengers first. `availability` is BUSY while a document is released to them or in their hands. |
| GET    | `/liaisons/me`                | L          | `{ profile, carrying[], activity[], today }`, `since` (ISO date) widens the activity window |
| PATCH  | `/liaisons/me`                | L          | `availability` = AVAILABLE · OFF_DUTY (stored in `liaisons.available`; BUSY is derived). Going off duty is refused (`409 MESSENGER_BUSY`) while a document is released to them or in their hands. |
| GET    | `/dashboard`                  | All        | Role-specific aggregates for the dashboard pages |

## Collaboration

| Method | Path                         | Role | Notes |
| ------ | ---------------------------- | ---- | ----- |
| GET    | `/messages/threads`          | All  | `{ direct[], documents[], office }` with last message + unread counts |
| GET    | `/messages/:document_id`     | All  | Document thread. `before` (message id) + `limit` paginate. |
| GET    | `/messages/direct/:user_id`  | All  | Direct conversation; marks incoming as read |
| GET    | `/messages/office`           | All  | Your office channel |
| POST   | `/messages`                  | All  | `thread_type` (DIRECT · DOCUMENT · OFFICE), `body`, plus `recipient_id` or `document_id` |
| GET    | `/notifications`             | All  | `unread=true`, `limit` → `{ data, unread }` |
| PATCH  | `/notifications/:id/read`    | All  | |
| POST   | `/notifications/read-all`    | All  | |
| GET    | `/issues`                    | All  | `status`, `document_id`, `mine=true` |
| POST   | `/issues`                    | All  | `title`*, `document_id`* (every issue is about a document), `description`, `category`, `severity` |
| PATCH  | `/issues/:id`                | C / reporter / assignee | `status`, `severity`, `resolution`; `assigned_to` (CLIENT only) |

## Realtime (WebSocket)

Connect to `ws(s)://<host>/_ws` (Nitro native WebSockets, `server/routes/_ws.ts`). The handshake is authenticated with the same session cookie; without a valid session the upgrade is refused with 401. On connect the server subscribes you to `user:{id}`, `org:{orgId}` and `office:{officeId}`.

Server → client frames are JSON `{ "event": string, "payload": object }`:

| Event              | Payload |
| ------------------ | ------- |
| `notification`     | `{ type, title, body, document_id, link, created_at }` |
| `message`          | Full message incl. `sender` |
| `document:updated` | `{ id, status, current_step_number, current_office_id }` (org-wide) |

Client → server frames:

| Frame | Effect |
| ----- | ------ |
| `{ "type": "join", "documentId": "…" }`  | Receive that document's thread messages (same organization only) |
| `{ "type": "leave", "documentId": "…" }` | Stop receiving them |

Events are emitted only after the database transaction commits. `app/composables/useRealtime.ts` reconnects with exponential backoff and rejoins document threads automatically.
