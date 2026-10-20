/**
 * Umbrella offices, dashed QR codes, office/Global document types and the Citizen's Charter import
 * and time suggestion — without a database or an AI model (Sequelize lookups are mocked).
 *
 *   npm run test:umbrella-types
 */
import { afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { DocumentType, Office } from '../server/lib/models.ts'
import { alternateRoutingCode, buildRoutingCode, isRoutingCode, parseRoutingCode } from '../server/lib/qr.ts'
import { readOffice } from '../server/lib/office-input.ts'
import { assertManagerPlacement, canManageMember } from '../server/lib/team.ts'
import { processingTimeFor } from '../server/lib/knowledge.ts'
import { durationMinutes, extractProcessingTime, fitName, matchOffice, parseServiceList } from '../server/lib/charter.ts'
import { normalizeLayout } from '../server/lib/ai.ts'
import { roleMeta } from '../app/utils/format.ts'

afterEach(() => mock.restoreAll())

const ORG = 'org-1'
const CHO = { id: 'cho', org_id: ORG, name: 'City Health Office', code: 'CHO', parent_office_id: null, status: 'active' }
const SNTR = { id: 'sntr', org_id: ORG, name: 'Sanitation Division', code: 'CHO-SNTR', parent_office_id: 'cho', status: 'active' }
const HR = { id: 'hr', org_id: ORG, name: 'Human Resource Management Office', code: 'HRMO', parent_office_id: null, status: 'active' }
const person = (account_type: string, office: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
  ({ id: `${account_type}-${office?.id ?? 'none'}`, org_id: ORG, office_id: office?.id ?? null, office, account_type, status: 'active', page_access: null, ...extra }) as any

describe('dashed QR codes', () => {
  it('new codes read office-date-digits', () => {
    const code = buildRoutingCode('CHO-SNTR', new Date('2026-10-20T03:00:00Z'))
    assert.match(code, /^CHO-SNTR-102026-\d{6}$/)
    assert.equal(parseRoutingCode(code).officeCode, 'CHO-SNTR')
  })

  it('labels printed before still scan, with their office prefix', () => {
    assert.equal(parseRoutingCode('BAG-ADM-RECORDS100726123456').officeCode, 'BAG-ADM-RECORDS')
    assert.equal(parseRoutingCode('BCL-54967520').officeCode, 'BCL')
    assert.equal(parseRoutingCode('cho-102026-123456').code, 'CHO-102026-123456')
    assert.equal(isRoutingCode('CHO-10202-123456'), false)
  })

  it('a code typed with or without the dashes finds the same label', () => {
    assert.equal(alternateRoutingCode('CHO-SNTR-102026-123456'), 'CHO-SNTR102026123456')
    assert.equal(alternateRoutingCode('CHO-SNTR102026123456'), 'CHO-SNTR-102026-123456')
    assert.equal(alternateRoutingCode('BCL-54967520'), null)
  })
})

describe('umbrella offices', () => {
  it("an umbrella's code starts with its office's code; offices need no department", () => {
    assert.deepEqual(readOffice({ name: 'Sanitation', code: 'cho sntr' }, false, { parentCode: 'CHO' }).code, 'CHO-SNTR')
    assert.throws(() => readOffice({ name: 'Sanitation', code: 'SNTR' }, false, { parentCode: 'CHO' }), /starts with its office's code/)
    const office = readOffice({ name: 'City Health Office', code: 'CHO' }, false)
    assert.equal(office.department, undefined)
  })

  it("the office's Department Head manages its umbrellas' people and their head; nobody else's", () => {
    const head = person('DEPARTMENT_HEAD', CHO)
    assert.equal(canManageMember(head, person('STAFF', SNTR)), true)
    assert.equal(canManageMember(head, person('LIAISON', SNTR)), true)
    assert.equal(canManageMember(head, person('DEPARTMENT_HEAD', SNTR, { assigned_by: 'someone' })), true, "a delegated head of the umbrella")
    assert.equal(canManageMember(head, person('DEPARTMENT_HEAD', CHO, { id: 'other-head' })), false, 'another managing head of the same office')
    assert.equal(canManageMember(head, person('STAFF', HR)), false, 'another office')
    // The umbrella's own head manages its staff, but not its parent office or the parent's head.
    const umbrellaHead = person('DEPARTMENT_HEAD', SNTR)
    assert.equal(canManageMember(umbrellaHead, person('STAFF', SNTR, { id: 's2' })), true)
    assert.equal(canManageMember(umbrellaHead, person('STAFF', CHO)), false)
    assert.equal(canManageMember(umbrellaHead, head), false)
  })

  it('any number of Department Heads may be placed in an office or umbrella office (no "one head" rule)', async () => {
    const head = person('DEPARTMENT_HEAD', CHO)
    await assertManagerPlacement(head, 'DEPARTMENT_HEAD', SNTR as any)
    await assertManagerPlacement(head, 'DEPARTMENT_HEAD', CHO as any)
  })

  it('placement limits: no other offices, staff managers only in their own office', async () => {
    const head = person('DEPARTMENT_HEAD', CHO)
    await assert.rejects(() => assertManagerPlacement(head, 'STAFF', HR as any), /own office or its umbrella offices/)
    await assertManagerPlacement(head, 'STAFF', SNTR as any)
    await assertManagerPlacement(head, 'LIAISON', CHO as any)
    const staff = person('STAFF', CHO)
    await assert.rejects(() => assertManagerPlacement(staff, 'LIAISON', SNTR as any), /own office or its umbrella offices/)
  })
})

describe('document types by office', () => {
  const types = [
    { office_id: null, processing_days: 3, processing_hours: 0, processing_minutes: 0 },
    { office_id: 'cho', processing_days: 0, processing_hours: 2, processing_minutes: 30 },
  ]

  it("the uploader's office's type wins over the Global one of the same name; minutes count", async () => {
    mock.method(DocumentType, 'findAll', async () => types as any)
    mock.method(Office, 'findByPk', async (id: string) => ({ cho: CHO, sntr: SNTR, hr: HR })[id] as any)
    assert.deepEqual(await processingTimeFor(ORG, 'Payroll', undefined, 'cho'), { days: 0, hours: 2, minutes: 30 })
    // An umbrella office falls back to its parent office's type.
    assert.deepEqual(await processingTimeFor(ORG, 'Payroll', undefined, 'sntr'), { days: 0, hours: 2, minutes: 30 })
    // Another office, or the admin (no office), gets the Global one.
    assert.deepEqual(await processingTimeFor(ORG, 'Payroll', undefined, 'hr'), { days: 3, hours: 0, minutes: 0 })
    assert.deepEqual(await processingTimeFor(ORG, 'Payroll', undefined, null), { days: 3, hours: 0, minutes: 0 })
  })
})

describe("Citizen's Charter: List of Services", () => {
  // The layout of the Bago City charter's List of Services (pages 7–16), with its wrapping and footers.
  const LIST = normalizeLayout([
    [
      'V. LIST OF SERVICES',
      'City Mayor’s Office 15',
      'City Mayor’s Office - Administrative Division 17',
      'External Services 18',
      'Use of Government Facilities 24',
      'Securing a Mayor’s Certification/Clearance 26',
      'Internal Services 27',
      'Received and facilitate various requests like, letters, invitation, MOA, project proposals and',
      'other documents that required the approval, attention and action of the City Mayor. 28',
      'City Mayor’s Office - City Population Office 31',
      'External Services 32',
      'Pre-Marriage Counselling 34',
      'A. Traditional Transaction 34',
      'ANNEX “A” 51',
      '5',
    ].join('\n'),
    [
      'City Mayor’s Office - Bids and Awards Committee 131',
      'Internal Services 132',
      'Public Bidding & Alternative Mode of Procurement 133',
      'City Health Office 209',
      'External Services 210',
      'Issuance of Death Certificate 218',
      'City Budget Office 823',
      'Internal Services 824',
      'Certifying Obligation Request (ObRs): Purchase Request, Job Orders,',
      'Payroll and Payment Voucher 825',
      'Feedback and Complaints 911',
      'Contact Information 914',
    ].join('\n'),
  ])

  it('reads offices, divisions, External/Internal and wrapped names', () => {
    const rows = parseServiceList(LIST)
    assert.deepEqual(
      rows.map((r) => [r.office, r.category, r.name, r.page]),
      [
        ['City Mayor’s Office - Administrative Division', 'EXTERNAL', 'Use of Government Facilities', 24],
        ['City Mayor’s Office - Administrative Division', 'EXTERNAL', 'Securing a Mayor’s Certification/Clearance', 26],
        ['City Mayor’s Office - Administrative Division', 'INTERNAL', 'Received and facilitate various requests like, letters, invitation, MOA, project proposals and…', 28],
        ['City Mayor’s Office - City Population Office', 'EXTERNAL', 'Pre-Marriage Counselling', 34],
        ['City Mayor’s Office - City Population Office', 'EXTERNAL', 'Pre-Marriage Counselling — Traditional Transaction', 34],
        ['City Mayor’s Office - Bids and Awards Committee', 'INTERNAL', 'Public Bidding & Alternative Mode of Procurement', 133],
        ['City Health Office', 'EXTERNAL', 'Issuance of Death Certificate', 218],
        ['City Budget Office', 'INTERNAL', 'Certifying Obligation Request (ObRs): Purchase Request, Job Orders, Payroll and Payment Voucher', 825],
      ],
    )
    assert.equal(rows[0]!.division, 'Administrative Division')
    assert.equal(rows[0]!.parent_office, 'City Mayor’s Office')
  })

  it('long names fit the 100-character limit at a word', () => {
    const name = fitName('A '.repeat(80))
    assert.ok(name.length <= 100)
    assert.ok(name.endsWith('…'))
  })

  it("matches charter offices to FlowVision offices and umbrellas, or leaves them for the admin", () => {
    const offices = [
      { id: 'cmo', name: 'Office of the City Mayor', code: 'OCM', parent_office_id: null },
      { id: 'admin-div', name: 'Administrative Division', code: 'OCM-ADM', parent_office_id: 'cmo' },
      { id: 'cho', name: 'City Health Office', code: 'CHO', parent_office_id: null },
    ]
    assert.equal(matchOffice({ parent_office: 'City Mayor’s Office', division: 'Administrative Division' }, offices)?.id, 'admin-div')
    assert.equal(matchOffice({ parent_office: 'City Mayor’s Office', division: 'Library Section' }, offices)?.id, 'cmo')
    assert.equal(matchOffice({ parent_office: 'City Health Office', division: null }, offices)?.id, 'cho')
    assert.equal(matchOffice({ parent_office: 'City Veterinary Services', division: null }, offices), null)
  })
})

describe("Citizen's Charter: processing time", () => {
  it('reads the TOTAL line first', () => {
    const t = extractProcessingTime('1. Get a number | 5 minutes\n2. Dentist checks | 15 minutes\nTOTAL: 1 day and 30 minutes')!
    assert.deepEqual([t.basis, t.days, t.hours, t.mins], ['total', 1, 0, 30])
  })

  it('then a written processing time, then the sum of the step times', () => {
    assert.equal(extractProcessingTime('Processing time: 3 days')!.minutes, 3 * 8 * 60)
    const steps = extractProcessingTime('Proceed to admission | 15 minutes\nProceed to dental area | 5 minutes')!
    assert.deepEqual([steps.basis, steps.minutes], ['sum_of_steps', 20])
  })

  it('no time in the text: no suggestion (never an estimate)', () => {
    assert.equal(extractProcessingTime('Bring a valid ID.\nPay at the Treasurer’s Office.'), null)
    assert.equal(durationMinutes('no numbers here'), null)
  })

  it('a charter day follows the working day of the organization', () => {
    assert.equal(extractProcessingTime('TOTAL 2 days', 9)!.minutes, 2 * 9 * 60)
  })
})

describe('role labels for any account', () => {
  it('an account with a blank or unknown role shows "Unknown role" instead of breaking the page', () => {
    assert.equal(roleMeta('LIAISON').label, 'Messenger')
    assert.equal(roleMeta('').label, 'Unknown role')
    assert.equal(roleMeta(undefined).label, 'Unknown role')
  })
})
