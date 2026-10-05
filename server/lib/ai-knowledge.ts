import { KnowledgeFile } from './models.ts'
import { wordsOf } from './knowledge.ts'

/**
 * The assistant's view of the organization's knowledge files (Organization Settings). Every role
 * reads the same library: active files whose text was extracted, in the user's own organization.
 */
const usableFiles = (orgId: string) => ({ org_id: orgId, is_active: true, status: 'READY' as const })

// Chunks overlap so a rule split across a boundary is still found whole in one of them.
const CHUNK = 1400
const OVERLAP = 200
// ≈ 1,500 tokens of passages per search — keeps a full tool round inside Groq's per-minute limits.
const DEFAULT_BUDGET = 6000

export interface KnowledgePassage {
  source: string
  text: string
}

/** Titles and descriptions only, for the system prompt: the AI knows what it can search. */
export async function knowledgeCatalog(orgId: string) {
  const files = await KnowledgeFile.findAll({
    where: usableFiles(orgId),
    attributes: ['title', 'description'],
    order: [['title', 'ASC']],
    limit: 40,
  })
  return files.map((f) => ({ title: String(f.title), description: f.description ? String(f.description).slice(0, 200) : null }))
}

/**
 * Passages from the organization's knowledge files that best answer `query`. Each file is cut
 * into overlapping chunks; a chunk scores one point per distinct query word it contains (two when
 * the word is in the file title too), and the best chunks are returned up to `budget` characters.
 */
export async function searchKnowledge(orgId: string, query: string, budget = DEFAULT_BUDGET) {
  const files = await KnowledgeFile.findAll({ where: usableFiles(orgId), attributes: ['title', 'content'] })
  const terms = [...new Set(wordsOf(query))]
  if (!files.length) return { files_searched: 0, passages: [] as KnowledgePassage[] }
  if (!terms.length) return { files_searched: files.length, passages: [] as KnowledgePassage[] }

  const scored: Array<KnowledgePassage & { score: number }> = []
  for (const f of files) {
    const title = String(f.title)
    const titleWords = new Set(wordsOf(title))
    const content = String(f.content ?? '')
    for (let i = 0; i < content.length; i += CHUNK - OVERLAP) {
      const text = content.slice(i, i + CHUNK)
      const words = new Set(wordsOf(text))
      let score = 0
      for (const t of terms) if (words.has(t)) score += titleWords.has(t) ? 2 : 1
      if (score > 0) scored.push({ score, source: title, text: text.trim() })
      if (i + CHUNK >= content.length) break
    }
  }
  scored.sort((a, b) => b.score - a.score)

  const passages: KnowledgePassage[] = []
  let used = 0
  for (const { source, text } of scored) {
    if (used + text.length > budget) break
    passages.push({ source, text })
    used += text.length
  }
  return { files_searched: files.length, passages }
}
