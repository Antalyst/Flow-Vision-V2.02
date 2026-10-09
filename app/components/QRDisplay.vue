<script setup lang="ts">
import type { DocumentFileInfo, FlowDocument, QrInfo } from '~/types'

const props = withDefaults(
  defineProps<{
    qr: QrInfo
    doc: Pick<FlowDocument, 'id' | 'tracking_number' | 'title' | 'file_name'>
    /** All of the document's files (bulk uploads have several); they print before the QR page. */
    files?: DocumentFileInfo[]
    canRegenerate?: boolean
  }>(),
  { canRegenerate: false, files: () => [] },
)
const emit = defineEmits<{ regenerated: [qr: QrInfo] }>()

const { printLabel, printWithDocument, regenerate } = useQR()
const retired = computed(() => props.qr.status === 'COMPLETED')
const { busy, run } = useAction()
const ui = useUiStore()

async function copy() {
  try {
    await navigator.clipboard.writeText(props.qr.payload)
    ui.success('QR payload copied')
  } catch {
    ui.error('Could not copy', 'Select the text and copy it manually.')
  }
}

async function reissue() {
  await ui.confirm({
    title: 'Replace this QR label?',
    body: 'The current label will stop working, so print and attach the new one.',
    confirmLabel: 'Replace label',
    busyLabel: 'Issuing…',
    icon: 'refresh-cw',
    action: async () => {
      const res = await run('regen', () => regenerate(props.doc.id), 'New QR issued — the old label no longer works')
      if (res) emit('regenerated', res.qr)
    },
  })
}
</script>

<template>
  <!-- A completed document's label is retired: scanning it only says the document is complete. -->
  <div v-if="retired" class="flex flex-col items-center text-center">
    <div class="relative rounded-2xl border border-line bg-white p-3">
      <div class="size-36 opacity-20 grayscale [&>svg]:size-full" aria-hidden="true" v-html="qr.svg" />
      <span class="absolute inset-0 grid place-items-center">
        <span class="inline-flex items-center gap-1.5 rounded-full bg-sage px-3 py-1.5 text-[13px] font-semibold text-white shadow-sm"><FIcon name="check" :size="14" :stroke="2.5" /> Completed</span>
      </span>
    </div>
    <p class="mono mt-4 text-sm text-ink-2 line-through decoration-ink-3">{{ qr.payload }}</p>
    <p class="mt-3 text-[13px] text-ink-body">This document is complete, so its QR label no longer works. Scanning it only shows that the document is already complete.</p>
  </div>

  <!-- Always stacked: it lives in the narrow sidebar of the document page. -->
  <div v-else class="flex flex-col items-center text-center">
    <div class="rounded-2xl border border-line bg-white p-3 shadow-sm">
      <div class="size-44 [&>svg]:size-full" v-html="qr.svg" />
    </div>
    <p class="eyebrow mt-4">Document QR</p>
    <button class="mono mt-1.5 inline-flex max-w-full items-center gap-2 rounded-lg bg-ink/[0.04] px-3 py-1.5 text-base font-semibold hover:bg-ink/[0.07]" title="Copy code" @click="copy">
      <span class="break-all">{{ qr.payload }}</span> <FIcon name="copy" :size="14" class="shrink-0 text-ink-2" />
    </button>
    <p class="mt-3 text-[13px] text-ink-body">Keep it with the paper the whole way: the messenger scans it to pick up, and each office scans it to receive.</p>
    <div class="mt-4 flex w-full flex-col gap-2">
      <button v-if="files.length || doc.file_name" class="btn btn-primary w-full justify-center" @click="printWithDocument(qr, doc, files)"><FIcon name="printer" :size="16" /> {{ files.length > 1 ? `Print all ${files.length} files + QR` : 'Print document + QR' }}</button>
      <button class="btn w-full justify-center" :class="files.length || doc.file_name ? 'btn-ghost' : 'btn-primary'" @click="printLabel(qr, doc)"><FIcon name="tag" :size="16" /> Print label only</button>
      <button v-if="canRegenerate" class="btn btn-ghost w-full justify-center" :disabled="busy === 'regen'" :aria-busy="busy === 'regen'" @click="reissue">
        <FIcon name="refresh-cw" :size="16" /> Replace label
      </button>
    </div>
  </div>
</template>
