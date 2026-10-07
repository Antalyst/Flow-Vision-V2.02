import { Op, fn, col, literal } from 'sequelize'
import { Approval, Document, DocumentTracking, DocumentType, Issue, Liaison, Office, User } from './models.ts'
import { countActiveRoutes } from './routes.ts'
import { hasApprovalAuthority, type Actor } from './auth.ts'
import { deliveriesToday } from './liaisons.ts'
import { badRequest } from './errors.ts'
import { typeHours } from './knowledge.ts'
import { AT_OFFICE, CARRYING, documentDtos, liaisonDto, officeDto } from './serializers.ts'
import { carriedBy, documentAttributes, documentIncludes, hasOpenPickup, incomingTo, isReceived, noOpenPickup, notReceived, pickupsWhere, submittedFromOffice } from './document-queries.ts'

const ACTIVE = [...AT_OFFICE, ...CARRYING]

function startOfDayUtc(offsetDays = 0) {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d
}

export async function clientDashboard(user: Actor) {
  const org = user.org_id
  const [statusRows, overdue, avgRow, recent, routeCount, officeCount, team, openIssues, pendingApprovals] = await Promise.all([
    Document.findAll({ where: { org_id: org }, attributes: ['status', [fn('COUNT', col('id')), 'count']], group: ['status'], raw: true }) as unknown as Promise<
      Array<{ status: string; count: number }>
    >,
    Document.count({ where: { org_id: org, status: { [Op.in]: ACTIVE }, target_completion_date: { [Op.lt]: new Date() } } }),
    Document.findOne({
      where: { org_id: org, status: 'COMPLETED', completed_at: { [Op.ne]: null } },
      attributes: [[fn('AVG', literal('TIMESTAMPDIFF(MINUTE, submitted_at, completed_at) / 60')), 'hours']],
      raw: true,
    }) as unknown as Promise<{ hours: number | null } | null>,
    Document.findAll({ where: { org_id: org }, attributes: documentAttributes, include: documentIncludes, order: [['updated_at', 'DESC']], limit: 8 }),
    countActiveRoutes(org),
    Office.count({ where: { org_id: org, status: 'active' } }),
    User.findAll({ where: { org_id: org }, attributes: ['account_type', [fn('COUNT', col('id')), 'count']], group: ['account_type'], raw: true }) as unknown as Promise<
      Array<{ account_type: string; count: number }>
    >,
    Issue.count({ where: { status: { [Op.in]: ['OPEN', 'IN_PROGRESS'] } }, include: [{ model: Document, as: 'document', where: { org_id: org }, attributes: [] }] }),
    Approval.count({ where: { status: 'PENDING' }, distinct: true, col: 'document_id', include: [{ model: Document, as: 'document', where: { org_id: org }, attributes: [] }] }),
  ])
  const byStatus = Object.fromEntries(statusRows.map((r) => [r.status, Number(r.count)])) as Record<string, number>
  return {
    by_status: byStatus,
    totals: {
      active: ACTIVE.reduce((n, s) => n + (byStatus[s] ?? 0), 0),
      completed: byStatus.COMPLETED ?? 0,
      returned: byStatus.RETURNED ?? 0,
      drafts: byStatus.CREATED ?? 0,
      overdue,
      pending_approvals: pendingApprovals,
      open_issues: openIssues,
      offices: officeCount,
    },
    avg_completion_hours: avgRow?.hours == null ? null : Math.round(Number(avgRow.hours) * 10) / 10,
    team: Object.fromEntries(team.map((t) => [t.account_type, Number(t.count)])),
    routes: routeCount,
    recent: await documentDtos(recent),
  }
}

/**
 * The four headline cards of the client dashboard, for the whole organization or one office
 * (the office picked in the Forecasts filter):
 *   active      documents at the office now (moving on from it included)
 *   approvals   waiting for a final decision there
 *   completed   documents uploaded by the office's people that were approved — per document type
 *   overdue     past their target date while at the office
 */
