import { Op } from 'sequelize'
import { sequelize, Document, DocumentTracking, Liaison, Office } from '~~/server/lib/models.ts'
import { carriedBy, currentVisit, documentAttributes, documentIncludes, pickupsWhere, sendBackSql } from '~~/server/lib/document-queries.ts'
import { AT_OFFICE, CARRYING, documentDtos, liaisonDto, trackingNumber } from '~~/server/lib/serializers.ts'
import { readLog } from '~~/server/lib/tracking-log.ts'
import { notFound } from '~~/server/lib/errors.ts'
import * as v from '~~/server/lib/validate.ts'
import { applyQrPolicy } from '~~/server/lib/qr-access.ts'

const MY_EVENTS = new Set(['PICKED_UP', 'ARRIVED', 'DELIVERY_FAILED'])

/** D3: my profile, metrics, what I'm carrying and my pickups / deliveries since `since` (default: today). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'LIAISON')
  const profile = await Liaison.findOne({ where: { user_id: user.id } })
  if (!profile) throw notFound('Liaison profile')

  const since = v.q(getQuery(event), 'since', 30)
  const from = since && !Number.isNaN(Date.parse(since)) ? new Date(since) : (() => {
    const d = new Date()
    d.setUTCHours(0, 0, 0, 0)
    return d
  })()

  // Flagged documents going back to my office (or my office's parent office, for an umbrella office's
  // liaison) that nobody has claimed yet: any of us may claim them.
  const returnOffices = [user.office_id, user.office?.parent_office_id].filter(Boolean) as string[]
  const [carrying, pickups, visits, returns] = await Promise.all([
    Document.findAll({
      where: { status: { [Op.in]: CARRYING }, [Op.and]: [carriedBy(user.id)] },
      attributes: documentAttributes,
      include: documentIncludes,
      order: [['updated_at', 'DESC']],
    }),
    Document.count({ where: pickupsWhere(user) }),
    // Visits I touched: the ones I carried out of, or whose event log mentions me.
    DocumentTracking.findAll({
      where: { updated_at: { [Op.gte]: from }, [Op.or]: [{ liaison_id: user.id }, { notes: { [Op.like]: `%"by":"${user.id}"%` } }] },
      include: [
        { model: Document, as: 'document', attributes: ['id', 'title', 'priority', 'status'] },
        { model: Office, as: 'office', attributes: ['id', 'code', 'name'] },
      ],
      limit: 500,
    }),
    returnOffices.length
      ? Document.findAll({
          where: {
            org_id: user.org_id,
            status: { [Op.in]: AT_OFFICE },
            [Op.and]: [
              sequelize.literal(`${currentVisit('liaison_id')} IS NULL`),
              sequelize.literal(`${sendBackSql()} IN (${returnOffices.map((id) => sequelize.escape(`"${id}"`)).join(', ')})`),
            ],
          },
          attributes: documentAttributes,
          include: documentIncludes,
          order: [['updated_at', 'ASC']],
          limit: 50,
        })
      : [],
  ])

  const activity = visits
    .flatMap((visit) =>
      readLog(visit)
        .filter((e) => e.by === user.id && MY_EVENTS.has(e.type) && e.at >= from.toISOString())
        .map((e) => ({
          id: e.id,
          event_type: e.type,
          status_after: e.status,
          step_number: visit.step_number,
          remarks: e.remarks ?? null,
          metadata: e.meta ?? null,
          created_at: e.at,
          office: visit.office ? { id: visit.office.id, code: visit.office.code, name: visit.office.name } : null,
          document: visit.document
            ? { id: visit.document.id, tracking_number: trackingNumber(visit.document.id), title: visit.document.title, priority: visit.document.priority, status: visit.document.status }
            : null,
        })),
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 200)

  const count = (type: string) => activity.filter((e) => e.event_type === type).length
  return {
    profile: liaisonDto(profile, carrying.length + pickups),
    carrying: await applyQrPolicy(await documentDtos(carrying), user),
    // Return pickups I may claim (POST /documents/:id/return-claim). No QR code until I have it.
    returns: await applyQrPolicy(await documentDtos(returns), user),
    activity,
    today: { pickups: count('PICKED_UP'), deliveries: count('ARRIVED'), failed: count('DELIVERY_FAILED') },
  }
})
