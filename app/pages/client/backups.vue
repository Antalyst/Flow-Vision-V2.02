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
interface Run {
  at: string
  status: 'ok' | 'incomplete' | 'failed'
  code: string | null
  message: string | null
  detail: Record<string, string | number | boolean | null> | null
}
interface JobHealth {
  last_run: Run | null
  last_ok: Run | null
  last_failure: Run | null
}
type HealthJob = 'full' | 'copy' | 'snapshot' | 'forget' | 'check' | 'check_read_data' | 'restore_test'
interface Overview {
  enabled: boolean
  reason: string | null
  destination: Destination | null
  copy: Destination | null
  encrypted: boolean
  encryption: { configured: boolean; plain_allowed: boolean } | null
  health: Partial<Record<HealthJob, JobHealth>> | null
  restic: { last_snapshot: string; restore_tested_at: string | null; files_missing: number } | null
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

// The recorded outcome of each job (backup-health.json), judged by how long ago it last succeeded.
const DAY = 24 * 60 * 60 * 1000
const HEALTH_ROWS: Array<{ job: HealthJob; label: string; due: string; maxAge: number }> = [
  { job: 'full', label: 'Full backup', due: 'weekly', maxAge: 8 * DAY },
  { job: 'copy', label: 'Copy on the external drive', due: 'with each full backup', maxAge: 8 * DAY },
  { job: 'snapshot', label: 'Daily snapshot (Restic)', due: 'daily', maxAge: 26 * 60 * 60 * 1000 },
  { job: 'check_read_data', label: 'Full read of the snapshot repository', due: 'monthly', maxAge: 32 * DAY },
  { job: 'restore_test', label: 'Test restore into a separate database', due: 'monthly', maxAge: 32 * DAY },
]
const healthRows = computed(() =>
  HEALTH_ROWS.map((row) => {
    const h = data.value?.health?.[row.job] ?? null
    const ok = h?.last_ok ?? null
    const lastRun = h?.last_run ?? null
    const failedSince = lastRun && lastRun.status !== 'ok' && (!ok || lastRun.at > ok.at) ? lastRun : null
    const overdue = !ok || Date.now() - new Date(ok.at).getTime() > row.maxAge
    const state: { tone: Tone; label: string } = !lastRun
      ? { tone: 'neutral', label: 'Never recorded' }
      : failedSince?.status === 'failed'
        ? { tone: 'danger', label: 'Last run failed' }
        : failedSince?.status === 'incomplete'
          ? { tone: 'warning', label: 'Last run incomplete' }
          : overdue
            ? { tone: 'warning', label: 'Overdue' }
            : { tone: 'success', label: 'Up to date' }
    return { ...row, ok, failedSince, state }
  }),
)

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

      <section v-if="data.encryption && !data.encryption.configured" class="card card-pad mb-6 border-danger/40" role="alert">
        <p class="text-sm font-semibold text-danger-ink">{{ data.encryption.plain_allowed ? 'Test mode: backups of this local test database are not encrypted.' : 'New backups will be refused: no encryption passphrase is configured.' }}</p>
        <p class="mt-1 text-sm text-ink-body">Backups are always encrypted. The server operator sets BACKUP_PASSPHRASE_FILE and keeps the passphrase somewhere other than this computer and the backup drive.</p>
      </section>

      <!-- Health: what the jobs actually did (recorded by each run), not what is scheduled -->
      <section class="card mb-6 overflow-hidden" aria-labelledby="backup-health-title">
        <div class="px-5 pt-4">
          <h2 id="backup-health-title" class="text-lg">Backup health</h2>
          <p class="mt-0.5 text-xs text-ink-2">The last recorded result of each job, whether it ran on a schedule, from the command line or from this page.</p>
        </div>
        <ul class="mt-3 divide-y divide-line/60">
          <li v-for="r in healthRows" :key="r.job" class="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-start sm:gap-4">
            <div class="min-w-0 flex-1">
              <p class="text-sm font-semibold">{{ r.label }} <span class="text-xs font-normal text-ink-2">· {{ r.due }}</span></p>
              <p class="mt-0.5 text-xs text-ink-body">
                Last success: {{ r.ok ? formatDateTime(r.ok.at) : 'none recorded' }}
                <template v-if="r.job === 'snapshot' && data.restic"> · snapshot {{ data.restic.last_snapshot }}, restore-tested {{ data.restic.restore_tested_at ? formatDateTime(data.restic.restore_tested_at) : 'no' }}</template>
              </p>
              <p v-if="r.failedSince" class="mt-0.5 break-words text-xs" :class="r.failedSince.status === 'failed' ? 'text-danger-ink' : 'text-amber-ink'">
                {{ formatDateTime(r.failedSince.at) }}: {{ r.failedSince.message ?? (r.failedSince.detail?.files_missing ? `${r.failedSince.detail.files_missing} referenced file(s) missing from it` : r.failedSince.code) }}
              </p>
            </div>
            <ToneBadge :tone="r.state.tone" dot class="self-start">{{ r.state.label }}</ToneBadge>
          </li>
        </ul>
      </section>

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
