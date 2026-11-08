/**
 * Origin resolution of a document (server/lib/document-origin.ts): no database, no running app.
 *
 *   npm run test:document-origin
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkRecordedOrigin, resolveOrigin, type OfficeFacts } from '../server/lib/document-origin.ts'

const ORG = 'org-1'
const main: OfficeFacts = { id: 'cho', org_id: ORG, name: 'City Health Office', status: 'active', parent_office_id: null }
const unit: OfficeFacts = { id: 'su', org_id: ORG, name: 'Sanitation Unit', status: 'active', parent_office_id: 'cho' }
const refused = (code: string) => (err: any) => err?.data?.code === code

describe('resolveOrigin', () => {
  it('main-office uploader: the office itself, no unit', () => {
    assert.deepEqual(resolveOrigin(ORG, 'cho', main, null), { officeId: 'cho', mainOfficeId: 'cho', unitId: null })
  })

  it('umbrella-office uploader: the unit, and its parent as the main office', () => {
    assert.deepEqual(resolveOrigin(ORG, 'su', unit, main), { officeId: 'su', mainOfficeId: 'cho', unitId: 'su' })
  })

  it('no assigned office (an admin upload): no origin is invented', () => {
    assert.equal(resolveOrigin(ORG, null, null, null), null)
  })

  it('an office that does not exist is refused', () => {
    assert.throws(() => resolveOrigin(ORG, 'gone', null, null), refused('ORIGIN_OFFICE_INVALID'))
  })

  it('an office that is not the assigned one is refused', () => {
    assert.throws(() => resolveOrigin(ORG, 'su', main, null), refused('ORIGIN_OFFICE_INVALID'))
  })

  it('cross-organization: an office of another organization is refused', () => {
    assert.throws(() => resolveOrigin('org-2', 'cho', main, null), refused('ORIGIN_OFFICE_INVALID'))
  })

  it('cross-organization: a parent in another organization is refused', () => {
    assert.throws(() => resolveOrigin(ORG, 'su', unit, { ...main, org_id: 'org-2' }), refused('ORIGIN_OFFICE_INVALID'))
  })

  it('a missing or wrong parent is refused, not treated as a main office', () => {
    assert.throws(() => resolveOrigin(ORG, 'su', unit, null), refused('ORIGIN_OFFICE_INVALID'))
    assert.throws(() => resolveOrigin(ORG, 'su', unit, { ...main, id: 'other' }), refused('ORIGIN_OFFICE_INVALID'))
  })

  it('a parent that is itself an umbrella office is refused (one level only)', () => {
    assert.throws(() => resolveOrigin(ORG, 'su', unit, { ...main, parent_office_id: 'x' }), refused('ORIGIN_OFFICE_INVALID'))
  })

  it('an inactive office or an inactive parent is refused', () => {
    assert.throws(() => resolveOrigin(ORG, 'cho', { ...main, status: 'inactive' }, null), refused('ORIGIN_OFFICE_INACTIVE'))
    assert.throws(() => resolveOrigin(ORG, 'su', { ...unit, status: 'inactive' }, main), refused('ORIGIN_OFFICE_INACTIVE'))
    assert.throws(() => resolveOrigin(ORG, 'su', unit, { ...main, status: 'inactive' }), refused('ORIGIN_OFFICE_INACTIVE'))
  })
})

describe('checkRecordedOrigin (an administrator records an older document’s origin)', () => {
  const badOffice = (err: any) => err?.data?.code === 'BAD_REQUEST' && err?.data?.details?.field === 'office_id'

  it('a main office: the office itself', () => {
    assert.deepEqual(checkRecordedOrigin(ORG, 'cho', main, null), { officeId: 'cho', mainOfficeId: 'cho', unitId: null })
  })

  it('an umbrella office: the unit, its parent as the main office', () => {
    assert.deepEqual(checkRecordedOrigin(ORG, 'su', unit, main), { officeId: 'su', mainOfficeId: 'cho', unitId: 'su' })
  })

  it('cross-organization: an office of another organization is refused like an unknown one', () => {
    assert.throws(() => checkRecordedOrigin('org-2', 'cho', main, null), badOffice)
    assert.throws(() => checkRecordedOrigin(ORG, 'gone', null, null), badOffice)
  })

  it('cross-organization: a parent in another organization is refused', () => {
    assert.throws(() => checkRecordedOrigin(ORG, 'su', unit, { ...main, org_id: 'org-2' }), badOffice)
  })

  it('a deactivated office or parent is refused', () => {
    assert.throws(() => checkRecordedOrigin(ORG, 'cho', { ...main, status: 'inactive' }, null), badOffice)
    assert.throws(() => checkRecordedOrigin(ORG, 'su', unit, { ...main, status: 'inactive' }), badOffice)
  })

  it('more than one level deep is refused', () => {
    assert.throws(() => checkRecordedOrigin(ORG, 'su', unit, { ...main, parent_office_id: 'x' }), badOffice)
  })
})
