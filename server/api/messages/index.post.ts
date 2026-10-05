import { Document, Message, User } from '~~/server/lib/models.ts'
import { senderInclude } from '~~/server/lib/messages.ts'
import { messageDto } from '~~/server/lib/serializers.ts'
import { emit } from '~~/server/lib/realtime.ts'
import { badRequest, forbidden } from '~~/server/lib/errors.ts'
import * as v from '~~/server/lib/validate.ts'

// API thread types → messages.conversation_type
const CONVERSATION = { DIRECT: 'DIRECT', DOCUMENT: 'GROUP', OFFICE: 'OFFICE' } as const

export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readJson(event)
  const threadType = v.oneOf(body, 'thread_type', ['DIRECT', 'DOCUMENT', 'OFFICE'] as const, { required: true })!
  const content = v.reqStr(body, 'body', { max: 4000, label: 'Message' })
  const record: Record<string, unknown> = { conversation_type: CONVERSATION[threadType], sender_id: user.id, content }
  let topics: string[]

  if (threadType === 'DIRECT') {
    const recipient = await User.findOne({ where: { id: String(body.recipient_id ?? ''), org_id: user.org_id }, attributes: ['id', 'status'] })
    if (!recipient || recipient.status === 'inactive') throw badRequest('Recipient not found')
    if (recipient.id === user.id) throw badRequest('You cannot message yourself')
    record.recipient_id = recipient.id
    topics = [`user:${recipient.id}`, `user:${user.id}`]
  } else if (threadType === 'DOCUMENT') {
    const doc = await Document.findOne({ where: { id: String(body.document_id ?? ''), org_id: user.org_id }, attributes: ['id'] })
    if (!doc) throw badRequest('Document not found')
    record.document_id = doc.id
    topics = [`doc:${doc.id}`]
  } else {
    if (!user.office_id) throw forbidden('You are not assigned to an office')
    topics = [`office:${user.office_id}`]
  }

  const created = await Message.create(record)
  const message = messageDto((await Message.findByPk(created.id, { include: [senderInclude] }))!)
  emit(topics, 'message', message)
  setResponseStatus(event, 201)
  return { message }
})
