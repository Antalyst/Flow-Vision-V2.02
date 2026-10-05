<script setup lang="ts">
import type { FlowDocument, OrgRoute } from '~/types'

const route = useRoute()
const router = useRouter()
const id = computed(() => String(route.params.id))
const docsApi = useDocuments()
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
    if (data.value?.active_qr && data.value.document) qrApi.printWithDocument(data.value.active_qr, data.value.document, data.value.files)
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
const failOpen = ref(false)
const failRemarks = ref('')
const note = ref('')

async function act(key: string, fn: () => Promise<unknown>, message: string) {
  const ok = await run(key, fn, message)
  if (ok) await refresh()
  return ok
}

async function removeDraft() {
  if (!confirm('Delete this draft? This cannot be undone.')) return
  const ok = await run('delete', () => docsApi.remove(id.value), 'Draft deleted')
  if (ok) router.push('/documents')
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
          <strong>{{ fullName(doc.received_by) }}</strong> received this document, so only they can release it and assign its messenger<template v-if="doc.liaison"> (now {{ fullName(doc.liaison) }})</template>.
        </span>
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
          @click="act('submit', () => docsApi.submit(id, submitRouteId), 'Submitted to route')"
        >
          <FIcon name="send" :size="16" /> Submit to route
        </button>
        <button
          v-if="perms!.canResubmit"
          class="btn btn-primary"
          :disabled="!!busy || !submitRouteId"
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
        <template v-if="perms!.canReassign || perms!.canCancelPickup">
          <ToneBadge tone="warning" icon="user">Waiting for {{ fullName(doc.liaison) }} to pick it up</ToneBadge>
          <button v-if="perms!.canReassign" class="btn btn-secondary" @click="pickupOpen = true"><FIcon name="repeat" :size="16" /> Reassign messenger</button>
          <button v-if="perms!.canCancelPickup" class="btn btn-ghost" :disabled="!!busy" @click="act('cancel', () => docsApi.cancelPickup(id), 'Messenger unassigned — they were told')">
            Unassign
          </button>
        </template>
        <NuxtLink v-if="perms!.canPickup" to="/scan" class="btn btn-primary">
          <FIcon name="maximize" :size="16" /> Scan to pick up
        </NuxtLink>
        <ToneBadge v-if="perms!.canReportFailure" tone="info" icon="map-pin">Bring it to {{ doc.next_office_name ?? 'the next office' }} — their staff scan it to receive</ToneBadge>
        <button v-if="perms!.canStartTransit" class="btn btn-secondary" :disabled="!!busy" @click="act('transit', () => docsApi.startTransit(id), 'Marked in transit')">
          <FIcon name="navigation" :size="16" /> Start transit
        </button>
        <button v-if="perms!.canReportFailure" class="btn btn-danger" @click="failOpen = true"><FIcon name="alert-triangle" :size="16" /> Report failed delivery</button>
        <a v-if="perms!.canApprove" href="#approval" class="btn btn-success"><FIcon name="check-square" :size="16" /> Review for approval</a>
        <template v-if="perms!.canEdit">
          <div class="flex-1" />
          <button class="btn btn-danger btn-sm" :disabled="!!busy" @click="removeDraft"><FIcon name="trash-2" :size="14" /> Delete draft</button>
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

          <section v-if="data.routing?.length" class="card card-pad">
            <div class="mb-5">
              <h2 class="text-lg">Routing details</h2>
              <p class="mt-1 text-sm text-ink-body">Inside each office — arrival, receipt, processing and release to a messenger — up to its transfer to the next office.</p>
            </div>
            <OfficeRouting :visits="data.routing" :origin-name="doc.origin?.name" />
          </section>

          <section class="card card-pad">
            <h2 class="mb-5 text-lg">Timeline</h2>
            <DocumentTimeline :events="data.tracking" />
            <form class="mt-6 flex gap-2 border-t border-line/60 pt-5" @submit.prevent="addNote">
              <label class="sr-only" for="note">Add a note</label>
              <input id="note" v-model="note" class="input" placeholder="Add a note to the timeline" maxlength="2000" />
              <button class="btn btn-ghost shrink-0" :disabled="!note.trim() || busy === 'note'">Add note</button>
            </form>
          </section>

          <section class="card card-pad">
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
            </dl>
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
              :can-regenerate="['EMPLOYEE', 'STAFF'].includes(auth.role ?? '') && auth.user?.office?.id === doc.current_office_id && ['START', 'ARRIVED_AT_OFFICE'].includes(doc.status)"
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

          <NuxtLink :to="`/issues?document=${doc.id}`" class="btn btn-ghost w-full"><FIcon name="flag" :size="16" /> Report an issue</NuxtLink>
        </aside>
      </div>

      <RequestPickupModal :open="pickupOpen" :doc="doc" @close="pickupOpen = false" @requested="onRequested" />

      <AppModal :open="failOpen" title="Report failed delivery" description="The document goes back to its origin office, which will route it again." width="sm" @close="failOpen = false">
        <label class="field-label" for="fail-remarks">What happened?</label>
        <textarea id="fail-remarks" v-model="failRemarks" class="input" rows="3" placeholder="e.g. Receiving office closed for the day" maxlength="2000" />
        <template #footer>
          <button class="btn btn-ghost" @click="failOpen = false">Cancel</button>
          <button class="btn btn-danger" :disabled="!failRemarks.trim() || busy === 'fail'" @click="failDelivery">Report failure</button>
        </template>
      </AppModal>
    </template>
  </div>
</template>
