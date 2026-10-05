# FlowVision

Document tracking and workflow management for **Bago City LGU**. Each document follows the Document Route its uploader picked through the city's offices, liaisons move the paper between offices by scanning QR labels, and staff at the final checkpoint approve or return them. Every step lands on a shared timeline.

**One full-stack Nuxt app.** Pages are server-rendered, and the API is in `server/` (Nitro). There is no separate backend.

| Layer     | Stack |
| --------- | ----- |
| App       | Nuxt 4 (SSR) · Vue 3 · Tailwind CSS 4 · Pinia |
| Server    | Nitro API routes (`server/api`) · Sequelize 6 · MariaDB 11 / MySQL 8 · cookie sessions · native WebSockets |
| Database  | 17 tables + 3 views — `database/flowvision-complete-schema.sql` |

## Quick start

Requirements: **Node.js 22.18+** (the DB scripts use Node's built-in TypeScript support) and **MariaDB 11 / MySQL 8**. The schema is `database/flowvision-complete-schema.sql` (17 tables + 3 views); see [docs/DATABASE.md](docs/DATABASE.md) for how the app uses it.

**Against the hosted database** (schema already imported via phpMyAdmin):

```bash
cp .env.example .env      # DB_HOST / DB_USER / DB_PASS / DB_NAME of the hosted database
npm install
npm run dev               # http://localhost:3000 — pages and /api together
```

Then open `/register` to create the organization and its first CLIENT account. Add offices and create one or more Document Routes, then invite the team from **Team accounts**.

**Against a local database** (for development, with demo data):

```bash
# .env: DB_HOST=127.0.0.1 and a local user/database
npm run db:reset          # drop + recreate all tables and views, load Bago City demo data
npm run dev
```

The DB scripts **refuse to run against a non-local `DB_HOST`** unless you add `--remote`. `db:schema` and `db:reset` drop every table: never point them at the hosted database. `npm run db:seed -- --remote` would load the demo accounts (shared password) into the hosted database, so only do that for a throwaway demo.

### Demo accounts

All seeded accounts use the password **`Demo@1234`**. The login page lists them for one-click sign-in. Hide that list with `NUXT_PUBLIC_SHOW_DEMO_ACCOUNTS=false`.

| Role     | Email                       | Office |
| -------- | --------------------------- | ------ |
| CLIENT   | client@bago.gov.ph          | — (organization admin) |
| EMPLOYEE | records@bago.gov.ph         | Records Section (route step 1) |
| EMPLOYEE | hr@bago.gov.ph              | HRMSO |
| EMPLOYEE | budget@bago.gov.ph          | City Budget Office |
| EMPLOYEE | accounting@bago.gov.ph      | City Accounting Office |
| EMPLOYEE | ocm@bago.gov.ph             | Office of the City Mayor |
| STAFF    | mayor.staff@bago.gov.ph     | Office of the City Mayor — **final checkpoint, can approve** |
| STAFF    | hr.staff@bago.gov.ph        | HRMSO — view-only |
| LIAISON  | liaison.adm@bago.gov.ph     | Administrative Services dept |
| LIAISON  | liaison.fin@bago.gov.ph     | Finance dept |

The seed pushes five documents through the real workflow, so each portal has something to show: a fresh submission, an open pickup, one awaiting the Mayor's approval, one completed, and a draft.

## How a document moves

```
Upload + save ──► QR label prints automatically (BAG-ADM-RECORDS-48213907)
                     │ START at its ORIGIN (step 0): the uploader's office, or the organization for a CLIENT
                     │ uploader / origin office assigns a FREE messenger → messenger + first office notified
                     │ (reassign any time before pickup; or hand-carry it and the first office scans it in)
                     ▼
Messenger scans QR ──► first office scans QR ──► received (their name is on the timeline)
                     │ release to a FREE messenger (reassignable until pickup) → messenger + next office notified
                     ▼
Messenger scans QR ──► PICKED_UP ──► IN_TRANSIT   (next office notified: incoming)
                     │ only staff of the next office can scan it in
                     ▼
Next office scans QR ──► ARRIVED_AT_OFFICE, received by them ── release … repeat per step …
                     │ received at the final checkpoint → approval request
                     ▼
STAFF (final office) ──► COMPLETED   or   RETURNED (remarks required; uploader can resubmit)
```

- **Many Document Routes per organization.** CLIENT, EMPLOYEE and STAFF upload documents and pick the route each one follows.
  - Editing a route keeps its id. Documents already in flight finish on the steps they started with.
- **Who approves a document:** only the **last office on that document's own route** (the step marked final checkpoint, or simply the last step), once it has been scanned in there.
  - Any EMPLOYEE or STAFF of that office sees *Approve / Return* on the document page and gets the request. Nobody else does, not even the owner or the CLIENT administrator, unless they belong to that office. The server enforces the same rule.
  - The STAFF *Approvals* page is for STAFF whose office has `is_final_checkpoint = 1`. That flag is re-synced whenever a route changes: an office keeps it while it ends any active route (or a retired one with documents still in flight).
  - STAFF without it see the blue "YOU DO NOT HAVE APPROVAL AUTHORITY" banner, and are redirected from `/staff/approval` to the read-only `/staff/view`.
  - The redirect happens during server rendering, before any page is sent.
- **Origin (step 0):** a document starts where its uploader belongs. A messenger carries it from there to the route's first office. If the uploader works at that first office, it starts there instead, already received.
- **Messengers (liaisons):** the origin, or an office once it has received the document, assigns one named messenger, and only that messenger can scan it for pickup. Until pickup, the messenger can be reassigned (the replaced one is told).
  - Only *free* messengers can be chosen: on duty, with nothing waiting to be picked up and nothing in hand. Two offices can't pick the same one at once.
  - A messenger can't go off duty while they still have a document.
- **Receiving:** always a scan of the QR label (camera, or typing the code under it). Only EMPLOYEE/STAFF of the office the document is at, or is being carried to, can receive it. Whoever scans it is recorded as the receiver.
- **QR payload:** `{OFFICE_CODE}-{8 random digits}`, e.g. `BAG-ADM-RECORDS-48213907`.
  - The prefix is the document's **origin**: the uploader's assigned office code, or for CLIENT accounts (no office), the organization's code. That is the first segment all its office codes share (`BAG` for `BAG-HR-HRMSO`), or else the initials of its name (`BCL` for Bago City LGU).
  - Route progress starts with that origin. It is *In process* until the first office scans the paper in, then *Completed*.
  - One code per document, issued on upload and used at every hand-off. Replacing a lost label issues new digits, and the old label stops working.
- **Organization Settings** (`/client/settings`, CLIENT only): the organization profile, the **document types** offered when uploading (and that the AI classifies into), and **AI knowledge files**. Knowledge files are PDF, Word, text, Markdown or CSV up to `KNOWLEDGE_MAX_MB` (default 200 MB). Their text is extracted on upload, and when the AI reads a document it gets the best-matching passages (about 6,000 characters, within Groq's per-request limits). Tables: `document_types`, `knowledge_files`.
- **Existing databases:** run `npm run db:migrate` once. It gives older documents a code in this format and makes codes unique.

## Project layout

```
app/                         Nuxt app (rendered on the server, then hydrated)
  pages/client|employee|staff|liaison/   Role portals (A1–A5, B1–B3, C1–C3, D1–D3)
  pages/documents/[id].vue               Shared document detail (timeline, QR, thread)
  pages/messages|issues|notifications|profile|login|register.vue
  components/                RouteFlow, DocumentCard, QRDisplay, ApprovalCard, MessageThread, …
  composables/               useApi, useAuth, useDocuments, useRoutes, useQR, useRealtime
  stores/                    Pinia: auth, documents, notifications, ui
  middleware/auth.global.ts  Session + role guards (runs on the server for the first request)
  assets/styles/             lumio.css (tokens), glassmorphic.css, index.css (Tailwind theme)
server/                      Nitro — the backend
  api/                       One file per endpoint, e.g. api/documents/[id]/receive.post.ts
  routes/_ws.ts              Realtime WebSocket endpoint
  middleware/security.ts     Security headers, CSRF origin check, body-size limits
  utils/api.ts               Auto-imported helpers: requireUser, defineApiHandler, sessions
  lib/                       Business logic, framework-free:
    documents.ts             the workflow state machine
    models.ts                Sequelize models (the SQL file is the source of truth; never sync())
    auth.ts · routes.ts · qr.ts · liaisons.ts · notifications.ts · realtime.ts · audit.ts …
scripts/                     db-schema.ts · db-seed.ts (run with plain `node`)
database/                    flowvision-complete-schema.sql
docs/                        API.md · DATABASE.md · DESIGN.md
```

`server/lib` only uses relative imports with `.ts` extensions. That lets the same code run inside Nitro and in the plain-Node seed script.

## Scripts

| Command             | What it does |
| ------------------- | ------------ |
| `npm run dev`       | Dev server (SSR + API + WebSockets) on :3000 |
| `npm run build`     | Production build into `.output/` |
| `npm start`         | Run the production build (reads `.env` if present) |
| `npm run typecheck` | `vue-tsc` over app **and** server |
| `npm run db:schema` | (Re)create all 17 tables — destructive |
| `npm run db:seed`   | Load demo data into an empty schema |
| `npm run db:reset`  | Both of the above |

## Deploying

```bash
npm run build
NODE_ENV=production PORT=3000 node --env-file=.env .output/server/index.mjs
```

- `.output/` is self-contained, with its own `node_modules`. Copy it together with the `uploads/` folder and your `.env`.
- Behind nginx, forward WebSocket upgrades for `/_ws` and keep the `Host` header. The CSRF check compares `Origin` with `Host` (or `X-Forwarded-Host`).
- In production the session cookie is `Secure`, so serve over HTTPS.
- Realtime and the login rate limiter keep state in memory. Run one instance, or add Redis before scaling out.

## Security

- **Sessions:**
  - Random 256-bit token in an httpOnly, SameSite=Lax cookie (`Secure` in production). Only its SHA-256 is stored in `auth_sessions`.
  - Sessions slide for 14 days and are revoked on logout, on password change (other devices), and when a user is suspended or their password is reset.
- **Passwords:** bcrypt with 12 rounds. Unknown emails take the same time as wrong passwords. 20 failed logins per IP per 15 minutes blocks that IP.
- **Mutating `/api` requests:** must come from the app's own origin (CSRF), and JSON bodies are capped at 1 MB.
- **Role checks run on the server for every request.** Role, office and status are reloaded from the database, so admin changes apply immediately.
- **Uploads:** PDF, image, Word or Excel only, up to 20 MB. They're stored under random names and served only to the same organization.

## Status

**Done:**
- All 17 tables.
- Server-rendered pages with cookie auth.
- Every A/B/C/D page.
- Route builder with versioning.
- Conditional STAFF approval.
- One permanent QR per document, printed on upload. Scanned by messengers (pickup) and office staff (receiving), with a type-the-code fallback.
- Liaison metrics.
- Timeline.
- Realtime notifications, messages and live refresh.
- Issues and audit log.

**Not done yet:**
- Capacitor (Android/iOS). Capacitor needs static files, so the mobile build will need either a separate SPA build or a Capacitor app that loads the hosted site.
- Service-worker push notifications.
- Migration tooling.
- Docker/PM2/nginx config.
- An automated test suite.

## Notes

- Fonts: Inter and JetBrains Mono ship via `@fontsource`. **Söhne is a commercial typeface.** If you license it, add its `@font-face` under `app/assets/`; the theme already lists it first and falls back to Inter Tight.
- Dates are formatted in Asia/Manila time on both server and browser, so server-rendered and hydrated output always match.
- The camera needs HTTPS or `localhost`. Elsewhere the scanner offers a paste box.
#   F l o w - V i s i o n - V 2 . 0 2  
 