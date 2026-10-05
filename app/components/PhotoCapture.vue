<script setup lang="ts">
import type { CapturedPage } from '~/utils/photo-pdf'

/**
 * "Take a picture" for the upload form: photograph a paper document page by page with the
 * device camera (or the phone's camera app), review the pages, and hand back one file —
 * a JPEG for one page, a PDF with a page per photo for several.
 */
const props = defineProps<{
  open: boolean
  maxBytes: number
  /** Bulk upload: hand back every photo as its own file instead of joining them. */
  separate?: boolean
}>()
const emit = defineEmits<{ close: []; done: [files: File[], pages: number] }>()

const ui = useUiStore()
const video = ref<HTMLVideoElement | null>(null)
const pages = ref<CapturedPage[]>([])
const cameraError = ref('')
const starting = ref(false)
const capturing = ref(false)
const building = ref(false)
const flash = ref(false)
const nativeInput = ref<HTMLInputElement | null>(null)
let stream: MediaStream | null = null

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  if (video.value) video.value.srcObject = null
}

async function startCamera() {
  cameraError.value = ''
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    cameraError.value = 'Live camera needs HTTPS (or localhost). Use “Phone camera app” below instead.'
    return
  }
  starting.value = true
  try {
    stopCamera()
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } },
    })
    await nextTick()
    if (video.value) {
      video.value.srcObject = stream
      await video.value.play().catch(() => {})
    }
  } catch (err) {
    const name = (err as { name?: string })?.name ?? ''
    cameraError.value =
      name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Camera access is blocked. Allow it from the camera icon in the address bar, or use “Phone camera app” below.'
        : name === 'NotReadableError'
          ? 'The camera is in use by another app or tab. Close it and press Try again, or use “Phone camera app”.'
          : name === 'NotFoundError' || name === 'OverconstrainedError'
            ? 'No camera found. Use “Phone camera app”, or upload a file instead.'
            : 'Could not start the camera. Use “Phone camera app”, or upload a file instead.'
  } finally {
    starting.value = false
  }
}

async function capture() {
  const v = video.value
  if (!v || !v.videoWidth || capturing.value) return
  capturing.value = true
  try {
    pages.value.push(await toJpegPage(v, v.videoWidth, v.videoHeight))
    flash.value = true
    setTimeout(() => (flash.value = false), 150)
  } catch {
    ui.error('Could not take the picture', 'Try again.')
  } finally {
    capturing.value = false
  }
}

async function addFromCameraApp(files: FileList | null | undefined) {
  for (const f of Array.from(files ?? [])) {
    if (!f.type.startsWith('image/')) continue
    try {
      pages.value.push(await fileToPage(f))
    } catch {
      ui.error('Could not read that photo', f.name)
    }
  }
  if (nativeInput.value) nativeInput.value.value = ''
}

function removePage(i: number) {
  URL.revokeObjectURL(pages.value[i]!.url)
  pages.value.splice(i, 1)
}
function movePage(i: number, delta: number) {
  const j = i + delta
  if (j < 0 || j >= pages.value.length) return
  const copy = [...pages.value]
  ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
  pages.value = copy
}

async function finish() {
  if (!pages.value.length) return
  building.value = true
  try {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    const several = pages.value.length > 1
    const files =
      props.separate || !several
        ? pages.value.map((p, i) => new File([p.blob], `scan-${stamp}${several ? `-${i + 1}` : ''}.jpg`, { type: 'image/jpeg' }))
        : [new File([await pagesToPdf(pages.value)], `scan-${stamp}.pdf`, { type: 'application/pdf' })]
    const big = files.find((f) => f.size > props.maxBytes)
    if (big) {
      ui.error('Too large', `${big.name} is ${formatBytes(big.size)}; the limit is ${formatBytes(props.maxBytes)}. Remove some pages.`)
      return
    }
    emit('done', files, pages.value.length)
    clearPages()
    emit('close')
  } catch {
    ui.error('Could not put the pages together', 'Try again.')
  } finally {
    building.value = false
  }
}

function clearPages() {
  pages.value.forEach((p) => URL.revokeObjectURL(p.url))
  pages.value = []
}

function close() {
  if (pages.value.length && !confirm(`Discard the ${pages.value.length} page${pages.value.length === 1 ? '' : 's'} you took?`)) return
  clearPages()
  emit('close')
}

