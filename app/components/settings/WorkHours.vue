<script setup lang="ts">
import type { HolidayItem, WorkCalendarSettings } from '~/types'
import { describeCalendar, parseClock, WEEKDAYS } from '#shared/work-calendar'

/**
 * Organization Settings: the working hours, working days and holidays. Processing time only runs
 * inside them — after hours, on days off and on holidays a document's clock is paused.
 */
const props = defineProps<{ calendar: WorkCalendarSettings; holidays: HolidayItem[] }>()
const emit = defineEmits<{ changed: [] }>()

const api = useApi()
const ui = useUiStore()
const { busy, run } = useAction()

// Monday first, the way offices plan their week.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
const form = reactive({ work_start: '08:00', work_end: '17:00', work_days: [1, 2, 3, 4, 5] as number[] })
watch(
  () => props.calendar,
  (c) => Object.assign(form, { work_start: c.work_start, work_end: c.work_end, work_days: [...c.work_days] }),
  { immediate: true },
)

const startMin = computed(() => parseClock(form.work_start))
const endMin = computed(() => parseClock(form.work_end))
const hoursPerDay = computed(() => (startMin.value != null && endMin.value != null && endMin.value > startMin.value ? (endMin.value - startMin.value) / 60 : 0))
const formError = computed(() => {
  if (startMin.value == null || endMin.value == null) return 'Enter both times.'
  if (endMin.value <= startMin.value) return 'The end of work must be later than the start.'
  if (!form.work_days.length) return 'Pick at least one working day.'
  return ''
})
const summary = computed(() =>
  formError.value ? '' : describeCalendar({ start: startMin.value!, end: endMin.value!, days: form.work_days, holidays: [], recurring: [] }),
)

function toggleDay(d: number) {
  form.work_days = form.work_days.includes(d) ? form.work_days.filter((x) => x !== d) : [...form.work_days, d].sort()
}

const moved = (n: number) => (n ? ` · ${n} deadline${n === 1 ? '' : 's'} moved` : '')

async function save() {
  if (formError.value) return
  const res = await run('hours', () => api.put<{ rescheduled: number }>('/org/work-hours', { ...form }))
  if (res) {
    ui.success('Working hours saved', `Processing time now counts ${summary.value}${moved(res.rescheduled)}.`)
    emit('changed')
  }
}

