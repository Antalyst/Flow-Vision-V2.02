<script setup lang="ts">
useHead({ title: 'Backups · FlowVision' })

interface Destination {
  label: string | null
  ok: boolean
  free_bytes: number | null
  error: string | null
}
interface BackupRow {
  name: string
  present: boolean
  bytes: number | null
  created_at: string | null
  status: 'VERIFIED' | 'VERIFIED_WITH_WARNINGS' | 'FAILED' | 'PACKAGE_MISSING' | 'NO_RECORD'
  encrypted: boolean
  warnings: string[]
  summary: { tables: number; rows: number; files_in_package: number; files_in_database: number; files_missing: number } | null
  last_verify: { at: string; ok: boolean; deep: boolean; errors: string[] } | null
  copies: Array<{ destination: string; verified_at: string }>
}
interface Job {
  id: string
  state: 'running' | 'done' | 'failed'
  step: string
  started_at: string
  finished_at: string | null
  started_by: string
  result: { name: string; status: string; bytes: number; copy: { attempted: boolean; ok: boolean; destination: string | null; error: string | null } } | null
  error: string | null
}
interface Overview {
  enabled: boolean
  reason: string | null
  destination: Destination | null
  copy: Destination | null
  encrypted: boolean
  job: Job | null
  busy: { what: string | null; started_at: string | null } | null
  backups: BackupRow[]
}

const api = useApi()
const ui = useUiStore()
const { busy, run } = useAction()
const { data, refresh, status, error } = await useAsyncData('backups', () => api.get<Overview>('/backups'), { lazy: true })

