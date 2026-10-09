import { Op } from 'sequelize'
import { AiConversation, AiMessage, sequelize, type Row } from './models.ts'
import { notFound } from './errors.ts'
import type { Actor } from './auth.ts'

// AI Assistant chat history. Conversations are private: every read and write is scoped to the
// user who started them, never just to the organization.

/** Oldest conversations beyond this many per user are dropped when a new one starts. */
export const MAX_CONVERSATIONS = 200

export interface StoredTool {
  name: string
  label: string
  summary?: string
  ok?: boolean
  /** findDocuments: the matches, shown under the answer as cards that open each document. */
  documents?: FoundDocument[]
}

/** A document the assistant found for the user (findDocuments), as the chat shows it. */
export interface FoundDocument {
  id: string
  title: string
  tracking_code: string | null
  status: string
  document_type: string | null
  submitted_at: string | null
  location: string | null
}

/** Only the fields the chat shows, from untrusted JSON (an import, or an older row). */
function cleanDocuments(list: unknown): FoundDocument[] | undefined {
  if (!Array.isArray(list)) return undefined
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 300) : null)
  const docs = list
    .filter((d) => d && typeof d === 'object' && typeof d.id === 'string' && /^[0-9a-f-]{36}$/.test(d.id) && typeof d.title === 'string')
    .slice(0, 25)
    .map((d) => ({ id: d.id, title: str(d.title)!, tracking_code: str(d.tracking_code), status: str(d.status) ?? '', document_type: str(d.document_type), submitted_at: str(d.submitted_at), location: str(d.location) }))
  return docs.length ? docs : undefined
}

export const titleFrom = (text: string) => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 60 ? `${t.slice(0, 57)}…` : t || 'New chat'
}

function parseTools(raw: string | null): StoredTool[] | undefined {
  if (!raw) return undefined
  try {
    const list = JSON.parse(raw)
    return Array.isArray(list) ? list.map((t) => ({ ...t, documents: cleanDocuments(t?.documents) })) : undefined
  } catch {
    return undefined
  }
}

export const serializeConversation = (c: Row) => ({
  id: c.id as string,
  title: c.title as string,
  createdAt: new Date(c.created_at).toISOString(),
  updatedAt: new Date(c.updated_at).toISOString(),
})

/** Same shape as the page's AssistantMessage. */
export const serializeMessage = (m: Row) => ({
  id: m.id as string,
  role: m.role as 'user' | 'assistant',
  content: m.content as string,
  at: new Date(m.created_at).toISOString(),
  model: (m.model as string | null) ?? undefined,
  tools: parseTools(m.tools)?.map((t) => ({ ...t, done: true })),
  error: m.is_error ? true : undefined,
  failed: m.failed ? true : undefined,
})

/** The actor's own conversation, or 404 (also for someone else's — its existence isn't revealed). */
export async function ownConversation(actor: Actor, id: unknown): Promise<Row> {
  if (typeof id !== 'string' || !id) throw notFound('Conversation')
  const convo = await AiConversation.findOne({ where: { id, user_id: actor.id } })
  if (!convo) throw notFound('Conversation')
  return convo
}

export async function createConversation(actor: Actor, title: string): Promise<Row> {
  const convo = await AiConversation.create({ org_id: actor.org_id, user_id: actor.id, title: titleFrom(title) })
  await pruneConversations(actor.id)
  return convo
}

/** Marks a conversation as used now, or at `at` (the list is sorted by it). */
export async function touchConversation(id: string, at?: Date) {
  if (at) await sequelize.query('UPDATE ai_conversations SET updated_at = ? WHERE id = ?', { replacements: [at, id] })
  else await sequelize.query('UPDATE ai_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', { replacements: [id] })
}

async function pruneConversations(userId: string) {
  const stale = await AiConversation.findAll({
    where: { user_id: userId },
    attributes: ['id'],
    order: [['updated_at', 'DESC']],
    offset: MAX_CONVERSATIONS,
  })
  if (stale.length) await AiConversation.destroy({ where: { id: { [Op.in]: stale.map((c) => c.id) } } })
}

/** Adds a message with an explicit millisecond timestamp, so thread order is never ambiguous. */
export async function addMessage(
  conversationId: string,
  m: { role: 'user' | 'assistant'; content: string; model?: string | null; tools?: StoredTool[]; isError?: boolean; at?: Date },
): Promise<Row> {
  return AiMessage.create({
    conversation_id: conversationId,
    role: m.role,
    content: m.content,
    model: m.model ?? null,
    tools: m.tools?.length ? JSON.stringify(m.tools.map(({ name, label, summary, ok, documents }) => ({ name, label, summary, ok, documents: cleanDocuments(documents) }))) : null,
    is_error: Boolean(m.isError),
    created_at: m.at ?? new Date(),
  })
}

/**
 * Retrying a question: removes the earlier unanswered copy and the error notices after it.
 * Anything that isn't this conversation's own question is ignored.
 */
export async function discardFailedQuestion(conversationId: string, questionId: unknown) {
  if (typeof questionId !== 'string' || !questionId) return
  const question = await AiMessage.findOne({ where: { id: questionId, conversation_id: conversationId, role: 'user' } })
  if (!question) return
  await AiMessage.destroy({
    where: {
      conversation_id: conversationId,
      created_at: { [Op.gte]: question.created_at },
      [Op.or]: [{ id: question.id }, { is_error: true }],
    },
  })
}

/** The turns the AI sees: newest `limit` messages that were answered, oldest first. */
export async function historyFor(conversationId: string, limit: number) {
  const rows = await AiMessage.findAll({
    where: { conversation_id: conversationId, is_error: false, failed: false },
    attributes: ['role', 'content'],
    order: [['created_at', 'DESC']],
    limit,
  })
  return rows.reverse().map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }))
}