// The camera runs only while the window is open and the tab is visible.
watch(
  () => props.open,
  (open) => (open ? startCamera() : stopCamera()),
)
function onVisibility() {
  if (!props.open) return
  if (document.hidden) stopCamera()
  else if (!stream && !cameraError.value) startCamera()
}
onMounted(() => document.addEventListener('visibilitychange', onVisibility))
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  stopCamera()
  clearPages()
})
</script>

<template>
  <AppModal
    :open="open"
    title="Take a picture of the document"
    :description="separate ? 'Photograph each page. Every photo is added as its own file.' : 'Photograph each page. Several pages are joined into one PDF.'"
    width="lg"
    @close="close"
  >
    <div class="relative aspect-[4/3] overflow-hidden rounded-2xl bg-night">
      <video ref="video" class="size-full object-contain" muted playsinline autoplay />
      <div v-if="flash" class="absolute inset-0 bg-white/70" />
      <div v-if="starting" class="absolute inset-0 grid place-items-center text-sm text-night-text-2">Starting camera…</div>
      <div v-else-if="cameraError" class="absolute inset-0 grid place-items-center p-8 text-center text-sm text-night-text-2">
        <div class="flex max-w-sm flex-col items-center gap-4">
          <FIcon name="camera-off" :size="28" />
          <p>{{ cameraError }}</p>
          <button class="btn btn-sm btn-secondary" @click="startCamera"><FIcon name="refresh-cw" :size="14" /> Try again</button>
        </div>
      </div>
      <!-- Shutter -->
      <button
        v-if="!cameraError && !starting"
        class="absolute bottom-4 left-1/2 grid size-16 -translate-x-1/2 place-items-center rounded-full border-4 border-white/80 bg-white/20 text-white backdrop-blur transition hover:bg-white/30 disabled:opacity-50"
        :disabled="capturing"
        aria-label="Capture page"
        title="Capture page"
        @click="capture"
      >
        <FIcon name="camera" :size="24" />
      </button>
      <span v-if="pages.length" class="absolute top-3 right-3 rounded-full bg-night/70 px-2.5 py-1 text-xs font-semibold text-white">{{ pages.length }} page{{ pages.length === 1 ? '' : 's' }}</span>
    </div>

    <p class="mt-3 text-xs text-ink-2">Lay the page flat in good light and fill the frame with it.</p>

    <!-- Pages taken -->
    <ol v-if="pages.length" class="mt-4 flex gap-3 overflow-x-auto pb-1">
      <li v-for="(p, i) in pages" :key="p.url" class="w-24 shrink-0">
        <div class="relative overflow-hidden rounded-lg border border-line bg-ink/[0.03]">
          <img :src="p.url" :alt="`Page ${i + 1}`" class="h-32 w-full object-cover" />
          <span class="absolute top-1 left-1 rounded bg-night/70 px-1.5 text-[11px] font-semibold text-white">{{ i + 1 }}</span>
        </div>
        <div class="mt-1 flex justify-center gap-0.5">
          <button class="grid size-7 place-items-center rounded text-ink-2 hover:bg-ink/5 disabled:opacity-30" :disabled="i === 0" aria-label="Move earlier" @click="movePage(i, -1)"><FIcon name="chevron-left" :size="14" /></button>
          <button class="grid size-7 place-items-center rounded text-danger-ink hover:bg-danger/10" aria-label="Remove page" @click="removePage(i)"><FIcon name="trash-2" :size="13" /></button>
          <button class="grid size-7 place-items-center rounded text-ink-2 hover:bg-ink/5 disabled:opacity-30" :disabled="i === pages.length - 1" aria-label="Move later" @click="movePage(i, 1)"><FIcon name="chevron-right" :size="14" /></button>
        </div>
      </li>
    </ol>

    <template #footer>
      <input ref="nativeInput" type="file" accept="image/*" capture="environment" multiple class="sr-only" @change="addFromCameraApp(($event.target as HTMLInputElement).files)" />
      <button class="btn btn-ghost mr-auto" @click="nativeInput?.click()"><FIcon name="smartphone" :size="16" /> Phone camera app</button>
      <button class="btn btn-ghost" @click="close">Cancel</button>
      <button class="btn btn-primary" :disabled="!pages.length || building" @click="finish">
        <FIcon name="check" :size="16" />
        {{ building ? 'Preparing…' : pages.length ? `Use ${pages.length} page${pages.length === 1 ? '' : 's'}` : 'Take a picture first' }}
      </button>
    </template>
  </AppModal>
</template>
