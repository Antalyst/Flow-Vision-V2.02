# FlowVision: How the System Works

A plain-language guide to FlowVision: who uses it, what each account can and can't do, how a document is tracked, and how problems get reported.

Everything here was checked against the code (`server/lib/documents.ts`, `server/api/**`, `shared/page-access.ts`, `app/middleware/auth.global.ts`).

---

## 1. The system in one paragraph

FlowVision tracks paper documents for Bago City LGU. Someone uploads a document and picks a **Document Route**, which is the list of offices it must pass through. The system prints a **QR label** for the paper. A **messenger (liaison)** carries the paper from office to office, and each office **scans the QR** to receive it. When the document reaches the **last office** on its route, that office **approves** it (Completed) or **returns** it (Returned). Every step is recorded on the document's **timeline**.

---

## 2. The four accounts at a glance

| Account | Who it is | Main job | What it sees |
|---|---|---|---|
| **CLIENT** | Organization admin | Sets up offices, routes and accounts, and oversees everything | **Every** document in the organization |
| **EMPLOYEE** | Office worker | Receives, processes and releases documents at their office | Their own uploads, their office's uploads, and documents that are at, have visited or are heading to their office |
| **STAFF** | Office staff / reviewer | Receives documents. At the final office, approves or returns them | **Only their own uploads** in lists, plus documents waiting at their office (opened from approvals or a scan) |
| **LIAISON** | Messenger of one office | Picks up and carries paper from their own office | Only documents released to them or in their hands (plus ones they delivered before, when opened directly) |

**Rules that apply to every account**
- An account only sees data from its own organization.
- New accounts start as **pending** with a temporary password, and the user must set their own password.
- A **suspended** account is signed out right away and can't sign in again.
- The person who manages an account can limit which pages it may open (**page access**). The dashboard, notifications and profile are always open.

---

## 3. Document tracking: the flow

```
[UPLOAD]  CLIENT / EMPLOYEE / STAFF uploads the file, picks a route → QR label is created
   │      (Draft = CREATED; it can still be edited or deleted)
   ▼
[SUBMIT]  Document enters its route at the ORIGIN (step 0) → status START
   │      Origin = the uploader's office (or the organization, for a CLIENT)
   ▼
[ASSIGN MESSENGER]  The uploader or origin office picks a FREE messenger
   │                → the messenger and the next office are notified
   ▼
[PICKUP]  The messenger scans the QR → PICKED_UP → IN_TRANSIT
   ▼
[RECEIVE] Staff at the next office scan the QR → ARRIVED_AT_OFFICE (the scanner is recorded as receiver)
   │      Optional: pass desk to desk inside the office (another staff member scans to accept it)
   ▼
[RELEASE] The person who received it assigns one of THEIR OFFICE'S messengers → repeat for each office
   │
   ├── [FLAG & SEND BACK] Problem found? The receiver flags an issue, then assigns one of their
   │      office's messengers to take it back to the PREVIOUS office (issue: Open → In progress).
   │      The previous office scans it in, fixes it, and routes it forward again.
   ▼
[FINAL OFFICE] Received at the last office on the route → an approval request appears
   ├── APPROVE → COMPLETED (the uploader is notified)
   └── RETURN  → RETURNED  (remarks required; the uploader can fix it and resubmit)
```

### Document statuses

| Status | Meaning |
|---|---|
| `CREATED` | Draft. Not routed yet; it can be edited or deleted |
| `START` | Submitted and waiting at its origin |
| `PICKED_UP` | A messenger scanned it and has it |
| `IN_TRANSIT` | The messenger is on the way to the next office |
| `ARRIVED_AT_OFFICE` | At an office (received, or waiting to be scanned in) |
| `COMPLETED` | Approved by the final office. Done |
| `RETURNED` | Sent back to the uploader with remarks |

