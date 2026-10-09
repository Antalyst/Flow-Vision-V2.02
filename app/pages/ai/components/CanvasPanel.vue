<script setup lang="ts">
import type { CanvasDoc } from '~/utils/markdown'
import type { ExportFormat } from '~/composables/useCanvasExport'

const props = defineProps<{ canvases: CanvasDoc[]; activeId: string | null; open: boolean }>()
const emit = defineEmits<{ close: []; select: [id: string] }>()

const ui = useUiStore()
const { busy, exportCanvas } = useCanvasExport()
const docTemplates = useDocTemplates()
onMounted(() => docTemplates.load())

const active = computed(() => props.canvases.find((c) => c.id === props.activeId) ?? props.canvases.at(-1) ?? null)
const view = ref<'preview' | 'markdown'>('preview')
const html = computed(() => (active.value ? renderMarkdown(active.value.content) : ''))
const rowCount = computed(() => (active.value ? parseMarkdown(active.value.content).reduce((n, b) => n + (b.type === 'table' ? b.rows.length : 0), 0) : 0))

const EXPORTS: Array<{ format: ExportFormat; label: string; short: string; icon: string }> = [
  { format: 'docx', label: 'Export Word (.docx)', short: 'Word', icon: 'file-text' },
  { format: 'xlsx', label: 'Export Excel (.xlsx)', short: 'Excel', icon: 'grid' },
  { format: 'pdf', label: 'Export PDF (.pdf)', short: 'PDF', icon: 'file' },
]

// The template (letterhead) of each canvas: the AI's choice, or what the user picked here ('' = none).
const overrides = reactive<Record<string, string>>({})
const template = computed(() => (active.value ? docTemplates.templateFor(active.value, overrides[active.value.id]) : null))
const templateChoice = computed({
  get: () => (active.value ? (overrides[active.value.id] ?? template.value?.id ?? '') : ''),
  set: (id: string) => {
    if (active.value) overrides[active.value.id] = id
  },
})
const org = docTemplates.organization

const printing = ref(false)
/** Print the canvas as laid out on its template, with the FlowVision note. */
async function print() {
  if (!active.value || printing.value) return
  printing.value = true
  try {
    const [logo, signature] = await Promise.all([loadImage(template.value?.show_logo ? org.value.logo_url : null), loadImage(template.value?.signature_url)])
    const html = sheetHtml({
      title: active.value.title,
      bodyHtml: renderMarkdown(active.value.content),
      template: template.value,
      orgName: org.value.name,
      logoSrc: logo?.dataUrl ?? null,
      signatureSrc: signature?.dataUrl ?? null,
    })
    await printSheet(active.value.title, html)
  } catch (err) {
    console.error('[canvas] print failed', err)
    ui.error('Could not print', 'Try again, or export a PDF and print that.')
  } finally {
    printing.value = false
  }
}

async function runExport(format: ExportFormat) {
  if (!active.value) return
  try {
    await exportCanvas(active.value, format, { template: template.value, orgName: org.value.name, logoUrl: org.value.logo_url })
  } catch (err) {
    console.error('[canvas] export failed', err)
    ui.error('Export failed', 'The file could not be created. Try again, or copy the Markdown instead.')
  }
}

async function copyMarkdown() {
  if (!active.value) return
  try {
    await navigator.clipboard.writeText(active.value.content)
    ui.success('Copied', 'The canvas Markdown is on your clipboard.')
  } catch {
    ui.error('Copy failed', 'Your browser blocked clipboard access.')
  }
}

