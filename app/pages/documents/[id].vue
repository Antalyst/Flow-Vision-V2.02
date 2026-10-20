<script setup lang="ts">
import type { FlowDocument, OrgRoute } from '~/types'
import type { Tone } from '~/utils/format'

const route = useRoute()
const router = useRouter()
const id = computed(() => String(route.params.id))
const docsApi = useDocuments()
const api = useApi()
const auth = useAuthStore()
const documents = useDocumentsStore()
const { busy, run } = useAction()
const { joinDocument } = useRealtime()
const qrApi = useQR()

const { data, error, refresh } = await useAsyncData(`document-${id.value}`, () => docsApi.get(id.value), { watch: [id] })
useHead({ title: () => (data.value ? `${data.value.document.tracking_number} · FlowVision` : 'Document · FlowVision') })

onMounted(() => {
  joinDocument(id.value)
  // Just uploaded (?print=1): print the document with its QR label straight away, once.
  if (route.query.print === '1') {
    if (data.value?.active_qr && data.value.document) qrApi.printWithDocument(data.value.active_qr, data.value.document, data.value.files, data.value.routing_slip)
    router.replace({ query: { ...route.query, print: undefined } })
  }
})
watch(
  () => documents.version,
  () => {
    if (documents.lastChange?.id === id.value) refresh()
  },
)

const doc = computed(() => data.value?.document)
const perms = computed(() => data.value?.permissions)
const currentStep = computed(() => data.value?.route?.steps.find((s) => s.step_number === doc.value?.current_step_number))

// Drafts and returned documents can be (re)submitted on any active Document Route.
const routesApi = useRoutes()
const canPickRoute = computed(() => Boolean(perms.value?.canSubmit || perms.value?.canResubmit))
const { data: routeOptionData } = await useAsyncData(`document-${id.value}-routes`, () => (canPickRoute.value ? routesApi.list() : Promise.resolve(null)), {
  watch: [canPickRoute],
})
const routeOptions = computed<OrgRoute[]>(() => routeOptionData.value?.data ?? [])
const submitRouteId = ref('')
watchEffect(() => {
  if (routeOptions.value.some((r) => r.id === submitRouteId.value)) return
  // Keep the document's own route while it's active. A route edited after this document ran on it
  // left the document on a copy with the same name, so fall back to the active route of that name.
  submitRouteId.value =
    routeOptions.value.find((r) => r.id === doc.value?.route_id)?.id ??
    routeOptions.value.find((r) => r.name === doc.value?.route_name)?.id ??
    (routeOptions.value.length === 1 ? routeOptions.value[0]!.id : '')
})
const showRoutePicker = computed(() => canPickRoute.value && (routeOptions.value.length > 1 || submitRouteId.value !== doc.value?.route_id))
// A draft previews the route it will follow; everything else shows the route it ran on.
const shownRoute = computed(() =>
  doc.value?.status === 'CREATED' ? (routeOptions.value.find((r) => r.id === submitRouteId.value) ?? data.value?.route) : data.value?.route,
)

const pickupOpen = ref(false)
const passOpen = ref(false)
const sendBackOpen = ref(false)
const reportOpen = ref(false)
// Umbrella offices: hand the document to a unit of this office, or return it from the unit.
const handOpen = ref(false)
const handForm = reactive({ umbrella_id: '', remarks: '' })
function openHand() {
  handForm.umbrella_id = data.value?.umbrella_options[0]?.id ?? ''
  handForm.remarks = ''
  handOpen.value = true
}
async function handToUmbrella() {
  const name = data.value?.umbrella_options.find((u) => u.id === handForm.umbrella_id)?.name ?? 'the umbrella office'
  const ok = await act('hand', () => docsApi.handToUmbrella(id.value, { umbrella_id: handForm.umbrella_id, remarks: handForm.remarks || undefined }), `Handed to ${name} — they scan it in`)
  if (ok) handOpen.value = false
}
async function returnFromUmbrella() {
  await act('return-unit', () => docsApi.returnFromUmbrella(id.value), activeInternal.value ? 'Internal route ended early — back to its office, they scan it in' : 'Returned to its office — they scan it in')
}

