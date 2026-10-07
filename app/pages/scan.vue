<script setup lang="ts">
import type QrScannerType from 'qr-scanner'
import type { ScanPreview } from '~/composables/useQR'

useHead({ title: 'Scan QR · FlowVision' })

const qrApi = useQR()
const ui = useUiStore()
const auth = useAuthStore()
const isLiaison = computed(() => auth.role === 'LIAISON')

type Phase = 'scanning' | 'verifying' | 'confirm' | 'done'
const phase = ref<Phase>('scanning')
const video = ref<HTMLVideoElement | null>(null)
const cameraError = ref('')
const manual = ref('')
const code = ref('')
const preview = ref<ScanPreview | null>(null)
const confirming = ref(false)
const result = ref<{ action: string; documentId: string; tracking: string; code: string; from?: string; to?: string } | null>(null)

let scanner: QrScannerType | null = null

const startingCamera = ref(false)

/** What went wrong with the camera, in words people can act on. */
function cameraProblem(err: unknown) {
  const name = (err as { name?: string })?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access is blocked. Click the camera icon in the address bar and allow it. On Windows, also check Settings › Privacy & security › Camera › "Let desktop apps access your camera". Then press Try again.'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return 'Windows won’t hand over the camera: something else is using it, or it is switched off. Close other apps and browser tabs using it (Zoom, Teams, Camera app, another FlowVision tab or dev server). Check the laptop’s camera key or privacy shutter. Then press Try again.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return 'No camera found on this device. Use "Scan from photo" or type the code under the QR.'
  }
  return `Could not start the camera${name ? ` (${name})` : ''}. Use "Scan from photo" or type the code under the QR.`
}

// One live scanner per tab, kept on window so a remount or hot reload can't leave an old one
// holding the camera (Windows gives the camera to one user at a time).
type ScannerSlot = { __fvScanner?: QrScannerType | null }
function releaseCamera() {
  const slot = window as unknown as ScannerSlot
  slot.__fvScanner?.stop()
  slot.__fvScanner?.destroy()
  slot.__fvScanner = null
  scanner = null
}

/** qr-scanner only ever says "Camera not found"; asking the browser directly gives the real reason. */
async function probeCamera(): Promise<unknown | null> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    stream.getTracks().forEach((t) => t.stop())
    return null
  } catch (err) {
    return err
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function openScanner(attempt: number): Promise<void> {
  releaseCamera()
  try {
    const { default: QrScanner } = await import('qr-scanner')
    scanner = new QrScanner(video.value!, (r) => onDecode(r.data), {
      preferredCamera: 'environment',
      highlightScanRegion: true,
      highlightCodeOutline: true,
      maxScansPerSecond: 8,
    })
    ;(window as unknown as ScannerSlot).__fvScanner = scanner
    await scanner.start()
  } catch (err) {
    releaseCamera()
    const real = await probeCamera()
    // A camera that was just released can take a moment on Windows before it opens again: retry once.
    if (attempt === 0 && (!real || (real as { name?: string }).name === 'NotReadableError')) {
      await wait(800)
      return openScanner(1)
    }
    console.warn('[scan] camera failed to start', real ?? err)
    cameraError.value = cameraProblem(real ?? err)
  }
}

async function startCamera() {
  cameraError.value = ''
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    cameraError.value = 'Live scanning needs HTTPS (or localhost). Use "Scan from photo" or type the code under the QR.'
    return
  }
  startingCamera.value = true
  try {
    await openScanner(0)
  } finally {
    startingCamera.value = false
  }
}

// Let go of the camera while this tab is hidden, so other tabs and apps can use it.
function onVisibility() {
  if (document.hidden) releaseCamera()
  else if (phase.value === 'scanning' && !cameraError.value && !scanner) startCamera()
}

// Fallback: decode a photo of the label (on phones this opens the camera app; works without HTTPS).
const photoInput = ref<HTMLInputElement | null>(null)
const readingPhoto = ref(false)
async function scanPhoto(file?: File | null) {
  if (!file) return
  readingPhoto.value = true
  try {
    const { default: QrScanner } = await import('qr-scanner')
    const { data } = await QrScanner.scanImage(file, { returnDetailedScanResult: true })
    scanner?.pause()
    await verify(data)
  } catch {
    ui.error('No QR code found in that photo', 'Take it closer and straight on, with the whole label in the picture.')
  } finally {
    readingPhoto.value = false
    if (photoInput.value) photoInput.value.value = ''
  }
}

