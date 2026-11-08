import { badRequest, conflict } from './errors.ts'

/**
 * Where a document originates, resolved on the server from the uploader's assigned office. Never from
 * the request: no endpoint accepts an origin office.
 *
 *   uploader in a main office      office = main office, unit = none
 *   uploader in an umbrella office office = the unit, main office = its parent, unit = the unit
 *   uploader without an office     no origin (an admin upload: it starts at the organization itself)
 *
 * documents.origin_office_id keeps `office`, as it was at first submission; the main office follows from
 * offices.parent_office_id. Origin is not location (documents.current_office_id) and it is not a route
 * step: an umbrella office stays outside the organization route.
 */
export interface OfficeFacts {
  id: string
  org_id: string
  name: string
  status: string
  parent_office_id?: string | null
}

export interface ResolvedOrigin {
  officeId: string
  mainOfficeId: string
  unitId: string | null
}

const invalid = () => conflict('Your office assignment is not valid, so this document can’t be submitted. Ask your administrator to check it.', 'ORIGIN_OFFICE_INVALID')
const inactive = (name: string) => conflict(`${name} is deactivated, so this document can’t be submitted from it. Ask your administrator to check your office.`, 'ORIGIN_OFFICE_INACTIVE')

/**
 * The origin for an uploader, given their assigned office and (for an umbrella office) its parent, as
 * loaded by the caller. Refuses an office relationship that doesn't hold; never repairs one.
 */
export function resolveOrigin(orgId: string, assignedOfficeId: string | null | undefined, office: OfficeFacts | null | undefined, parent: OfficeFacts | null | undefined): ResolvedOrigin | null {
  if (!assignedOfficeId) return null
  if (!office || office.id !== assignedOfficeId || office.org_id !== orgId) throw invalid()
  if (office.status === 'inactive') throw inactive(office.name)
  if (!office.parent_office_id) return { officeId: office.id, mainOfficeId: office.id, unitId: null }

  // One level only: the parent must be a main office of the same organization.
  if (!parent || parent.id !== office.parent_office_id || parent.org_id !== orgId || parent.parent_office_id) throw invalid()
  if (parent.status === 'inactive') throw inactive(parent.name)
  return { officeId: office.id, mainOfficeId: parent.id, unitId: office.id }
}

/**
 * An origin an administrator records by hand for a document whose origin wasn't recorded: the same rules as
 * resolveOrigin (an active office or umbrella office of the organization, one level deep), refused as a bad
 * `office_id`. An office of another organization looks the same as one that doesn't exist.
 */
export function checkRecordedOrigin(orgId: string, officeId: string, office: OfficeFacts | null | undefined, parent: OfficeFacts | null | undefined): ResolvedOrigin {
  const refuse = (message: string) => badRequest(message, { field: 'office_id' })
  if (!office || office.id !== officeId || office.org_id !== orgId) throw refuse('Pick an office of your organization')
  if (office.status === 'inactive') throw refuse(`${office.name} is deactivated. Reactivate it first, or pick another office.`)
  if (!office.parent_office_id) return { officeId: office.id, mainOfficeId: office.id, unitId: null }
  if (!parent || parent.id !== office.parent_office_id || parent.org_id !== orgId || parent.parent_office_id) throw refuse('That umbrella office’s main office is not valid')
  if (parent.status === 'inactive') throw refuse(`${parent.name} is deactivated. Reactivate it first, or pick another office.`)
  return { officeId: office.id, mainOfficeId: parent.id, unitId: office.id }
}