// Internal routes: an office's own path through its umbrella offices (inside this route step).
const activeInternal = computed(() => data.value?.internal_routes?.find((r) => r.status === 'ACTIVE') ?? null)
const nextInternalStep = computed(() => (activeInternal.value ? (activeInternal.value.steps[activeInternal.value.current_index + 1] ?? null) : null))
const internalOpen = ref(false)
const internalForm = reactive({ route_id: '', remarks: '' })
function openInternal() {
  internalForm.route_id = data.value?.internal_route_options[0]?.id ?? ''
  internalForm.remarks = ''
  internalOpen.value = true
}
async function startInternal() {
  const name = data.value?.internal_route_options.find((r) => r.id === internalForm.route_id)?.name ?? 'the internal route'
  const ok = await act('internal-start', () => docsApi.startInternalRoute(id.value, { route_id: internalForm.route_id, remarks: internalForm.remarks || undefined }), `Sent along ${name} — the first unit scans it in`)
  if (ok) internalOpen.value = false
}
async function advanceInternal() {
  const next = nextInternalStep.value
  await act('internal-advance', () => docsApi.advanceInternalRoute(id.value), next ? `Sent to ${next.name} — they scan it in` : 'Internal route done — back to its office, they scan it in')
}
const INTERNAL_STATE: Record<string, { tone: Tone; label: string }> = {
  DONE: { tone: 'success', label: 'Done' },
  CURRENT: { tone: 'primary', label: 'Has it now' },
  PENDING: { tone: 'neutral', label: 'Next' },
  ENDED: { tone: 'warning', label: 'Returned early from here' },
  SKIPPED: { tone: 'neutral', label: 'Skipped' },
}
const INTERNAL_STATUS: Record<string, { tone: Tone; label: string }> = {
  ACTIVE: { tone: 'primary', label: 'In progress' },
  COMPLETED: { tone: 'success', label: 'Completed' },
  CANCELLED: { tone: 'warning', label: 'Ended early' },
}
// Passed to the next staff of the office, not received at the next desk yet (current visit only).
const pendingPass = computed(() => {
  const visit = data.value?.routing?.at(-1)
  return visit?.state === 'AT_OFFICE' ? visit.pending_pass : null
})
const failOpen = ref(false)
const failRemarks = ref('')
const note = ref('')
// The routing details run long on a multi-office route, so they start folded.
const routingOpen = ref(false)

async function act(key: string, fn: () => Promise<unknown>, message: string) {
  const ok = await run(key, fn, message)
  if (ok) await refresh()
  return ok
}

async function removeDraft() {
  await useUiStore().confirm({
    title: 'Delete this draft?',
    body: 'The draft and its files are removed. This cannot be undone.',
    confirmLabel: 'Delete draft',
    busyLabel: 'Deleting…',
    action: async () => {
      const ok = await run('delete', () => docsApi.remove(id.value), 'Draft deleted')
      if (ok) await router.push('/documents')
    },
  })
}

async function failDelivery() {
  if (!failRemarks.value.trim()) return
  const ok = await act('fail', () => docsApi.failDelivery(id.value, failRemarks.value.trim()), 'Delivery reported as failed')
  if (ok) {
    failOpen.value = false
    failRemarks.value = ''
  }
}

async function addNote() {
  if (!note.value.trim()) return
  const ok = await act('note', () => docsApi.addNote(id.value, note.value.trim()), 'Note added')
  if (ok) note.value = ''
}

function onRequested(updated: FlowDocument) {
  if (data.value) data.value.document = { ...data.value.document, ...updated }
  refresh()
}

const anyAction = computed(() => perms.value && Object.values(perms.value).some(Boolean))
// Approved at the last office: the QR label is retired, and issues and discussion are closed.
const isComplete = computed(() => doc.value?.status === 'COMPLETED')
const processing = computed(() => doc.value?.processing ?? null)
</script>