const closeBtn = ref<HTMLButtonElement>()
watch(
  () => props.open,
  (open) => open && nextTick(() => closeBtn.value?.focus()),
)
watch(() => props.activeId, () => (view.value = 'preview'))

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <Transition enter-active-class="transition-opacity duration-200" enter-from-class="opacity-0" leave-active-class="transition-opacity duration-150" leave-to-class="opacity-0">
      <div v-if="open && active" class="fixed inset-0 z-[60] bg-night/30 xl:bg-night/10" aria-hidden="true" @click="emit('close')" />
    </Transition>

    <Transition
      enter-active-class="transition-transform duration-300 ease-out"
      enter-from-class="translate-x-full"
      leave-active-class="transition-transform duration-200 ease-in"
      leave-to-class="translate-x-full"
    >
      <aside
        v-if="open && active"
        class="fixed inset-y-0 right-0 z-[61] flex w-full flex-col border-l border-line bg-cream shadow-lift sm:w-[min(780px,94vw)] sm:rounded-l-[2rem]"
        role="dialog"
        aria-modal="true"
        :aria-label="`Canvas: ${active.title}`"
      >
        <!-- Header -->
        <header class="border-b border-line/70 px-5 pt-5 pb-4 sm:px-7">
          <div class="flex items-start gap-3">
            <span class="grid size-10 shrink-0 place-items-center rounded-2xl" :class="active.type === 'table' ? TONE_CLASSES.info : TONE_CLASSES.primary">
              <FIcon :name="active.type === 'table' ? 'grid' : 'file-text'" :size="18" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="eyebrow mb-1.5">Canvas · {{ active.type === 'table' ? 'Table' : 'Document' }}<template v-if="rowCount"> · {{ rowCount }} row{{ rowCount === 1 ? '' : 's' }}</template></p>
              <h2 class="text-[19px] leading-snug break-words">{{ active.title }}</h2>
            </div>
            <button ref="closeBtn" class="grid size-10 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-ink/5 hover:text-ink" aria-label="Close canvas" @click="emit('close')">
              <FIcon name="x" :size="18" />
            </button>
          </div>

          <!-- Toolbar: view + exports -->
          <div class="mt-4 flex flex-wrap items-center gap-2">
            <div class="flex gap-1 rounded-full bg-ink/[0.04] p-1" role="tablist" aria-label="Canvas view">
              <button role="tab" class="tab min-h-8 px-3 text-[13px]" :class="view === 'preview' && 'tab-active'" :aria-selected="view === 'preview'" @click="view = 'preview'">
                <FIcon name="eye" :size="14" /> Preview
              </button>
              <button role="tab" class="tab min-h-8 px-3 text-[13px]" :class="view === 'markdown' && 'tab-active'" :aria-selected="view === 'markdown'" @click="view = 'markdown'">
                <FIcon name="code" :size="14" /> Markdown
              </button>
            </div>
            <div class="ml-auto flex flex-wrap items-center gap-1.5">
              <button
                v-for="x in EXPORTS"
                :key="x.format"
                class="btn btn-sm btn-ghost"
                :disabled="busy !== null"
                :title="x.label"
                :aria-label="x.label"
                @click="runExport(x.format)"
              >
                <FIcon :name="busy === x.format ? 'loader' : x.icon" :size="15" :class="busy === x.format && 'animate-spin'" />
                <span class="hidden sm:inline">Export</span> {{ x.short }}
              </button>
              <button class="btn btn-sm btn-ghost" :disabled="printing" :aria-busy="printing" title="Print" aria-label="Print" @click="print">
                <FIcon :name="printing ? 'loader' : 'printer'" :size="15" :class="printing && 'animate-spin'" /> <span class="hidden sm:inline">Print</span>
              </button>
              <button class="btn btn-sm btn-ghost px-2.5" title="Copy Markdown" aria-label="Copy Markdown" @click="copyMarkdown">
                <FIcon name="copy" :size="15" />
              </button>
            </div>
          </div>

          <!-- Letterhead: the template the AI chose; the user can switch it -->
          <div class="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
            <label for="canvas-template" class="flex items-center gap-1.5 text-ink-2"><FIcon name="layout" :size="14" /> Template</label>
            <select id="canvas-template" v-model="templateChoice" class="input h-9 min-h-0 w-auto max-w-full py-0 text-[13px]">
              <option value="">No letterhead</option>
              <option v-for="t in docTemplates.templates.value" :key="t.id" :value="t.id">{{ t.name }}{{ t.is_default ? ' (default)' : '' }}</option>
            </select>
            <span v-if="active.template && !overrides[active.id] && template" class="text-xs text-ink-2">Chosen by the assistant</span>
            <span v-else-if="!docTemplates.templates.value.length" class="text-xs text-ink-2">An administrator can add templates in Organization Settings.</span>
          </div>

          <!-- One tab per canvas in the conversation -->
          <nav v-if="canvases.length > 1" class="-mx-1 mt-3 flex gap-1 overflow-x-auto px-1 pb-0.5" aria-label="Canvases in this conversation">
            <button
              v-for="c in canvases"
              :key="c.id"
              class="flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] transition-colors"
              :class="c.id === active.id ? 'border-ink bg-ink text-white' : 'border-line bg-white/60 text-ink-body hover:border-ink/25'"
              :aria-current="c.id === active.id ? 'true' : undefined"
              @click="emit('select', c.id)"
            >
              <FIcon :name="c.type === 'table' ? 'grid' : 'file-text'" :size="13" />
              <span class="truncate">{{ c.title }}</span>
            </button>
          </nav>
        </header>

        <!-- Body -->
        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-7">
          <template v-if="view === 'preview'">
            <DocumentSheet v-if="template" :title="active.title" :markdown="active.content" :template="template" :org-name="org.name" :logo-url="template.show_logo ? org.logo_url : null" />
            <template v-else>
              <article class="fv-prose" v-html="html" />
              <p class="mt-8 border-t border-line/70 pt-3 text-center text-xs text-ink-2 italic">{{ FLOWVISION_NOTE }}</p>
            </template>
          </template>
          <pre v-else class="mono rounded-2xl border border-line bg-white/70 p-4 whitespace-pre-wrap text-ink-body">{{ active.content }}</pre>
        </div>

        <footer class="flex items-center gap-2 border-t border-line/70 px-5 py-3 text-xs text-ink-2 sm:px-7">
          <FIcon name="shield" :size="14" />
          Built from live FlowVision data your account may see. Review it before sharing. Prints and exports note that it was created with FlowVision.
        </footer>
      </aside>
    </Transition>
  </Teleport>
</template>
