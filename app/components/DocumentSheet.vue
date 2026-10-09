<script setup lang="ts">
import type { SheetTemplate } from '~/utils/letterhead'

/**
 * A document laid out on its template's letterhead, like the printed page: logo and header lines,
 * body, signature block, footer and the "created with FlowVision" note. Same HTML as printing.
 */
const props = defineProps<{
  title: string
  /** Body as Markdown. */
  markdown: string
  template: SheetTemplate | null
  orgName: string
  logoUrl: string | null
  /** Overrides the template's signature (e.g. an image picked but not uploaded yet). */
  signatureSrc?: string | null
}>()

useHead({ style: [{ key: 'fv-sheet', innerHTML: SHEET_CSS }] })

const html = computed(() =>
  sheetHtml({
    title: props.title,
    bodyHtml: renderMarkdown(props.markdown),
    template: props.template,
    orgName: props.orgName,
    logoSrc: props.logoUrl,
    signatureSrc: props.signatureSrc !== undefined ? props.signatureSrc : (props.template?.signature_url ?? null),
  }),
)
</script>

<template>
  <div class="overflow-hidden rounded-xl border border-line bg-white px-6 py-7 shadow-soft sm:px-10 sm:py-10" v-html="html" />
</template>
