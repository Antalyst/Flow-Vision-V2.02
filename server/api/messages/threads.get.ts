import { Op, QueryTypes } from 'sequelize'
import { sequelize, Document, Message, Office, User, type Row } from '~~/server/lib/models.ts'
import { senderInclude } from '~~/server/lib/messages.ts'
import { messageDto, trackingNumber, userSummary } from '~~/server/lib/serializers.ts'

/** B4 sidebar: direct conversations, office channel and document threads I'm part of. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const me = user.id

  // Latest message per direct partner, plus my unread count from them.
  const directRows = await sequelize.query<{ partner_id: string; last_at: string; unread: number }>(
    `SELECT partner_id, MAX(created_at) AS last_at, SUM(unread) AS unread
       FROM (SELECT created_at,
                    CASE WHEN sender_id = :me THEN recipient_id ELSE sender_id END AS partner_id,
                    CASE WHEN recipient_id = :me AND is_read = 0 THEN 1 ELSE 0 END AS unread
               FROM messages
              WHERE conversation_type = 'DIRECT' AND (sender_id = :me OR recipient_id = :me)) m
      WHERE partner_id IS NOT NULL
      GROUP BY partner_id
      ORDER BY last_at DESC
      LIMIT 50`,
    { replacements: { me }, type: QueryTypes.SELECT },
  )

  // Document threads I wrote in, or for documents I submitted / that are at my office.
  const docRows = await sequelize.query<{ document_id: string; last_at: string }>(
    `SELECT m.document_id, MAX(m.created_at) AS last_at
       FROM messages m JOIN documents d ON d.id = m.document_id
      WHERE m.conversation_type = 'GROUP' AND d.org_id = :org
        AND (m.document_id IN (SELECT document_id FROM messages WHERE sender_id = :me AND conversation_type = 'GROUP')
             OR d.submitted_by = :me OR (:office IS NOT NULL AND d.current_office_id = :office))
      GROUP BY m.document_id
      ORDER BY last_at DESC
      LIMIT 30`,
    { replacements: { me, org: user.org_id, office: user.office_id ?? null }, type: QueryTypes.SELECT },
  )

  const [partners, docs, directLast, docLast] = await Promise.all([
    directRows.length
      ? User.findAll({ where: { id: { [Op.in]: directRows.map((r) => r.partner_id) }, org_id: user.org_id }, include: [{ model: Office, as: 'office' }] })
      : [],
    docRows.length ? Document.findAll({ where: { id: { [Op.in]: docRows.map((r) => r.document_id) } }, attributes: ['id', 'title', 'status'] }) : [],
    // Last message of each conversation (latest first; first hit per key wins).
    directRows.length
      ? Message.findAll({
          where: {
            conversation_type: 'DIRECT',
            [Op.or]: directRows.flatMap((r) => [
              { sender_id: me, recipient_id: r.partner_id },
              { sender_id: r.partner_id, recipient_id: me },
            ]),
          },
          include: [senderInclude],
          order: [['created_at', 'DESC']],
          limit: 500,
        })
      : [],
    docRows.length
      ? Message.findAll({
          where: { conversation_type: 'GROUP', document_id: { [Op.in]: docRows.map((r) => r.document_id) } },
          include: [senderInclude],
          order: [['created_at', 'DESC']],
          limit: 500,
        })
      : [],
  ])

  const firstBy = (rows: Row[], key: (m: Row) => string) => {
    const map = new Map<string, Row>()
    for (const m of rows) if (!map.has(key(m))) map.set(key(m), m)
    return map
  }
  const lastDirect = firstBy(directLast, (m) => (m.sender_id === me ? m.recipient_id : m.sender_id))
  const lastDoc = firstBy(docLast, (m) => m.document_id)
  const partnerById = new Map(partners.map((p) => [p.id, p]))
  const docById = new Map(docs.map((d) => [d.id, d]))

  return {
    direct: directRows
      .filter((r) => partnerById.has(r.partner_id))
      .map((r) => {
        const last = lastDirect.get(r.partner_id)
        return { user: userSummary(partnerById.get(r.partner_id)), last_message: last ? messageDto(last) : null, unread: Number(r.unread) }
      }),
    documents: docRows
      .filter((r) => docById.has(r.document_id))
      .map((r) => {
        const d = docById.get(r.document_id)!
        const last = lastDoc.get(r.document_id)
        return { document: { id: d.id, tracking_number: trackingNumber(d.id), title: d.title, status: d.status }, last_message: last ? messageDto(last) : null }
      }),
    office: user.office ? { id: user.office.id, name: user.office.name } : null,
  }
})