async function onDecode(data: string) {
  if (phase.value !== 'scanning') return
  scanner?.pause()
  if (navigator.vibrate) navigator.vibrate(40)
  await verify(data)
}

async function verify(data: string) {
  const value = data.trim().toUpperCase()
  if (!qrApi.looksValid(value)) {
    ui.error('Not a FlowVision document code', 'Expected the office code, the upload date and 6 digits, e.g. BCC100726123456')
    resume()
    return
  }
  phase.value = 'verifying'
  code.value = value
  try {
    preview.value = await qrApi.verify(value)
    phase.value = 'confirm'
  } catch (err) {
    ui.error('Scan rejected', apiErrorMessage(err))
    resume()
  }
}

async function confirm() {
  if (!preview.value?.action) return
  confirming.value = true
  try {
    const res = await qrApi.scan(code.value, preview.value.action)
    result.value = {
      action: res.action,
      documentId: res.document.id,
      tracking: res.document.tracking_number,
      code: code.value,
      from: preview.value.from_office?.name,
      to: preview.value.to_office?.name,
    }
    phase.value = 'done'
  } catch (err) {
    ui.error('Could not complete the scan', apiErrorMessage(err))
  } finally {
    confirming.value = false
  }
}

function resume() {
  phase.value = 'scanning'
  preview.value = null
  result.value = null
  manual.value = ''
  if (scanner) scanner.start().catch(() => startCamera())
  else if (!cameraError.value) startCamera()
}

// What the document is doing right now, from this user's point of view.
const carried = computed(() => ['PICKED_UP', 'IN_TRANSIT'].includes(preview.value?.document.status ?? ''))
const confirmLabel = computed(() => {
  if (!preview.value?.action) return ''
  if (preview.value.action === 'PICKUP') return `Confirm pickup for ${preview.value.to_office?.name ?? 'next office'}`
  return carried.value ? `Receive from ${preview.value.messenger ? fullName(preview.value.messenger) : 'messenger'}` : 'Receive at my office'
})

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility)
  startCamera()
})
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  releaseCamera()
})
</script>

