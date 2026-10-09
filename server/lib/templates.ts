import { DocumentTemplate, type Row } from './models.ts'
import { badRequest } from './errors.ts'
import { imageKey, imageVersion } from './org-assets.ts'
import { isMissingTable, settingsUnavailable } from './work-calendar.ts'
import * as v from './validate.ts'

/**
 * Document templates (Organization Settings): the letterhead a formal document drafted by the AI
 * is laid out on — the organization logo, header lines, a signature block (name, position and an
 * optional signature image) and a footer. The AI reads each template's name and description to
 * choose one for a canvas (<canvas template="…">) and follows its body guide; the browser then
 * draws the letterhead around the text for preview, print and export. An organization can keep
 * several (memorandum, letter, certification…); one may be the default.
 */

export function templateDto(t: Row) {
  const version = imageVersion(t.signature_url)
  return {
    id: t.id as string,
    name: t.name as string,
    description: (t.description as string | null) ?? null,
    show_logo: Boolean(t.show_logo),
    header_text: (t.header_text as string | null) ?? null,
    body_guide: (t.body_guide as string | null) ?? null,
    signatory_name: (t.signatory_name as string | null) ?? null,
    signatory_title: (t.signatory_title as string | null) ?? null,
    signature_url: imageKey(t.signature_url) ? `/api/org/templates/${t.id}/signature?v=${version}` : null,
    footer_text: (t.footer_text as string | null) ?? null,
    is_default: Boolean(t.is_default),
    is_active: Boolean(t.is_active),
    sort_order: Number(t.sort_order ?? 0),
  }
}

/** The organization's templates in their order (active ones only for the AI and the canvas). [] while the table doesn't exist. */
export async function listTemplates(orgId: string, { activeOnly = false } = {}) {
  try {
    return await DocumentTemplate.findAll({
      where: { org_id: orgId, ...(activeOnly && { is_active: true }) },
      order: [['sort_order', 'ASC'], ['name', 'ASC']],
    })
  } catch (err) {
    if (!isMissingTable(err)) throw err
    settingsUnavailable()
    return []
  }
}

/** Template fields from a request body; `partial` (an edit) only reads the fields sent. */
export function readTemplateInput(body: Record<string, unknown>, partial: boolean) {
  const out: Record<string, unknown> = {}
  const has = (field: string) => !partial || field in body
  if (has('name')) out.name = v.reqStr(body, 'name', { max: 100, label: 'Name' })
  if (has('description')) out.description = v.str(body, 'description', { max: 500 })
  if (has('header_text')) out.header_text = v.str(body, 'header_text', { max: 1000, label: 'Header' })
  if (has('body_guide')) out.body_guide = v.str(body, 'body_guide', { max: 3000, label: 'Body guide' })
  if (has('signatory_name')) out.signatory_name = v.str(body, 'signatory_name', { max: 150, label: 'Signatory name' })
  if (has('signatory_title')) out.signatory_title = v.str(body, 'signatory_title', { max: 150, label: 'Signatory position' })
  if (has('footer_text')) out.footer_text = v.str(body, 'footer_text', { max: 500, label: 'Footer' })
  if (has('show_logo')) out.show_logo = body.show_logo === undefined ? true : Boolean(body.show_logo)
  if ('is_default' in body) out.is_default = Boolean(body.is_default)
  if ('is_active' in body) out.is_active = Boolean(body.is_active)
  if ('sort_order' in body) {
    const n = Number(body.sort_order)
    if (!Number.isInteger(n) || n < 0) throw badRequest('sort_order must be a whole number', { field: 'sort_order' })
    out.sort_order = n
  }
  return out
}

/** Ready-made templates a CLIENT can start from (Organization Settings › Templates). */
export function starterTemplates(orgName: string) {
  const header = `Republic of the Philippines\n${orgName}`
  return [
    {
      name: 'Memorandum',
      description: 'Internal memos and office orders to staff or other offices.',
      header_text: header,
      body_guide: '**MEMORANDUM**\n\n**TO:** …\n**FROM:** …\n**DATE:** …\n**SUBJECT:** …\n\n---\n\nBody in short paragraphs. End with the action expected and its deadline.',
      is_default: true,
    },
    {
      name: 'Official Letter',
      description: 'Formal letters to people or organizations outside the office: requests, replies, invitations, endorsements.',
      header_text: header,
      body_guide: 'Date, then the recipient’s name, position and address. Salutation (Dear …:). Body in formal paragraphs. Closing (Very truly yours,).',
      is_default: false,
    },
    {
      name: 'Report',
      description: 'Status, summary and activity reports with figures and tables.',
      header_text: header,
      body_guide: '## Summary\nTwo or three sentences.\n\n## Details\nTables and findings.\n\n## Recommendations\nNumbered list.',
      is_default: false,
    },
  ]
}

/**
 * The templates as the AI sees them in its instructions: name, when to use it, and a short body
 * guide — kept brief, the free models allow few tokens a minute.
 */
export async function templateCatalog(orgId: string) {
  const templates = await listTemplates(orgId, { activeOnly: true })
  return templates.slice(0, 10).map((t) => ({
    name: t.name as string,
    description: (t.description as string | null) ?? null,
    guide: t.body_guide ? String(t.body_guide).replace(/\s+/g, ' ').slice(0, 260) : null,
    is_default: Boolean(t.is_default),
  }))
}
