import type { DocumentTemplateItem } from '~/types'
import type { CanvasDoc } from '~/utils/markdown'

interface TemplatesData {
  organization: { name: string; logo_url: string | null }
  templates: DocumentTemplateItem[]
}

/**
 * The organization's document templates (Organization Settings › Templates), for laying out AI
 * canvases: loaded once per visit to the assistant, shared by the canvas panel and its exports.
 */
export function useDocTemplates() {
  const state = useState<TemplatesData | null>('doc-templates', () => null)
  const loading = useState('doc-templates-loading', () => false)

  async function load(force = false) {
    if ((state.value && !force) || loading.value) return
    loading.value = true
    try {
      state.value = await useApi().get<TemplatesData>('/org/templates')
    } catch {
      // Without templates a canvas still shows, prints and exports, just without a letterhead.
      state.value ??= { organization: { name: useAuthStore().user?.organization?.name ?? '', logo_url: null }, templates: [] }
    } finally {
      loading.value = false
    }
  }

  const templates = computed(() => state.value?.templates ?? [])
  const organization = computed(() => state.value?.organization ?? { name: useAuthStore().user?.organization?.name ?? '', logo_url: null })

  /**
   * The template a canvas is laid out on: the one picked in the panel (`override`: an id, or ''
   * for none), else the one the AI named, else — for a document — the default template.
   */
  function templateFor(canvas: CanvasDoc, override?: string | null): DocumentTemplateItem | null {
    if (override === '') return null
    if (override) return templates.value.find((t) => t.id === override) ?? null
    const named = canvas.template?.toLowerCase()
    const byName = named ? templates.value.find((t) => t.name.toLowerCase() === named) : null
    if (byName) return byName
    return canvas.type === 'document' ? (templates.value.find((t) => t.is_default) ?? null) : null
  }

  return { load, templates, organization, templateFor }
}
