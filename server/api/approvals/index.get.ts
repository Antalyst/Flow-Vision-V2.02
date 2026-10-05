import { Op } from 'sequelize'
import { Approval, Document, Office, User } from '~~/server/lib/models.ts'
import { hasApprovalAuthority } from '~~/server/lib/auth.ts'
import { pendingApprovalsFor } from '~~/server/lib/documents.ts'
import { documentAttributes, documentIncludes, userAttrs } from '~~/server/lib/document-queries.ts'
import { approvalDto, documentDtos } from '~~/server/lib/serializers.ts'
import * as v from '~~/server/lib/validate.ts'

/** PENDING: documents waiting for my decision. APPROVED / RETURNED: my office's decisions. */
export default defineApiHandler(async (event) => {
  const user = await requireOfficeUser(event, 'STAFF')
  if (!hasApprovalAuthority(user)) return { data: [], has_approval_authority: false }

  const status = v.oneOf(getQuery(event), 'status', ['PENDING', 'APPROVED', 'RETURNED'] as const, { fallback: 'PENDING' })!
  const approvals =
    status === 'PENDING'
      ? await pendingApprovalsFor(user)
      : await Approval.findAll({
          where: { office_id: user.office_id, status },
          include: [
            { model: User, as: 'staff', attributes: userAttrs },
            { model: Office, as: 'office', attributes: ['id', 'code', 'name'] },
          ],
          order: [['approved_at', 'DESC']],
          limit: 100,
        })

  const docs = approvals.length
    ? await Document.findAll({ where: { id: { [Op.in]: approvals.map((a) => a.document_id) } }, attributes: documentAttributes, include: documentIncludes })
    : []
  const dtos = await documentDtos(docs)
  const byId = new Map(dtos.map((d) => [d.id, d]))
  return { data: approvals.map((a) => approvalDto(a, byId.get(a.document_id))), has_approval_authority: true }
})