### Key tracking rules
- **One QR per document**, used at every hand-off. Replacing a lost label makes the old one stop working.
- **Receiving always needs a QR scan** (camera, or typing the code).
- **Only the person who scanned the document in** at an office can release it, assign its messenger, or pass it to a colleague.
- **Each office has its own messengers.** A document released from an office can only go with one of that office's messengers. A CLIENT upload starts at the organization (no office), so any messenger can carry it to the first office.
- **Only free messengers** can be assigned: on duty, with nothing waiting for pickup and nothing in hand. A messenger can be reassigned until they pick the document up.
- **Flag & send back:** the person who received the document at an office can flag an issue on it and send it back to the previous office on the route (from the first office: back to the uploader's office). It goes with one of the flagging office's messengers. The issue moves from Open to **In progress**, and the document shows "Flagged, going back to <office>". A CLIENT upload can't be sent back from the first office, because there is no office before it.
- **Only the last office on the route** can approve or return. The owner and the CLIENT can't, unless they belong to that office.
- A **failed delivery** (reported by the messenger) sends the document back to the office it came from, which has to scan it in again.
- Once a document is **COMPLETED**, it leaves everyone's lists except the uploader's and the CLIENT's. It is still reachable from the activity log.

---

## 4. Document tracking per account

### 4.1 CLIENT (organization admin)

| | |
|---|---|
| **Scope** | The whole organization: every document, office, route and account |
| **Can do** | Upload, edit, delete or submit drafts · resubmit returned documents · assign or reassign a messenger **at the origin** for any document · follow every document's timeline · filter by office, status, priority or type · add timeline notes |
| **Setup powers** | Create and edit **offices** · create, edit and retire **Document Routes** and their steps · create, suspend and edit **any account** and its page access · set **document types** and **AI knowledge files** (Organization Settings) |
| **Can't do** | **Scan QR codes** (the scanner page is blocked: the CLIENT follows along, it doesn't move paper) · approve or return documents (unless the CLIENT belongs to the final office, which CLIENT accounts normally don't) |
| **Gets notified about** | Every new issue reported in the organization |

### 4.2 EMPLOYEE (office worker)

| | |
|---|---|
| **Scope** | Their office: documents at, heading to, or that have visited their office, plus uploads by its members |
| **Can do** | Upload and submit documents · **scan to receive** documents arriving at their office · **pass desk to desk** to a colleague · **release to one of their office's messengers** (only if they scanned it in) · **flag an issue and send it back** to the previous office · reassign or cancel the messenger before pickup · replace a lost QR label · **approve or return** if their office is the last one on the route · see the office queue · filter by a STAFF member of their office |
| **Team powers** | Create and manage **STAFF and LIAISON accounts for their own office only** |
| **Can't do** | Receive documents meant for another office · release a document someone else scanned in · move people to another office · manage CLIENT or other EMPLOYEE accounts · edit routes or offices |

### 4.3 STAFF (office staff / reviewer)

| | |
|---|---|
| **Scope** | **Narrowest office scope.** Lists show only their own uploads. They can still open documents waiting at their office (to receive or approve them) |
| **Can do** | Upload and submit documents · scan to receive at their office · pass desk to desk · release to one of their office's messengers (if they scanned it in) · flag an issue and send it back to the previous office · **Approvals page**, only when their office is a **final checkpoint** |
| **Team powers** | Create and manage **LIAISON (messenger) accounts for their own office only** |
| **Can't do** | See other people's documents in lists · use the Approvals page without approval authority (they are redirected to the read-only **Document view** with a "no approval authority" banner) |

### 4.4 LIAISON (messenger)

| | |
|---|---|
| **Scope** | Documents released to them or in their hands right now. They belong to one office and only carry documents released from it |
| **Can do** | **Scan to pick up** (only documents released to them) · mark **in transit** · **report a failed delivery** (a reason is required) · go on or off duty · see their delivery history and stats (success rate, average time) |
| **Can't do** | Upload documents · open the documents list · use the AI assistant · receive documents at an office · go **off duty while holding a document** · pick up a document assigned to another messenger |

### 4.5 Who can do which action

| Action | CLIENT | EMPLOYEE | STAFF | LIAISON |
|---|:-:|:-:|:-:|:-:|
| Upload / edit / delete a draft (own) | ✅ (any) | ✅ | ✅ | ❌ |
| Submit / resubmit (own) | ✅ (any) | ✅ | ✅ | ❌ |
| Assign messenger at origin | ✅ | ✅ (uploader / origin office) | ✅ (uploader / origin office) | ❌ |
| Scan to **receive** | ❌ | ✅ (own office) | ✅ (own office) | ❌ |
| Pass desk to desk | ❌ | ✅ (receiver) | ✅ (receiver) | ❌ |
| Release to messenger at an office (own office's messengers only) | ❌ | ✅ (receiver) | ✅ (receiver) | ❌ |
| Flag issue & send back to the previous office | ❌ | ✅ (receiver) | ✅ (receiver) | ❌ |
| Scan to **pick up** / start transit | ❌ | ❌ | ❌ | ✅ (assigned) |
| Report failed delivery | ❌ | ❌ | ❌ | ✅ (carrier) |
| **Approve / Return** | ❌* | ✅ (final office) | ✅ (final office) | ❌ |
| Add timeline note (documents they can open) | ✅ | ✅ | ✅ | ✅ |
| Report an issue (documents they can open) | ✅ | ✅ | ✅ | ✅ |

\* Only if the account belongs to the final office.

---

## 5. Reports and Issues

### 5.1 Issues (problem reports)

Used to flag delays, missing paperwork, damage or routing mistakes. **Every issue must be about a document.**

**Where:** the `/issues` page, or the **Report an issue** button on a document's page (it pre-selects the document and sets the category to *Delay*).

| Field | Values |
|---|---|
| Category | Missing document · Delay · Damage · Incorrect routing · System · Other |
| Severity | Low · Medium (default) · High · Critical |
| Status | **Open → In progress → Resolved → Closed** |

**Issue lifecycle**
```
Anyone reports ──► OPEN ──► IN PROGRESS ──► RESOLVED (with resolution notes) ──► CLOSED
     │                ▲
     │                └── automatically when the document is flagged & sent back to the previous office
     └─► every CLIENT account is notified ("Issue reported")
```

**Flag & send back (issue on a document in the middle of its route)**
1. The person who received the document at their office flags an issue on it (the "Flag issue & send back" button on the document page).
2. They pick one of their office's free messengers. The issue becomes **In progress**. The messenger, the previous office and the uploader are notified.
3. The messenger scans it, carries it back, and the previous office scans it in. The document's route progress returns to that office, and its routing card says "Flagged and sent back".
4. The previous office fixes it and routes it forward again as usual. The person who flagged it resolves the issue once it comes back fixed.

**Who can do what**

| Action | CLIENT | Reporter | Assignee | Others |
|---|:-:|:-:|:-:|:-:|
| Report an issue | ✅ | | | ✅ (all accounts) |
| See the issue list | ✅ | ✅ | ✅ | ✅ (every issue in the organization) |
| Change status / severity / resolution | ✅ | ✅ | ✅ | ❌ |
| Assign to someone | ✅ (API only, no button yet) | ❌ | ❌ | ❌ |

**Notifications:** the CLIENT is notified when an issue is reported. The assignee is notified when one is assigned to them.

### 5.2 Activity log (who did what, when)

The `/logs` page is the system's audit report. You can filter it by category (Documents · Messengers · Approvals · Administration), by date range (today to 365 days) and by a search term.

| Account | Scopes it can view |
|---|---|
| CLIENT | **Organization** (everything) · My actions |
| EMPLOYEE | **My office** (everything at the office, its staff and its messengers) · My actions |
| STAFF | My actions only |
| LIAISON | My actions only |

### 5.3 Other reporting views
- **Dashboards**: each role has its own (CLIENT gets organization KPI cards, overdue count, open issues and pending approvals).
- **Document timeline / routing**: an office-by-office breakdown of each visit: who received it, how long it waited, who carried it.
- **Forecast**: estimated processing times per office.
- **AI Assistant** (CLIENT, EMPLOYEE, STAFF): answers questions such as "which documents are overdue?" using only the documents that account can see.

---

## 6. Other modules (short)

| Module | Who | What it does | Limits |
|---|---|---|---|
| **Auth** | All | Login, register (creates the organization and its first CLIENT), change password | Login is rate-limited · sessions slide (renewed hourly) |
| **Team accounts** | CLIENT (all) · EMPLOYEE (STAFF + LIAISON in own office) · STAFF (LIAISON in own office) | Invite, edit, suspend, reset password, set page access | Can't suspend or demote yourself, or change your own page access |
| **Offices** | CLIENT | Add and edit offices | Others can only view them |
| **Document Routes** | CLIENT | Build routes (office steps, processing time, final checkpoint) | Documents already in flight keep their original steps |
| **Org Settings** | CLIENT | Organization profile, document types, AI knowledge files | Knowledge files up to `KNOWLEDGE_MAX_MB` (200 MB default) |
| **Messages** | All | Direct messages, per-document threads, office channel | Office channel needs an office |
| **Notifications** | All | Realtime alerts (pickup, incoming, received, approved, returned, failed delivery, issues) | Stored in memory for realtime; single server instance |
| **QR / Scan** | EMPLOYEE, STAFF, LIAISON | Verify (preview what the scan will do), then confirm | Not available to CLIENT |

---

## 7. Gaps found while analyzing (to fix)

Ranked by priority. Each one was confirmed in the code.

| # | Area | Issue | Where |
|---|---|---|---|
| 1 | ~~Tracking / visibility~~ **Fixed** | A LIAISON could list every document with `?scope=all`. Now a messenger only lists documents released to them or in their hands, and can open documents they delivered before. | `server/lib/document-queries.ts` (`visibleWhere`, `openableWhere`) |
| 2 | **Issues / visibility** | **Every account sees every issue** in the organization, including the document title, even documents it can't open (for example, a STAFF member or a messenger). | `server/api/issues/index.get.ts` |
| 3 | ~~Issues~~ **Fixed** | An issue could be filed against any document in the organization. Now only against documents the reporter can open. | `server/api/issues/index.post.ts` |
| 4 | ~~Tracking / timeline~~ **Fixed** | Any account could add a timeline note to any document. Now only to documents they can open. | `server/api/documents/[id]/notes.post.ts` |
| 5 | ~~Messages~~ **Fixed** | Any account could post in any document's thread. Now only in threads of documents they can open. | `server/api/messages/index.post.ts` |
| 6 | **Issues** | **No "Assign" button** in the UI. Only a CLIENT can assign, and only through the API, so the "assignee" feature isn't usable. | `app/pages/issues.vue` |
| 7 | **Issues** | The **reporter isn't notified** when their issue is resolved or closed. | `server/api/issues/[id].patch.ts` |
| 8 | **Issues** | Status can jump to **any value** (for example, Closed → Open); there's no transition rule. The list is capped at 200 with no paging. | `server/api/issues/[id].patch.ts`, `index.get.ts` |
| 9 | **Tracking** | **No automatic overdue alerts.** Overdue documents show on dashboards and in the AI assistant, but nobody gets a notification and no issue is created when a step passes its processing time. | `server/lib/` (no scheduler) |
| 10 | **Docs** | The README shows the old QR format (`BAG-ADM-RECORDS-48213907`). The current format is `{OFFICE}{MMDDYY}{6 digits}`, for example `BCC100726123456`. | `README.md`, `server/lib/qr.ts` |

---

## 8. End-to-end test

`tests/flow.test.ts` runs the whole flow above against the running app and prints a green ✔ or a red ✘ for every step:

```
npm run dev                                                     # terminal 1
npm run test:flow -- --email=admin@example.com --password=…    # terminal 2
```

For CLIENT, EMPLOYEE and STAFF uploaders, it uploads 4 documents (single file, single image, 2 files, 2 images) and walks each one through every office: pickup, receive, desk-to-desk pass, release with the office's own messenger, and final approval. One document per uploader is flagged and sent back on the way. Every run also checks the routing cards, the timeline, the activity log, notifications, and the visibility rules.
