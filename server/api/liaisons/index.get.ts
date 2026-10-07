import { Op } from 'sequelize'
import { sequelize, Document, Liaison, Office, User } from '~~/server/lib/models.ts'
import { liaisonWorkloadSql } from '~~/server/lib/document-queries.ts'
import { liaisonDto } from '~~/server/lib/serializers.ts'
import * as v from '~~/server/lib/validate.ts'

// Documents released to each messenger or in their hands right now (BUSY is derived from this).
const workloadAttr: any = [sequelize.literal(liaisonWorkloadSql('liaisons.user_id')), 'workload']

/**
 * Search messengers (B3). `?free=true` keeps only the ones that can take a document now:
 * on duty with nothing to pick up or deliver. Same-department, free messengers are listed first.
 * Each office has its own messengers: `?office_id=` lists one office's, and `?document_id=` the
 * ones that can carry that document from where it is now (its office's; any at the organization
 * origin of a CLIENT upload).
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT', 'EMPLOYEE', 'STAFF')
  const query = getQuery(event)
  const where: Record<string, unknown> = { org_id: user.org_id }
  const department = v.q(query, 'department')
  if (department) where.department = department
  if (query.available === 'true' || query.free === 'true') where.available = true

  const search = v.q(query, 'q')
  const userWhere: Record<string | symbol, unknown> = { status: { [Op.ne]: 'inactive' } }
  const documentId = v.q(query, 'document_id', 36)
  if (documentId) {
    const doc = await Document.findOne({ where: { id: documentId, org_id: user.org_id }, attributes: ['current_office_id'] })
    if (doc?.current_office_id) userWhere.office_id = doc.current_office_id
  }
  const officeId = v.q(query, 'office_id', 36)
  if (officeId) userWhere.office_id = officeId
  if (search) userWhere[Op.or] = ['first_name', 'last_name', 'full_name'].map((c) => ({ [c]: { [Op.like]: `%${search}%` } }))

  const liaisons = await Liaison.findAll({
    where,
    attributes: { include: [workloadAttr] },
    include: [{ model: User, as: 'user', where: userWhere, include: [{ model: Office, as: 'office' }] }],
  })

  const myDept = (user.office?.department ?? '').toLowerCase()
  const rank: Record<string, number> = { AVAILABLE: 0, BUSY: 1, OFF_DUTY: 2 }
  const data = liaisons
    .map((l) => liaisonDto(l, Number(l.get('workload') ?? 0))!)
    .filter((l) => query.free !== 'true' || l.availability === 'AVAILABLE')
    .sort(
      (a, b) =>
        rank[a.availability]! - rank[b.availability]! ||
        Number(b.department_code.toLowerCase() === myDept) - Number(a.department_code.toLowerCase() === myDept) ||
        b.success_rate - a.success_rate,
    )
  return { data }
})
