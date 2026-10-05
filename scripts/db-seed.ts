// Demo data for Bago City LGU.   npm run db:seed   (refuses remote hosts unless --remote)
//
// Documents are pushed through the real workflow (submit → receive → pickup →
// deliver → approve) so visits, QR codes, approvals, liaison metrics and
// notifications look exactly like production data.
import { assertSafeTarget } from './guard.ts'

try {
  process.loadEnvFile('.env')
} catch {
  /* no .env — rely on the environment */
}

// Imported after .env is loaded so the database config picks it up.
const { env } = await import('../server/lib/env.ts')
assertSafeTarget('seed', { host: env.db.host, port: env.db.port, name: env.db.name })
const { sequelize, Approval, Liaison, Office, Organization, User } = await import('../server/lib/models.ts')
const { hashPassword, loadActor } = await import('../server/lib/auth.ts')
const { createRoute } = await import('../server/lib/routes.ts')
const workflow = await import('../server/lib/documents.ts')
const knowledge = await import('../server/lib/knowledge.ts')

type Actor = NonNullable<Awaited<ReturnType<typeof loadActor>>>

const ORG_NAME = 'Bago City Local Government Unit'
const DEMO_PASSWORD = 'Demo@1234'

// offices.code is the QR prefix: {ORGCODE}-{DEPT}-{OFFICE}
const OFFICES = [
  { key: 'RECORDS', code: 'BAG-ADM-RECORDS', name: 'Records Section', department: 'Administrative Services', address: 'City Hall, Ground Floor' },
  { key: 'HRMSO', code: 'BAG-ADM-HRMSO', name: 'Human Resource Management Services Office', department: 'Administrative Services', address: 'City Hall, 2nd Floor' },
  { key: 'CBO', code: 'BAG-FIN-CBO', name: 'City Budget Office', department: 'Finance', address: 'City Hall, 2nd Floor' },
  { key: 'CACCO', code: 'BAG-FIN-CACCO', name: 'City Accounting Office', department: 'Finance', address: 'City Hall, 2nd Floor' },
  { key: 'CTO', code: 'BAG-FIN-CTO', name: "City Treasurer's Office", department: 'Finance', address: 'City Hall, Ground Floor' },
  { key: 'OCM', code: 'BAG-EXEC-OCM', name: 'Office of the City Mayor', department: 'Executive', address: 'City Hall, 3rd Floor' },
]

const USERS = [
  { email: 'client@bago.gov.ph', type: 'CLIENT', first: 'Maria', last: 'Santos', office: null },
  { email: 'records@bago.gov.ph', type: 'EMPLOYEE', first: 'Jose', last: 'Reyes', office: 'RECORDS' },
  { email: 'hr@bago.gov.ph', type: 'EMPLOYEE', first: 'Ana', last: 'Villanueva', office: 'HRMSO' },
  { email: 'budget@bago.gov.ph', type: 'EMPLOYEE', first: 'Ramon', last: 'Garcia', office: 'CBO' },
  { email: 'accounting@bago.gov.ph', type: 'EMPLOYEE', first: 'Liza', last: 'Mendoza', office: 'CACCO' },
  { email: 'ocm@bago.gov.ph', type: 'EMPLOYEE', first: 'Carlo', last: 'Bautista', office: 'OCM' },
  { email: 'mayor.staff@bago.gov.ph', type: 'STAFF', first: 'Teresa', last: 'Aquino', office: 'OCM' },
  { email: 'hr.staff@bago.gov.ph', type: 'STAFF', first: 'Paolo', last: 'Ramos', office: 'HRMSO' },
  { email: 'liaison.adm@bago.gov.ph', type: 'LIAISON', first: 'Dante', last: 'Flores', office: 'RECORDS' },
  { email: 'liaison.fin@bago.gov.ph', type: 'LIAISON', first: 'Grace', last: 'Torres', office: 'CBO' },
]

// An organization can have many Document Routes; each document follows the one it was uploaded on.
const ROUTES = {
  standard: {
    name: 'Standard LGU document route',
    description: 'Records → HR → Budget → Accounting → Office of the City Mayor',
    steps: [
      { office: 'RECORDS', action_label: 'Receive & log' },
      { office: 'HRMSO', action_label: 'HR review' },
      { office: 'CBO', action_label: 'Budget certification' },
      { office: 'CACCO', action_label: 'Accounting review' },
      { office: 'OCM', action_label: "Mayor's approval" },
    ],
  },
  hr: {
    name: 'HR personnel route',
    description: 'Leave applications and other personnel papers: Records → HR, approved by HR staff',
    steps: [
      { office: 'RECORDS', action_label: 'Receive & log' },
      { office: 'HRMSO', action_label: 'HR approval' },
    ],
  },
}

const metaFor = (user: Actor) => ({ user, ip: '127.0.0.1', userAgent: 'flowvision-seed' })