<template>
  <div class="fv-rise">
    <button class="mb-5 inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink" @click="router.back()">
      <FIcon name="arrow-left" :size="16" /> Back
    </button>

    <div v-if="error" class="card">
      <EmptyState icon="file-minus" title="Document not found" :description="apiErrorMessage(error)" />
    </div>

    <template v-else-if="doc && data">
      <!-- Header -->
      <header class="mb-6">
        <div class="flex flex-wrap items-center gap-2">
          <span class="mono rounded-md bg-ink/[0.05] px-2 py-1 text-ink-body" :title="`Tracking number ${doc.tracking_number}`">{{ doc.qr_code ?? doc.tracking_number }}</span>
          <StatusBadge :status="doc.status" />
          <PriorityBadge :priority="doc.priority" />
          <ToneBadge v-if="doc.internal_route_name" tone="primary" icon="shuffle">Internal route: {{ doc.internal_route_name }}</ToneBadge>
          <ToneBadge v-if="doc.qr_hidden" tone="neutral" icon="eye-off" title="It is on its way to your office: you get the QR label when it arrives">QR label shown on arrival</ToneBadge>
        </div>
        <h1 class="mt-3 text-[26px] leading-tight sm:text-[30px]">{{ doc.title }}</h1>
        <p class="mt-2 text-[15px] text-ink-body">
          {{ whereabouts(doc) }}<template v-if="currentStep && !['COMPLETED', 'RETURNED', 'CREATED'].includes(doc.status)"> · step {{ currentStep.step_number }} of {{ data.route?.steps.length }}, {{ currentStep.action_label.toLowerCase() }}</template>
        </p>
      </header>

      <!-- A co-worker at the office that holds it: the receiver handles the release. -->
      <div
        v-if="
          doc.received_by &&
          doc.received_by.id !== auth.user?.id &&
          (doc.current_step_number ?? 0) > 0 &&
          ['START', 'ARRIVED_AT_OFFICE'].includes(doc.status) &&
          auth.user?.office?.id === doc.current_office_id &&
          doc.next_office_name
        "
        class="mb-4 flex items-start gap-3 rounded-2xl bg-info/10 p-4 text-sm text-info-ink"
      >
        <FIcon name="user-check" :size="18" class="mt-0.5 shrink-0" />
        <span>
          <strong>{{ fullName(doc.received_by) }}</strong> received this document, so only they can pass it to the next staff or release it and assign its messenger<template v-if="doc.liaison"> (now {{ fullName(doc.liaison) }})</template>.
        </span>
      </div>

      <!-- Desk to desk: passed on inside the office, waiting for the next staff to scan it in. -->
      <div v-if="pendingPass" class="mb-4 flex items-start gap-3 rounded-2xl bg-amber/15 p-4 text-sm text-amber-ink">
        <FIcon name="users" :size="18" class="mt-0.5 shrink-0" />
        <div class="min-w-0">
          <p>
            <strong>{{ pendingPass.by ? fullName(pendingPass.by) : 'A staff member' }}</strong> passed this document to the next staff at {{ doc.currentOffice?.name ?? 'this office' }}
            {{ timeAgo(pendingPass.at) }}. No messenger can be assigned until another staff member scans it in.
          </p>
          <p v-if="pendingPass.remarks" class="mt-1 italic">“{{ pendingPass.remarks }}”</p>
        </div>
      </div>

      <!-- Actions available to this user right now -->
      <div v-if="anyAction" class="card mb-6 flex flex-wrap items-center gap-2 p-4">
        <span class="mr-2 text-sm font-medium text-ink-body">Your next step:</span>
        <template v-if="showRoutePicker">
          <label class="sr-only" for="submit-route">Document Route</label>
          <select id="submit-route" v-model="submitRouteId" class="input w-auto max-w-full min-w-48">
            <option value="" disabled>{{ routeOptions.length ? 'Choose a route…' : 'No route available' }}</option>
            <option v-for="r in routeOptions" :key="r.id" :value="r.id">{{ r.name }} · {{ r.steps.length }} step{{ r.steps.length === 1 ? '' : 's' }}</option>
          </select>
        </template>
        <button
          v-if="perms!.canSubmit"
          class="btn btn-primary"
          :disabled="!!busy || !submitRouteId"
          :aria-busy="busy === 'submit'"
          @click="act('submit', () => docsApi.submit(id, submitRouteId), 'Submitted to route')"
        >
          <FIcon name="send" :size="16" /> Submit to route
        </button>
        <button
          v-if="perms!.canResubmit"
          class="btn btn-primary"
          :disabled="!!busy || !submitRouteId"
          :aria-busy="busy === 'submit'"
          @click="act('submit', () => docsApi.submit(id, submitRouteId), 'Resubmitted — back at step 1')"
        >
          <FIcon name="rotate-ccw" :size="16" /> Resubmit
        </button>
        <NuxtLink v-if="perms!.canScanReceive" to="/scan" class="btn btn-primary">
          <FIcon name="maximize" :size="16" /> Scan QR to receive
        </NuxtLink>
        <button v-if="perms!.canRequestPickup" class="btn btn-primary" @click="pickupOpen = true">
          <FIcon name="truck" :size="16" />
          {{ doc.current_step_number === 0 ? 'Assign messenger' : 'Release to messenger' }} → {{ doc.next_office_name ?? 'next office' }}
        </button>
        <button v-if="perms!.canPassToStaff" class="btn btn-secondary" @click="passOpen = true">
          <FIcon name="users" :size="16" /> Pass to next staff
        </button>
        <button v-if="perms!.canHandToUmbrella" class="btn btn-secondary" @click="openHand">
          <FIcon name="git-branch" :size="16" /> Hand to umbrella office
        </button>
        <button v-if="perms!.canStartInternalRoute" class="btn btn-secondary" @click="openInternal">
          <FIcon name="shuffle" :size="16" /> Send along internal route
        </button>
        <button v-if="perms!.canAdvanceInternalRoute" class="btn btn-primary" :disabled="busy === 'internal-advance'" :aria-busy="busy === 'internal-advance'" @click="advanceInternal">
          <template v-if="nextInternalStep"><FIcon name="arrow-right" :size="16" /> Pass to next unit → {{ nextInternalStep.name }}</template>
          <template v-else><FIcon name="corner-up-left" :size="16" /> Finish internal route → back to office</template>
        </button>
        <button v-if="perms!.canReturnFromUmbrella" class="btn btn-secondary" :disabled="busy === 'return-unit'" :aria-busy="busy === 'return-unit'" @click="returnFromUmbrella">
          <FIcon name="corner-up-left" :size="16" /> {{ activeInternal ? 'End internal route early' : 'Return to its office' }}
        </button>
        <button v-if="perms!.canSendBack" class="btn btn-danger" @click="sendBackOpen = true">
          <FIcon name="flag" :size="16" /> Flag issue &amp; send back
        </button>
        <ToneBadge v-if="doc.sent_back" tone="danger" icon="flag">Flagged — going back to {{ doc.sent_back.office_name ?? 'the previous office' }}</ToneBadge>
        <ToneBadge v-if="doc.return_pickup_open" tone="warning" icon="users">Waiting for a liaison of {{ doc.sent_back?.office_name ?? 'that office' }} to claim the pickup</ToneBadge>
        <button v-if="perms!.canReleaseReturnClaim" class="btn btn-ghost" :disabled="!!busy" :aria-busy="busy === 'unclaim'" @click="act('unclaim', () => api.del(`/documents/${id}/return-claim`), 'Pickup given up — the other liaisons were told')">
          Give up this pickup
        </button>
        <NuxtLink v-if="doc.open_issues" :to="`/issues?document=${doc.id}`" class="btn btn-ghost btn-sm">
          <FIcon name="alert-circle" :size="14" /> {{ doc.open_issues }} open issue{{ doc.open_issues === 1 ? '' : 's' }}
        </NuxtLink>
        <template v-if="perms!.canTakeBackPass">
          <ToneBadge tone="warning" icon="users">Waiting for the next staff to scan it in</ToneBadge>
          <button class="btn btn-ghost" :disabled="!!busy" :aria-busy="busy === 'takeback'" @click="act('takeback', () => docsApi.takeBackPass(id), 'Taken back — it is at your desk again')">
            <FIcon name="corner-up-left" :size="16" /> Take it back
          </button>
        </template>
        <template v-if="perms!.canReassign || perms!.canCancelPickup">
          <ToneBadge v-if="doc.liaison" tone="warning" icon="user">Waiting for {{ fullName(doc.liaison) }} to pick it up</ToneBadge>
          <button v-if="perms!.canReassign" class="btn btn-secondary" @click="pickupOpen = true"><FIcon name="repeat" :size="16" /> Reassign messenger</button>
          <button v-if="perms!.canCancelPickup" class="btn btn-ghost" :disabled="!!busy" :aria-busy="busy === 'cancel'" @click="act('cancel', () => docsApi.cancelPickup(id), doc.sent_back ? 'Send-back cancelled — it stays at your office' : 'Messenger unassigned — they were told')">
            {{ doc.sent_back ? 'Cancel send-back' : 'Unassign' }}
          </button>
        </template>
        <NuxtLink v-if="perms!.canPickup" to="/scan" class="btn btn-primary">
          <FIcon name="maximize" :size="16" /> Scan to pick up
        </NuxtLink>
        <ToneBadge v-if="perms!.canReportFailure" tone="info" icon="map-pin">Bring it to {{ doc.next_office_name ?? 'the next office' }} — their staff scan it to receive</ToneBadge>
        <button v-if="perms!.canStartTransit" class="btn btn-secondary" :disabled="!!busy" :aria-busy="busy === 'transit'" @click="act('transit', () => docsApi.startTransit(id), 'Marked in transit')">
          <FIcon name="navigation" :size="16" /> Start transit
        </button>
        <button v-if="perms!.canReportFailure" class="btn btn-danger" @click="failOpen = true"><FIcon name="alert-triangle" :size="16" /> Report failed delivery</button>
        <a v-if="perms!.canApprove" href="#approval" class="btn btn-success"><FIcon name="check-square" :size="16" /> Review for approval</a>
        <template v-if="perms!.canEdit">
          <div class="flex-1" />
          <button class="btn btn-danger btn-sm" :disabled="!!busy" :aria-busy="busy === 'delete'" @click="removeDraft"><FIcon name="trash-2" :size="14" /> Delete draft</button>
        </template>
      </div>

      <!-- Route progress -->
      <section v-if="shownRoute" class="card card-pad mb-6">
        <div class="mb-5 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-lg">{{ doc.status === 'CREATED' ? 'Route it will follow' : 'Route progress' }}</h2>
          <span class="text-xs text-ink-2">{{ shownRoute.name }}</span>
        </div>
        <RouteFlow
          :steps="shownRoute.steps"
          :current-step="doc.current_step_number"
          :status="doc.status"
          :received="!!doc.received_at"
          :released="!!doc.pickup_requested_at"
          :origin="doc.origin"
          :uploaded-by="doc.submitter ? fullName(doc.submitter) : null"
          :started-at="doc.submitted_at"
        />
      </section>

      <div class="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div class="space-y-6">
          <section v-if="perms?.canApprove && data.pending_approval" id="approval">
            <h2 class="mb-3 text-lg">Final approval</h2>
            <ApprovalCard :approval="{ ...data.pending_approval, document: doc }" @decided="refresh()" />
          </section>

          <section v-if="data.internal_routes?.length" class="card card-pad" aria-labelledby="internal-routes-title">
            <h2 id="internal-routes-title" class="text-lg">Internal routes</h2>
            <p class="mt-1 text-sm text-ink-body">Moves between the umbrella offices of one office, inside its route step. They are not route checkpoints: route progress doesn’t change.</p>
            <ol class="mt-4 space-y-4">
              <li v-for="run in data.internal_routes" :key="run.id" class="rounded-2xl border border-line/70 p-4">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <p class="font-semibold">{{ run.route_name }}</p>
                  <ToneBadge :tone="INTERNAL_STATUS[run.status]!.tone" dot>{{ INTERNAL_STATUS[run.status]!.label }}</ToneBadge>
                </div>
                <p class="mt-1 text-xs text-ink-2">
                  Route step {{ run.route_step_number }} · started {{ formatDateTime(run.started_at) }}<template v-if="run.ended_at"> · ended {{ formatDateTime(run.ended_at) }}</template>
                </p>
                <ol class="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
                  <template v-for="(st, i) in run.steps" :key="st.office_id">
                    <li class="rounded-lg px-2 py-1" :class="TONE_CLASSES[INTERNAL_STATE[st.state]!.tone]" :title="INTERNAL_STATE[st.state]!.label">
                      <span class="font-medium">{{ i + 1 }}. {{ st.name }}</span><template v-if="st.action_label"> · {{ st.action_label }}</template>
                    </li>
                    <FIcon v-if="i < run.steps.length - 1" name="chevron-right" :size="12" class="text-ink-3" aria-hidden="true" />
                  </template>
                </ol>
              </li>
            </ol>
            <p class="mt-3 text-xs text-ink-2">Each move, with who and when, is in the office’s routing details below.</p>
          </section>

          <section v-if="data.routing?.length" class="card card-pad">
            <h2 class="text-lg">
              <button type="button" class="flex w-full items-center gap-3 text-left" :aria-expanded="routingOpen" aria-controls="routing-details" @click="routingOpen = !routingOpen">
                <span class="flex-1">Routing details</span>
                <span class="text-xs font-normal text-ink-2">{{ data.routing.length }} office visit{{ data.routing.length === 1 ? '' : 's' }}</span>
                <span class="grid size-9 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-ink/5">
                  <FIcon name="chevron-down" :size="18" class="transition-transform duration-200" :class="routingOpen && 'rotate-180'" />
                </span>
              </button>
            </h2>
            <p class="mt-1 pr-12 text-sm text-ink-body">Inside each office — arrival, receipt, processing and release to a messenger — up to its transfer to the next office.</p>
            <div v-show="routingOpen" id="routing-details" class="mt-5">
              <OfficeRouting :visits="data.routing" :origin-name="doc.origin?.name" />
            </div>
          </section>

          <!-- Approved and complete: nothing left to discuss on it. -->
          <section v-if="!isComplete" class="card card-pad">
            <h2 class="mb-1 text-lg">Discussion</h2>
            <p class="mb-4 text-sm text-ink-body">Everyone working on this document can see this thread.</p>
            <MessageThread kind="DOCUMENT" :target-id="doc.id" height="h-[340px]" />
          </section>
        </div>

        <aside class="space-y-6">
          <section class="card card-pad">
            <h2 class="mb-4 text-lg">Details</h2>
            <dl class="space-y-3.5 text-sm">
              <div class="flex justify-between gap-4"><dt class="text-ink-2">Type</dt><dd class="text-right">{{ doc.document_type ?? '—' }}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-ink-2">Submitted by</dt><dd class="text-right">{{ fullName(doc.submitter) }}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-ink-2">Submitted</dt><dd class="text-right">{{ formatDateTime(doc.submitted_at) }}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-ink-2">Target completion</dt><dd class="text-right">{{ doc.target_at ? formatDateTime(doc.target_at) : doc.status === 'CREATED' ? 'Set on submission' : 'No time limit' }}</dd></div>
              <div v-if="doc.completed_at" class="flex justify-between gap-4"><dt class="text-ink-2">Completed</dt><dd class="text-right">{{ formatDateTime(doc.completed_at) }}</dd></div>
              <div v-if="doc.currentOffice" class="flex justify-between gap-4"><dt class="text-ink-2">Current office</dt><dd class="text-right">{{ doc.currentOffice.name }}</dd></div>
              <div v-if="doc.received_by" class="flex justify-between gap-4"><dt class="text-ink-2">Received by</dt><dd class="text-right">{{ fullName(doc.received_by) }}</dd></div>
              <div v-if="doc.liaison" class="flex justify-between gap-4"><dt class="text-ink-2">Messenger</dt><dd class="text-right">{{ fullName(doc.liaison) }}</dd></div>
              <div v-if="deadlineState(doc)" class="flex justify-between gap-4">
                <dt class="text-ink-2">Deadline</dt>
                <dd><ToneBadge :tone="deadlineState(doc)!.tone" icon="clock">{{ deadlineState(doc)!.label }}</ToneBadge></dd>
              </div>
              <!-- Processing time counts only the organization's working hours (Organization Settings). -->
              <div v-if="processing?.used_minutes != null" class="flex justify-between gap-4">
                <dt class="text-ink-2">{{ isComplete ? 'Processed in' : 'Processing time' }}</dt>
                <dd class="text-right">
                  {{ formatWorkTime(processing.used_minutes, processing.day_minutes) }}
                  <span v-if="processing.working_hours_only" class="block text-xs text-ink-2">working time</span>
                </dd>
              </div>
            </dl>
            <p v-if="processing?.paused" class="mt-4 flex items-start gap-2 rounded-xl bg-info/10 p-3 text-[13px] text-info-ink">
              <FIcon name="pause-circle" :size="16" class="mt-0.5 shrink-0" />
              <span>
                Processing time is paused — outside working hours, a day off or a holiday.<template v-if="processing.resumes_at"> It resumes {{ formatDateTime(processing.resumes_at) }}.</template>
              </span>
            </p>
            <p v-if="doc.description" class="mt-5 border-t border-line/60 pt-4 text-sm whitespace-pre-wrap text-ink-body">{{ doc.description }}</p>
            <!-- Every file of the document (a bulk upload has several, all under one QR) -->
            <div v-if="data.files.length" class="mt-5 border-t border-line/60 pt-4">
              <p class="mb-2 flex items-center justify-between text-xs text-ink-2">
                <span>{{ data.files.length }} file{{ data.files.length === 1 ? '' : 's' }}<template v-if="data.files.length > 1"> · one QR code</template></span>
                <span v-if="doc.pages">{{ doc.pages }} page{{ doc.pages === 1 ? '' : 's' }}</span>
              </p>
              <ul class="max-h-72 space-y-1 overflow-y-auto">
                <li v-for="f in data.files" :key="f.id">
                  <a :href="f.url" target="_blank" rel="noopener" class="btn btn-ghost w-full justify-start">
                    <FIcon name="paperclip" :size="16" />
                    <span class="min-w-0 flex-1 truncate text-left">{{ f.name }}</span>
                    <span class="text-xs text-ink-2">{{ formatBytes(f.size) }}</span>
                  </a>
                </li>
              </ul>
            </div>
          </section>

          <section v-if="data.active_qr" class="card card-pad">
            <h2 class="mb-4 text-lg">QR label</h2>
            <QRDisplay
              :qr="data.active_qr"
              :doc="doc"
              :files="data.files"
              :slip="data.routing_slip"
              :can-regenerate="['DEPARTMENT_HEAD', 'STAFF'].includes(auth.role ?? '') && auth.user?.office?.id === doc.current_office_id && ['START', 'ARRIVED_AT_OFFICE'].includes(doc.status)"
              @regenerated="refresh()"
            />
          </section>

          <section v-if="data.approvals.length" class="card card-pad">
            <h2 class="mb-4 text-lg">Approvals</h2>
            <ul class="space-y-3">
              <li v-for="a in data.approvals" :key="a.id" class="rounded-xl bg-ink/[0.03] p-3 text-sm">
                <div class="flex items-center justify-between gap-2">
                  <ToneBadge :tone="a.status === 'APPROVED' ? 'success' : a.status === 'RETURNED' ? 'danger' : 'warning'" dot>{{ a.status.toLowerCase() }}</ToneBadge>
                  <span class="text-xs text-ink-2">{{ formatDateTime(a.decided_at ?? a.requested_at) }}</span>
                </div>
                <p class="mt-2 text-ink-body">{{ a.office?.name }}<template v-if="a.decider"> · {{ fullName(a.decider) }}</template></p>
                <p v-if="a.remarks" class="mt-1 text-ink-body italic">“{{ a.remarks }}”</p>
              </li>
            </ul>
          </section>

          <button v-if="!isComplete" type="button" class="btn btn-ghost w-full" @click="reportOpen = true"><FIcon name="flag" :size="16" /> Report an issue</button>
        </aside>
      </div>

      <RequestPickupModal :open="pickupOpen" :doc="doc" @close="pickupOpen = false" @requested="onRequested" />
      <PassToStaffModal :open="passOpen" :doc="doc" @close="passOpen = false" @passed="onRequested" />
      <AppModal :open="handOpen" title="Hand to an umbrella office" description="It stays on this step of its route. The umbrella office scans it in and returns it here when done." width="sm" @close="handOpen = false">
        <form id="hand-form" class="space-y-3" @submit.prevent="handToUmbrella">
          <label class="block">
            <span class="field-label">Umbrella office</span>
            <select v-model="handForm.umbrella_id" class="input" required>
              <option v-for="u in data?.umbrella_options ?? []" :key="u.id" :value="u.id">{{ u.name }} ({{ u.code }})</option>
            </select>
          </label>
          <label class="block">
            <span class="field-label">Note <span class="font-normal text-ink-2">(optional)</span></span>
            <textarea v-model="handForm.remarks" class="input" rows="2" maxlength="2000" />
          </label>
        </form>
        <template #footer>
          <button class="btn btn-ghost" @click="handOpen = false">Cancel</button>
          <button class="btn btn-primary" form="hand-form" :disabled="!handForm.umbrella_id || busy === 'hand'" :aria-busy="busy === 'hand'">Hand over</button>
        </template>
      </AppModal>
      <AppModal :open="internalOpen" title="Send along an internal route" description="Your office’s own path through its umbrella offices. It stays on this step of its route; each unit scans it in and passes it on, and it comes back here at the end." width="sm" @close="internalOpen = false">
        <form id="internal-form" class="space-y-3" @submit.prevent="startInternal">
          <label class="block">
            <span class="field-label">Internal route</span>
            <select v-model="internalForm.route_id" class="input" required>
              <option v-for="r in data?.internal_route_options ?? []" :key="r.id" :value="r.id">{{ r.name }}</option>
            </select>
          </label>
          <p v-if="data?.internal_route_options.find((r) => r.id === internalForm.route_id)?.description" class="text-xs text-ink-2">
            {{ data?.internal_route_options.find((r) => r.id === internalForm.route_id)?.description }}
          </p>
          <label class="block">
            <span class="field-label">Note <span class="font-normal text-ink-2">(optional)</span></span>
            <textarea v-model="internalForm.remarks" class="input" rows="2" maxlength="2000" />
          </label>
        </form>
        <template #footer>
          <button class="btn btn-ghost" @click="internalOpen = false">Cancel</button>
          <button class="btn btn-primary" form="internal-form" :disabled="!internalForm.route_id || busy === 'internal-start'" :aria-busy="busy === 'internal-start'">Send</button>
        </template>
      </AppModal>
      <SendBackModal :open="sendBackOpen" :doc="doc" @close="sendBackOpen = false" @sent="onRequested" />
      <ReportIssueModal :open="reportOpen" :doc="doc" @close="reportOpen = false" @reported="refresh()" />

      <AppModal :open="failOpen" title="Report failed delivery" description="The document goes back to its origin office, which will route it again." width="sm" @close="failOpen = false">
        <label class="field-label" for="fail-remarks">What happened?</label>
        <textarea id="fail-remarks" v-model="failRemarks" class="input" rows="3" placeholder="e.g. Receiving office closed for the day" maxlength="2000" />
        <template #footer>
          <button class="btn btn-ghost" @click="failOpen = false">Cancel</button>
          <button class="btn btn-danger" :disabled="!failRemarks.trim() || busy === 'fail'" :aria-busy="busy === 'fail'" @click="failDelivery">Report failure</button>
        </template>
      </AppModal>
    </template>
  </div>
</template>