export async function dashboardCards(user: Actor, officeId: string | null) {
  const org = user.org_id
  const office = officeId ? await Office.findOne({ where: { id: officeId, org_id: org }, attributes: ['id', 'name', 'code'] }) : null
  if (officeId && !office) throw badRequest('Unknown office', { field: 'office_id' })

  const here = office ? { current_office_id: office.id } : {}
  const fromOffice = office ? { [Op.and]: [submittedFromOffice(office.id)] } : {}
  const [active, overdue, pendingApprovals, byType, orgTypes, usedTypes] = await Promise.all([
    Document.count({ where: { org_id: org, status: { [Op.in]: ACTIVE }, ...here } }),
    Document.count({ where: { org_id: org, status: { [Op.in]: ACTIVE }, target_completion_date: { [Op.lt]: new Date() }, ...here } }),
    Approval.count({
      where: { status: 'PENDING', ...(office ? { office_id: office.id } : {}) },
      distinct: true,
      col: 'document_id',
      include: [{ model: Document, as: 'document', where: { org_id: org }, attributes: [] }],
    }),
    Document.findAll({
      where: { org_id: org, status: 'COMPLETED', ...fromOffice },
      attributes: [
        'category',
        [fn('COUNT', col('id')), 'count'],
        [fn('AVG', literal('CASE WHEN completed_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, submitted_at, completed_at) END')), 'minutes'],
      ],
      group: ['category'],
      raw: true,
    }) as unknown as Promise<Array<{ category: string | null; count: number; minutes: number | null }>>,
    DocumentType.findAll({ where: { org_id: org }, attributes: ['name', 'is_active', 'sort_order', 'processing_days', 'processing_hours'] }),
    // One office: the document types its people picked when uploading (any status).
    office
      ? (Document.findAll({ where: { org_id: org, ...fromOffice }, attributes: ['category'], group: ['category'], raw: true }) as unknown as Promise<Array<{ category: string | null }>>)
      : Promise.resolve([] as Array<{ category: string | null }>),
  ])

  // Every document type in scope — all the organization's (active) types, or the ones the office
  // uploaded with — plus any type a completed document carries, each with its completed count.
  const typeName = (c: string | null) => c || 'No type'
  const typeInfo = new Map(orgTypes.map((t) => [t.name as string, t]))
  const completedBy = new Map(byType.map((t) => [typeName(t.category), t]))
  const names = new Set<string>([
    ...(office ? usedTypes.map((u) => typeName(u.category)) : orgTypes.filter((t) => t.is_active).map((t) => t.name as string)),
    ...completedBy.keys(),
  ])
  const types = [...names]
    .map((name) => {
      const done = completedBy.get(name)
      const info = typeInfo.get(name)
      return {
        type: name,
        count: done ? Number(done.count) : 0,
        avg_minutes: done?.minutes == null ? null : Math.round(Number(done.minutes)),
        // The time Organization Settings allows for the type (0 = no limit).
        target_hours: info ? typeHours(info) : 0,
        sort: info ? Number(info.sort_order ?? 0) : Number.MAX_SAFE_INTEGER,
      }
    })
    .sort((a, b) => b.count - a.count || a.sort - b.sort || a.type.localeCompare(b.type))
    .map(({ sort: _sort, ...t }) => t)
  return {
    office: office ? { id: office.id as string, name: office.name as string, code: office.code as string } : null,
    active,
    pending_approvals: pendingApprovals,
    overdue,
    completed: { total: types.reduce((n, t) => n + t.count, 0), by_type: types },
  }
}

export async function officeDashboard(user: Actor) {
  const office = user.office_id as string | null
  if (!office) return { office: null }
  const base = { org_id: user.org_id, current_office_id: office }
  const atOffice = { [Op.in]: AT_OFFICE }

  const [awaitingReceipt, inProcess, awaitingPickup, outbound, incoming, receivedToday, documents] = await Promise.all([
    Document.count({ where: { ...base, status: atOffice, [Op.and]: [notReceived()] } }),
    Document.count({ where: { ...base, status: atOffice, [Op.and]: [isReceived(), noOpenPickup()] } }),
    Document.count({ where: { ...base, status: atOffice, [Op.and]: [hasOpenPickup()] } }),
    Document.count({ where: { ...base, status: { [Op.in]: CARRYING } } }),
    Document.count({ where: { org_id: user.org_id, status: { [Op.in]: CARRYING }, [Op.and]: [incomingTo(office)] } }),
    // Visits received here today (updated_at is the receipt — or a later change the same day).
    DocumentTracking.count({ where: { office_id: office, handler_id: { [Op.ne]: null }, updated_at: { [Op.gte]: startOfDayUtc() } } }),
    Document.findAll({
      where: { ...base, status: atOffice },
      attributes: documentAttributes,
      include: documentIncludes,
      order: [['priority', 'DESC'], ['updated_at', 'ASC']],
      limit: 20,
    }),
  ])

  const result: Record<string, unknown> = {
    office: officeDto(user.office),
    counts: { awaiting_receipt: awaitingReceipt, in_process: inProcess, awaiting_pickup: awaitingPickup, outbound, incoming, received_today: receivedToday },
    documents: await documentDtos(documents),
  }

  // The office's employees follow everything their staff upload (drafts excluded).
  if (user.account_type === 'EMPLOYEE') {
    const staffUploads = await Document.findAll({
      where: { org_id: user.org_id, submitted_by: { [Op.ne]: user.id }, status: { [Op.notIn]: ['CREATED', 'COMPLETED'] }, [Op.and]: [submittedFromOffice(office)] },
      attributes: documentAttributes,
      include: documentIncludes,
      order: [['updated_at', 'DESC']],
      limit: 10,
    })
    result.staff_uploads = await documentDtos(staffUploads)
  }

  if (user.account_type === 'STAFF') {
    const authority = hasApprovalAuthority(user)
    result.has_approval_authority = authority
    if (authority) {
      const since = startOfDayUtc(-7)
      const [pending, approved7d, returned7d] = await Promise.all([
        Approval.count({ where: { office_id: office, status: 'PENDING' }, distinct: true, col: 'document_id' }),
        Approval.count({ where: { office_id: office, status: 'APPROVED', approved_at: { [Op.gte]: since } } }),
        Approval.count({ where: { office_id: office, status: 'RETURNED', approved_at: { [Op.gte]: since } } }),
      ])
      result.approvals = { pending, approved_7d: approved7d, returned_7d: returned7d }
    }
  }
  return result
}

export async function liaisonDashboard(user: Actor) {
  const profile = await Liaison.findOne({ where: { user_id: user.id } })
  const [pickups, carrying] = await Promise.all([
    Document.count({ where: { org_id: user.org_id, ...pickupsWhere(user) } }),
    Document.count({ where: { status: { [Op.in]: CARRYING }, [Op.and]: [carriedBy(user.id)] } }),
  ])
  return {
    profile: liaisonDto(profile, pickups + carrying),
    counts: { available_pickups: pickups, carrying, delivered_today: deliveriesToday(profile) },
  }
}