async function main() {
  if (await Organization.findOne({ where: { name: ORG_NAME } })) {
    console.log(`[seed] "${ORG_NAME}" already exists — run \`npm run db:reset\` on a local database to start over`)
    return
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD)
  const org = await Organization.create({ name: ORG_NAME, description: 'City Hall, Bago City, Negros Occidental', status: 'active' })

  const offices: Record<string, any> = {}
  for (const { key, ...o } of OFFICES) offices[key] = await Office.create({ ...o, org_id: org.id, status: 'active' })

  const ids: Record<string, string> = {}
  for (const u of USERS) {
    const office = u.office ? offices[u.office] : null
    const user = await User.create({
      org_id: org.id,
      office_id: office?.id ?? null,
      department: office?.department ?? null,
      account_type: u.type,
      email: u.email,
      password_hash: passwordHash,
      first_name: u.first,
      last_name: u.last,
      full_name: `${u.first} ${u.last}`,
      status: 'active',
      email_verified: true,
    })
    if (u.type === 'LIAISON') await Liaison.create({ user_id: user.id, org_id: org.id, department: office.department, available: true })
    ids[u.email] = user.id
  }
  await org.update({ created_by: ids['client@bago.gov.ph'] })
  await knowledge.createDefaultDocumentTypes(org.id, ids['client@bago.gov.ph']!)
  const actor = async (email: string) => (await loadActor(ids[email]!))!

  const routeIds: Record<string, string> = {}
  for (const [key, r] of Object.entries(ROUTES)) {
    const route = await createRoute(org.id, ids['client@bago.gov.ph']!, {
      name: r.name,
      description: r.description,
      steps: r.steps.map((s) => ({ ...s, office_id: offices[s.office].id })),
    })
    routeIds[key] = route.id
  }

  // Load actors after the routes are saved so office.is_final_checkpoint is current.
  const p = {
    client: await actor('client@bago.gov.ph'),
    records: await actor('records@bago.gov.ph'),
    hr: await actor('hr@bago.gov.ph'),
    budget: await actor('budget@bago.gov.ph'),
    accounting: await actor('accounting@bago.gov.ph'),
    ocm: await actor('ocm@bago.gov.ph'),
    mayorStaff: await actor('mayor.staff@bago.gov.ph'),
    liaisonAdm: await actor('liaison.adm@bago.gov.ph'),
    liaisonFin: await actor('liaison.fin@bago.gov.ph'),
  }

  const create = (
    input: { title: string; document_type?: string; description?: string; priority?: string },
    { submit = true, route = 'standard', by = p.client }: { submit?: boolean; route?: keyof typeof ROUTES; by?: Actor } = {},
  ) => workflow.createDocument(by, { priority: 'NORMAL', ...input, route_id: routeIds[route], submit }, null, metaFor(by))

  // Each document's QR label is scanned at every hand-off, exactly as in the app.
  const scan = async (docId: string, action: 'PICKUP' | 'RECEIVE', by: Actor) => workflow.performScan(await workflow.routingCodeOf(docId), action, by)

  // Release a received document to a messenger, who carries it to the next office, where it is scanned in.
  async function hop(docId: string, sender: Actor, liaison: Actor, receiver: Actor) {
    await workflow.requestPickup(docId, sender, { liaisonUserId: liaison.id })
    await scan(docId, 'PICKUP', liaison)
    await workflow.startTransit(docId, liaison)
    await scan(docId, 'RECEIVE', receiver)
  }
  // Uploaded by the CLIENT, so it starts at its origin (the organization): a messenger brings it to Records.
  const fullRoute = async (docId: string) => {
    await hop(docId, p.client, p.liaisonAdm, p.records)
    await hop(docId, p.records, p.liaisonAdm, p.hr)
    await hop(docId, p.hr, p.liaisonAdm, p.budget)
    await hop(docId, p.budget, p.liaisonFin, p.accounting)
    await hop(docId, p.accounting, p.liaisonFin, p.ocm)
  }

  // 1. Fresh submission waiting at Records — uploaded by an HR employee on the HR personnel route
  await create(
    { title: 'Leave application — J. Dela Cruz', document_type: 'Leave Application', description: 'Vacation leave, 5 working days.' },
    { route: 'hr', by: p.hr },
  )

  // 3. Travel order that reached the Mayor's office and awaits approval
  const travel = await create({ title: 'Travel order — DILG regional seminar', document_type: 'Travel Order', priority: 'URGENT' })
  await fullRoute(travel.id)

  // 4. Fully completed voucher
  const voucher = await create({ title: 'Disbursement voucher — Barangay sports fest', document_type: 'Disbursement Voucher' })
  await fullRoute(voucher.id)
  const pending = (await Approval.findOne({ where: { document_id: voucher.id, staff_id: p.mayorStaff.id, status: 'PENDING' } }))!
  await workflow.decideApproval(pending.id, p.mayorStaff, { decision: 'APPROVED', remarks: 'Approved for release.' }, metaFor(p.mayorStaff))

  // 2. Received at Records and released to an Administrative Services messenger, waiting for pickup.
  //    Seeded last: a messenger with a document to pick up can't be given another one.
  const purchase = await create({ title: 'Purchase request — Office supplies Q4', document_type: 'Purchase Request', priority: 'HIGH' })
  // Brought to Records by hand: no messenger was assigned at the origin, so Records scans it in directly.
  await scan(purchase.id, 'RECEIVE', p.records)
  await workflow.requestPickup(purchase.id, p.records, { liaisonUserId: p.liaisonAdm.id, remarks: 'For HR review' })

  // 5. Draft not yet submitted
  await create({ title: 'Memorandum — Office hours during holidays', document_type: 'Memorandum', priority: 'LOW' }, { submit: false })

  console.log('[seed] Bago City LGU demo data created')
  console.log(`[seed] all demo accounts use the password: ${DEMO_PASSWORD}`)
  for (const u of USERS) console.log(`        ${u.type.padEnd(8)} ${u.email}${u.office ? `  (${u.office})` : ''}`)
}

try {
  await main()
} catch (err) {
  console.error('[seed] failed:', err)
  process.exitCode = 1
} finally {
  await sequelize.close()
}
