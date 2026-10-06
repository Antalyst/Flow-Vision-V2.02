<script setup lang="ts">
import type { ConfirmOptions } from '~/stores/ui'

/** Renders ui.confirm() requests. Mounted once in app.vue, like ToastHost. */
const ui = useUiStore()
const busy = ref(false)
const confirmBtn = ref<HTMLButtonElement>()
const cancelBtn = ref<HTMLButtonElement>()
// Kept after the request settles so the text doesn't vanish during the leave animation.
const shown = shallowRef<ConfirmOptions>({ title: '' })

const open = computed(() => Boolean(ui.confirmRequest))
const danger = computed(() => (shown.value.tone ?? 'danger') === 'danger')

watch(
  () => ui.confirmRequest,
  async (req) => {
    if (!req) return
    shown.value = req
    busy.value = false
    await nextTick()
    // A destructive question starts on Cancel so a stray Enter doesn't delete anything.
    ;(danger.value ? cancelBtn : confirmBtn).value?.focus()
  },
)

function settle(ok: boolean) {
  const req = ui.confirmRequest
  if (!req) return
  ui.confirmRequest = null
  req.resolve(ok)
}

function cancel() {
  if (!busy.value) settle(false)
}

async function accept() {
  const req = ui.confirmRequest
  if (!req || busy.value) return
  if (req.action) {
    busy.value = true
    try {
      await req.action()
    } catch (err) {
      ui.error('Action failed', apiErrorMessage(err))
      busy.value = false
      return settle(false)
    }
    busy.value = false
  }
  settle(true)
}
</script>

<template>
  <AppModal :open="open" :title="shown.title" width="sm" top @close="cancel">
    <div class="flex items-start gap-4">
      <span
        class="grid size-11 shrink-0 place-items-center rounded-2xl"
        :class="danger ? 'bg-danger/12 text-danger-ink' : 'bg-ink/5 text-ink'"
      >
        <FIcon :name="shown.icon ?? (danger ? 'alert-triangle' : 'help-circle')" :size="20" />
      </span>
      <p class="pt-1 text-[15px] text-ink-body">{{ shown.body ?? 'Are you sure?' }}</p>
    </div>
    <template #footer>
      <button ref="cancelBtn" class="btn btn-ghost" :disabled="busy" @click="cancel">Cancel</button>
      <button
        ref="confirmBtn"
        class="btn"
        :class="danger ? 'btn-danger' : 'btn-primary'"
        :disabled="busy"
        :aria-busy="busy"
        @click="accept"
      >
        {{ busy ? (shown.busyLabel ?? 'Working…') : (shown.confirmLabel ?? 'Confirm') }}
      </button>
    </template>
  </AppModal>
</template>