const running = computed(() => data.value?.job?.state === 'running' || Boolean(data.value?.busy))
let timer: ReturnType<typeof setInterval> | null = null
watch(
  running,
  (on) => {
    if (!import.meta.client) return
    if (on && !timer) timer = setInterval(() => refresh(), 2000)
    if (!on && timer) {
      clearInterval(timer)
      timer = null
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => timer && clearInterval(timer))

async function create() {
  const res = await run('create', () => api.post<{ job: Job }>('/backups'))
  if (res) await refresh()
}

async function verify(b: BackupRow) {
  const res = await run(`verify-${b.name}`, () => api.post<{ ok: boolean; deep: boolean; errors: string[] }>(`/backups/${b.name}/verify`))
  if (!res) return
  if (res.ok) ui.success('Backup verified', res.deep ? 'Every checksum, the database dump and every file are intact.' : 'The file is intact. The encrypted contents were not opened.')
  else ui.error('Verification failed', res.errors[0] ?? 'The backup is damaged.')
  await refresh()
}

const size = (n: number | null | undefined) => (n == null ? '—' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`)

const STATUS: Record<BackupRow['status'], { tone: Tone; label: string }> = {
  VERIFIED: { tone: 'success', label: 'Verified' },
  VERIFIED_WITH_WARNINGS: { tone: 'warning', label: 'Verified, with warnings' },
  FAILED: { tone: 'danger', label: 'Failed verification' },
  PACKAGE_MISSING: { tone: 'danger', label: 'File missing' },
  NO_RECORD: { tone: 'neutral', label: 'Not verified yet' },
}
</script>

<template>
  <div class="fv-rise">
    <PageHeader
      eyebrow="Administration"
      title="Backups"
      description="Full backups of the database and every uploaded document, verified by checksum and copied to a second drive."
    >
      <template v-if="data?.enabled" #actions>
        <button class="btn btn-primary" :disabled="running || busy === 'create'" :aria-busy="busy === 'create'" @click="create">
          <FIcon :name="running ? 'loader' : 'hard-drive'" :size="16" :class="running && 'animate-spin'" /> {{ running ? 'Backing up…' : 'Create full backup' }}
        </button>
      </template>
    </PageHeader>

    <AsyncState :status="status" :ready="Boolean(data)" :error="error" variant="list" :rows="4" what="the backups" :messages="['Loading backups…']" @retry="refresh()">

    <section v-if="data && !data.enabled" class="card card-pad max-w-3xl">
      <h2 class="text-lg">Backups are not available on this server</h2>
      <p class="mt-2 text-sm text-ink-body">{{ data.reason }}</p>
      <p class="mt-3 text-sm text-ink-body">
        On the backup computer, the server operator runs <code class="mono">npm run backup -- full</code>. See <span class="mono">docs/BACKUP_AND_RECOVERY.md</span>.
      </p>
    </section>

    <template v-else-if="data">
      <!-- Destinations -->
      <div class="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <section class="card card-pad">
          <p class="eyebrow mb-1.5">On this computer</p>
          <template v-if="data.destination?.ok">
            <p class="text-sm font-semibold">{{ data.destination.label }}</p>
            <p class="mt-1 text-xs text-ink-2">{{ size(data.destination.free_bytes) }} free{{ data.encrypted ? ' · packages are encrypted' : '' }}</p>
          </template>
          <p v-else class="text-sm text-danger-ink">{{ data.destination?.error }}</p>
        </section>
        <section class="card card-pad">
          <p class="eyebrow mb-1.5">Second destination (external drive)</p>
          <p v-if="!data.copy" class="text-sm text-amber-ink">Not configured: backups exist on this computer only. Set BACKUP_COPY_DIR to a folder on an external drive.</p>
          <template v-else-if="data.copy.ok">
            <p class="text-sm font-semibold">{{ data.copy.label }}</p>
            <p class="mt-1 text-xs text-ink-2">{{ size(data.copy.free_bytes) }} free · every new backup is copied and verified there</p>
          </template>
          <p v-else class="text-sm text-danger-ink">{{ data.copy.error }}</p>
        </section>
      </div>

      <!-- Current job -->
      <section v-if="data.job || data.busy" class="card card-pad mb-6" aria-live="polite">
        <template v-if="data.job?.state === 'running'">
          <p class="flex items-center gap-2 text-sm font-semibold"><FIcon name="loader" :size="16" class="animate-spin" /> {{ data.job.step }}…</p>
          <p class="mt-1 text-xs text-ink-2">Started {{ formatDateTime(data.job.started_at) }} by {{ data.job.started_by }}. You can leave this page; the backup continues.</p>
        </template>
        <p v-else-if="data.busy" class="text-sm">Another backup job is running on this computer ({{ data.busy.what }}). Wait for it to finish.</p>
        <template v-else-if="data.job?.state === 'failed'">
          <p class="text-sm font-semibold text-danger-ink">The last backup failed: nothing was kept from it, and earlier backups are untouched.</p>
          <p class="mt-1 text-sm text-ink-body">{{ data.job.error }}</p>
        </template>
        <template v-else-if="data.job?.result">
          <p class="text-sm font-semibold">Backup {{ data.job.result.name }} created and verified ({{ size(data.job.result.bytes) }}).</p>
          <p v-if="data.job.result.copy.ok" class="mt-1 text-sm text-sage-ink">Copied and verified on {{ data.job.result.copy.destination }}: it exists in two places.</p>
          <p v-else-if="data.job.result.copy.attempted" class="mt-1 text-sm text-danger-ink">
            Not copied to {{ data.job.result.copy.destination }}: {{ data.job.result.copy.error }} It exists on this computer only.
          </p>
          <p v-else class="mt-1 text-sm text-amber-ink">It exists on this computer only.</p>
        </template>
      </section>

      <!-- History -->
      <section class="card overflow-hidden">
        <EmptyState v-if="!data.backups.length" icon="hard-drive" title="No backups yet" description="Create the first full backup, then keep a copy on an external drive." />
        <ul v-else class="divide-y divide-line/60">
          <li v-for="b in data.backups" :key="b.name" class="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-center">
            <div class="min-w-0 flex-1">
              <p class="flex flex-wrap items-center gap-2 text-sm font-semibold">
                {{ b.created_at ? formatDateTime(b.created_at) : b.name }}
                <ToneBadge :tone="STATUS[b.status].tone" dot>{{ STATUS[b.status].label }}</ToneBadge>
                <ToneBadge v-if="b.encrypted" tone="neutral" icon="lock">Encrypted</ToneBadge>
                <ToneBadge v-if="b.copies.length" tone="success" icon="copy">Also on {{ b.copies.map((c) => c.destination).join(', ') }}</ToneBadge>
                <ToneBadge v-else tone="warning">This computer only</ToneBadge>
              </p>
              <p class="mono mt-0.5 truncate text-xs text-ink-2">{{ b.name }} · full · {{ size(b.bytes) }}</p>
              <p v-if="b.summary" class="mt-0.5 text-xs text-ink-body">
                {{ b.summary.tables }} tables, {{ b.summary.rows }} rows, {{ b.summary.files_in_package + b.summary.files_in_database }} files<template v-if="b.summary.files_missing">, <span class="text-danger-ink">{{ b.summary.files_missing }} missing</span></template>
                <template v-if="b.last_verify"> · last verified {{ formatDateTime(b.last_verify.at) }}</template>
              </p>
              <p v-for="w in b.warnings" :key="w" class="mt-0.5 text-xs text-amber-ink">{{ w }}</p>
              <p v-for="e in b.last_verify?.errors ?? []" :key="e" class="mt-0.5 text-xs text-danger-ink">{{ e }}</p>
            </div>
            <div class="flex gap-1">
              <button class="btn btn-sm btn-ghost border-0" :disabled="!b.present || busy === `verify-${b.name}`" :aria-busy="busy === `verify-${b.name}`" @click="verify(b)">
                <FIcon name="check-circle" :size="14" /> Verify
              </button>
              <a v-if="b.present && b.status !== 'FAILED'" class="btn btn-sm btn-ghost border-0" :href="`/api/backups/${b.name}/download`" download>
                <FIcon name="download" :size="14" /> Download
              </a>
            </div>
          </li>
        </ul>
      </section>

      <section class="card card-pad mt-6 max-w-3xl">
        <h2 class="text-lg">Restoring</h2>
        <p class="mt-1 text-sm text-ink-body">
          Restoring replaces data, so it is done on the server from the command line, never from this page. First into an empty, separate database:
          <code class="mono">npm run backup -- restore --package &lt;name&gt; --files-dir &lt;empty folder&gt;</code>, which verifies the backup and checks every document and file afterwards.
          The steps for a real recovery are in <span class="mono">docs/BACKUP_AND_RECOVERY.md</span> and in the RESTORE.md inside every backup.
        </p>
      </section>
    </template>
    </AsyncState>
  </div>
</template>