async function aroundTheClock() {
  await ui.confirm({
    title: 'Count around the clock?',
    body: 'Processing time will run day and night, every day (holidays still pause it). Deadlines of documents in progress move to match.',
    confirmLabel: 'Count around the clock',
    busyLabel: 'Saving…',
    action: async () => {
      const res = await run('hours-off', () => api.del<{ rescheduled: number }>('/org/work-hours'))
      if (res) {
        ui.success('Working hours turned off', `Processing time counts around the clock${moved(res.rescheduled)}.`)
        emit('changed')
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------
const holiday = reactive({ date: '', name: '', recurring: false })
const sorted = computed(() => [...props.holidays].sort((a, b) => a.date.localeCompare(b.date)))
const holidayDate = new Intl.DateTimeFormat('en-PH', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const holidayDay = new Intl.DateTimeFormat('en-PH', { month: 'long', day: 'numeric', timeZone: 'UTC' })
const dateLabel = (h: HolidayItem) => (h.recurring ? `Every ${holidayDay.format(new Date(`${h.date}T00:00:00Z`))}` : holidayDate.format(new Date(`${h.date}T00:00:00Z`)))
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())
const isPast = (h: HolidayItem) => !h.recurring && h.date < today

async function addHoliday() {
  if (!holiday.date || !holiday.name.trim()) return
  const res = await run('holiday', () => api.post<{ rescheduled: number }>('/org/holidays', { ...holiday, name: holiday.name.trim() }))
  if (res) {
    ui.success('Holiday added', `${holiday.name.trim()} won't count toward processing time${moved(res.rescheduled)}.`)
    Object.assign(holiday, { date: '', name: '', recurring: false })
    emit('changed')
  }
}

async function removeHoliday(h: HolidayItem) {
  await ui.confirm({
    title: `Remove “${h.name}”?`,
    body: 'That day counts as a working day again.',
    confirmLabel: 'Remove holiday',
    busyLabel: 'Removing…',
    action: async () => {
      const res = await run(`hol-${h.id}`, () => api.del<{ rescheduled: number }>(`/org/holidays/${h.id}`))
      if (res) {
        ui.success('Holiday removed', moved(res.rescheduled).replace(' · ', '') || undefined)
        emit('changed')
      }
    },
  })
}
</script>

<template>
  <div class="space-y-6">
    <div v-if="!calendar.available" class="flex items-start gap-3 rounded-2xl border border-amber/40 bg-amber/12 p-4 text-sm text-amber-ink">
      <FIcon name="alert-triangle" :size="18" class="mt-0.5 shrink-0" />
      <span>Working hours, holidays and templates need their database tables first. Run <code class="mono">npm run db:add-settings</code> on the server, then reload this page.</span>
    </div>

    <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <!-- Working hours -->
      <section class="card card-pad h-fit">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 class="text-lg">Working hours</h2>
            <p class="mt-1 text-sm text-ink-body">Processing time only counts while the organization works. After hours and on days off a document's clock pauses, and it picks up again at the next start of work.</p>
          </div>
          <ToneBadge :tone="calendar.configured ? 'success' : 'neutral'" dot>{{ calendar.configured ? 'In use' : 'Not set' }}</ToneBadge>
        </div>
        <p v-if="!calendar.configured" class="mt-3 rounded-xl bg-ink/[0.035] px-3 py-2 text-[13px] text-ink-body">
          Not set yet: processing time runs around the clock. Save your hours to start pausing it outside them.
        </p>

        <form class="mt-5 space-y-4" @submit.prevent="save">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="field-label" for="work-start">Start of work</label>
              <input id="work-start" v-model="form.work_start" type="time" class="input" required />
            </div>
            <div>
              <label class="field-label" for="work-end">End of work</label>
              <input id="work-end" v-model="form.work_end" type="time" class="input" required />
            </div>
          </div>
          <fieldset>
            <legend class="field-label">Working days</legend>
            <div class="flex flex-wrap gap-1.5">
              <label
                v-for="d in DAY_ORDER"
                :key="d"
                class="flex min-h-10 cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm transition-colors"
                :class="form.work_days.includes(d) ? 'border-ink bg-ink text-white' : 'border-line bg-white/60 text-ink-body hover:border-ink/30'"
              >
                <input type="checkbox" class="sr-only" :checked="form.work_days.includes(d)" @change="toggleDay(d)" />
                {{ WEEKDAYS[d]!.slice(0, 3) }}
              </label>
            </div>
          </fieldset>
          <p v-if="formError" class="text-xs text-danger-ink">{{ formError }}</p>
          <p v-else class="text-xs text-ink-2">
            {{ summary }} · {{ hoursPerDay % 1 ? hoursPerDay.toFixed(1) : hoursPerDay }} hours a day. In document types, 1 day of processing time = one working day ({{ hoursPerDay % 1 ? hoursPerDay.toFixed(1) : hoursPerDay }} working hours).
          </p>
          <div class="flex flex-wrap justify-end gap-2">
            <button v-if="calendar.configured" type="button" class="btn btn-ghost" :disabled="!!busy" :aria-busy="busy === 'hours-off'" @click="aroundTheClock">Count around the clock</button>
            <button class="btn btn-primary" :disabled="!!busy || !!formError || !calendar.available" :aria-busy="busy === 'hours'">{{ busy === 'hours' ? 'Saving…' : 'Save working hours' }}</button>
          </div>
        </form>
      </section>

      <!-- Holidays -->
      <section class="card overflow-hidden">
        <div class="card-pad pb-3">
          <h2 class="text-lg">Holidays and no-work days</h2>
          <p class="mt-1 text-sm text-ink-body">Days the organization doesn't work even though they fall on a working day. Processing time pauses for the whole day.</p>
          <form class="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-[150px_minmax(0,1fr)]" @submit.prevent="addHoliday">
            <div>
              <label class="sr-only" for="holiday-date">Date</label>
              <input id="holiday-date" v-model="holiday.date" type="date" class="input" required />
            </div>
            <div>
              <label class="sr-only" for="holiday-name">Name</label>
              <input id="holiday-name" v-model="holiday.name" class="input" maxlength="150" placeholder="e.g. Independence Day" required />
            </div>
            <label class="flex items-center gap-2 text-sm text-ink-body sm:col-span-2">
              <input v-model="holiday.recurring" type="checkbox" class="size-4 accent-[var(--lumio-accent-primary)]" /> Repeats every year on this date
            </label>
            <button class="btn btn-primary justify-center sm:col-span-2" :disabled="!!busy || !holiday.date || !holiday.name.trim() || !calendar.available" :aria-busy="busy === 'holiday'">
              <FIcon name="plus" :size="16" /> Mark as holiday
            </button>
          </form>
        </div>
        <div v-if="!sorted.length" class="px-6 pb-6">
          <EmptyState icon="calendar" title="No holidays yet" description="Add the days your organization doesn't work." />
        </div>
        <ul v-else class="max-h-[420px] divide-y divide-line/60 overflow-y-auto border-t border-line/60">
          <li v-for="h in sorted" :key="h.id" class="flex items-center gap-3 px-5 py-3" :class="isPast(h) && 'opacity-55'">
            <span class="grid size-9 shrink-0 place-items-center rounded-xl" :class="TONE_CLASSES[h.recurring ? 'info' : 'primary']"><FIcon :name="h.recurring ? 'repeat' : 'calendar'" :size="15" /></span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold">{{ h.name }}</p>
              <p class="text-xs text-ink-2">{{ dateLabel(h) }}<template v-if="isPast(h)"> · past</template></p>
            </div>
            <button class="btn btn-sm btn-ghost text-danger-ink" title="Remove" :disabled="busy === `hol-${h.id}`" :aria-busy="busy === `hol-${h.id}`" @click="removeHoliday(h)">
              <FIcon name="trash-2" :size="14" />
            </button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