<template>
  <div class="fv-rise mx-auto max-w-xl">
    <PageHeader
      eyebrow="Scanner"
      title="Scan document QR"
      :description="
        isLiaison
          ? 'Scan the QR on a document released to you to pick it up. The scan shows which office to bring it to.'
          : 'Scan the QR on a document that reached your office to receive it. You are recorded as the person who received it.'
      "
    />

    <!-- Camera -->
    <section v-show="phase === 'scanning' || phase === 'verifying'" class="card overflow-hidden p-2">
      <div class="relative aspect-square overflow-hidden rounded-3xl bg-night">
        <video ref="video" class="size-full object-cover" muted playsinline />
        <div v-if="cameraError" class="absolute inset-0 grid place-items-center p-8 text-center text-sm text-night-text-2">
          <div class="flex max-w-sm flex-col items-center gap-4">
            <FIcon name="camera-off" :size="28" />
            <p>{{ cameraError }}</p>
            <button class="btn btn-sm btn-secondary" :disabled="startingCamera" :aria-busy="startingCamera" @click="startCamera">
              <FIcon name="refresh-cw" :size="14" /> {{ startingCamera ? 'Starting…' : 'Try again' }}
            </button>
          </div>
        </div>
        <div v-else-if="startingCamera" class="absolute inset-0 grid place-items-center text-sm text-night-text-2"><span class="flex items-center gap-2"><span class="spinner" /> Starting camera…</span></div>
        <div v-if="phase === 'verifying'" class="absolute inset-0 grid place-items-center bg-night/60 text-sm text-white"><span class="flex items-center gap-2"><span class="spinner" /> Checking code…</span></div>
      </div>
    </section>

    <div v-if="phase === 'scanning'" class="mt-4">
      <input ref="photoInput" type="file" accept="image/*" capture="environment" class="sr-only" @change="scanPhoto(($event.target as HTMLInputElement).files?.[0])" />
      <button class="btn btn-ghost w-full" :disabled="readingPhoto" :aria-busy="readingPhoto" @click="photoInput?.click()">
        <FIcon name="camera" :size="16" /> {{ readingPhoto ? 'Reading photo…' : 'Scan from photo' }}
      </button>
    </div>

    <form v-if="phase === 'scanning'" class="mt-2 flex gap-2" @submit.prevent="verify(manual)">
      <label class="sr-only" for="manual">Document code</label>
      <input id="manual" v-model="manual" class="input font-mono text-[13px] uppercase" placeholder="Or type the code: BCC100726123456" autocomplete="off" />
      <button class="btn btn-ghost shrink-0" :disabled="!manual.trim()">Check</button>
    </form>

    <!-- Confirm -->
    <section v-if="phase === 'confirm' && preview" class="card card-pad">
      <div class="flex flex-wrap items-center gap-2">
        <span class="mono rounded-md bg-ink/[0.05] px-2 py-1 text-ink-body">{{ preview.document.qr_code }}</span>
        <StatusBadge :status="preview.document.status" />
        <PriorityBadge :priority="preview.document.priority" />
      </div>
      <h2 class="mt-2 text-xl">{{ preview.document.title }}</h2>

      <div class="mt-5 flex items-center gap-3 rounded-2xl bg-ink/[0.035] p-4">
        <div class="min-w-0 flex-1">
          <p class="eyebrow">{{ carried ? 'From' : 'At' }}</p>
          <p class="mt-1 truncate text-sm font-semibold">{{ preview.from_office?.name ?? '—' }}</p>
        </div>
        <FIcon name="arrow-right" class="text-terracotta" />
        <div class="min-w-0 flex-1 text-right">
          <p class="eyebrow">{{ isLiaison ? 'Deliver to' : 'Next office' }}</p>
          <p class="mt-1 truncate text-sm font-semibold">{{ preview.to_office?.name ?? 'Final office' }}</p>
        </div>
      </div>

      <dl v-if="preview.messenger || preview.received_by || preview.passed_by" class="mt-4 space-y-2 text-sm">
        <div v-if="preview.received_by" class="flex justify-between gap-4"><dt class="text-ink-2">Received by</dt><dd>{{ fullName(preview.received_by) }}</dd></div>
        <div v-if="preview.passed_by" class="flex justify-between gap-4"><dt class="text-ink-2">Passed on by</dt><dd>{{ fullName(preview.passed_by) }}</dd></div>
        <div v-if="preview.messenger" class="flex justify-between gap-4"><dt class="text-ink-2">Messenger</dt><dd>{{ fullName(preview.messenger) }}</dd></div>
      </dl>

      <div
        v-if="!preview.action"
        class="mt-5 flex items-start gap-3 rounded-xl p-4 text-sm"
        :class="preview.tone === 'info' ? 'bg-info/10 text-info-ink' : 'bg-danger/10 text-danger-ink'"
        role="alert"
      >
        <FIcon :name="preview.tone === 'info' ? 'info' : 'slash'" :size="18" class="mt-0.5 shrink-0" /> {{ preview.reason }}
      </div>

      <div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button class="btn btn-ghost" @click="resume">Scan another</button>
        <NuxtLink v-if="!preview.action && !isLiaison" :to="`/documents/${preview.document.id}`" class="btn btn-secondary">Open document</NuxtLink>
        <button v-if="preview.action" class="btn btn-primary min-h-12" :disabled="confirming" :aria-busy="confirming" @click="confirm">
          <FIcon :name="preview.action === 'PICKUP' ? 'package' : 'inbox'" :size="16" />
          {{ confirming ? 'Confirming…' : confirmLabel }}
        </button>
      </div>
    </section>

    <!-- Done -->
    <section v-if="phase === 'done' && result" class="card card-pad text-center">
      <span class="mx-auto grid size-16 place-items-center rounded-full bg-sage text-white"><FIcon name="check" :size="30" :stroke="2.5" /></span>
      <h2 class="mt-5 text-xl">{{ result.action === 'PICKUP' ? 'Picked up' : 'Received' }}</h2>
      <p class="mt-2 text-sm text-ink-body">
        <span class="mono">{{ result.code }}</span>
        <template v-if="result.action === 'PICKUP'"> is now with you. Bring it to <strong>{{ result.to }}</strong> — they've been told it's coming, and their staff will scan it to receive it.</template>
        <template v-else> is received at your office, under your name. When your office is done with it, release it to a free messenger for the next office.</template>
      </p>
      <div class="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
        <NuxtLink v-if="isLiaison" to="/liaison/dashboard" class="btn btn-ghost">Back to pickups</NuxtLink>
        <NuxtLink v-else :to="`/documents/${result.documentId}`" class="btn btn-ghost">Open document</NuxtLink>
        <button class="btn btn-primary" @click="resume"><FIcon name="maximize" :size="16" /> Scan another</button>
      </div>
    </section>
  </div>
</template>
