<script setup lang="ts">
import type { FlowDocument, QrInfo } from '~/types'

const props = withDefaults(
  defineProps<{ qr: QrInfo; doc: Pick<FlowDocument, 'id' | 'tracking_number' | 'title' | 'file_name'>; canRegenerate?: boolean }>(),
  { canRegenerate: false },
)
const emit = defineEmits<{ regenerated: [qr: QrInfo] }>()

const { printLabel, printWithDocument, regenerate } = useQR()
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
  if (!confirm('Replace this QR label? The current label will stop working, so print and attach the new one.')) return
  const res = await run('regen', () => regenerate(props.doc.id), 'New QR issued — the old label no longer works')
  if (res) emit('regenerated', res.qr)
}
</script>

<template>
  <!-- Always stacked: it lives in the narrow sidebar of the document page. -->
  <div class="flex flex-col items-center text-center">
    <div class="rounded-2xl border border-line bg-white p-3 shadow-sm">
      <div class="size-44 [&>svg]:size-full" v-html="qr.svg" />
    </div>
    <p class="eyebrow mt-4">Document QR</p>
    <button class="mono mt-1.5 inline-flex max-w-full items-center gap-2 rounded-lg bg-ink/[0.04] px-3 py-1.5 text-base font-semibold hover:bg-ink/[0.07]" title="Copy code" @click="copy">
      <span class="break-all">{{ qr.payload }}</span> <FIcon name="copy" :size="14" class="shrink-0 text-ink-2" />
    </button>
    <p class="mt-3 text-[13px] text-ink-body">Keep it with the paper the whole way: the messenger scans it to pick up, and each office scans it to receive.</p>
    <div class="mt-4 flex w-full flex-col gap-2">
      <button v-if="doc.file_name" class="btn btn-primary w-full justify-center" @click="printWithDocument(qr, doc)"><FIcon name="printer" :size="16" /> Print document + QR</button>
      <button class="btn w-full justify-center" :class="doc.file_name ? 'btn-ghost' : 'btn-primary'" @click="printLabel(qr, doc)"><FIcon name="tag" :size="16" /> Print label only</button>
      <button v-if="canRegenerate" class="btn btn-ghost w-full justify-center" :disabled="busy === 'regen'" @click="reissue">
        <FIcon name="refresh-cw" :size="16" /> Replace label
      </button>
    </div>
  </div>
</template>
