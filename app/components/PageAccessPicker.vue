<script setup lang="ts">
import { allPagesOf, GRANTABLE_PAGES } from '#shared/page-access'
import type { AccountType } from '~/types'

// Choose which pages an account may open. null = every page of its role (also the default for new accounts).
// The dashboard, notifications and profile are always open.
const props = defineProps<{ role: AccountType; disabled?: boolean }>()
const model = defineModel<string[] | null>({ required: true })

const auth = useAuthStore()

// A manager whose own pages are limited can't hand out a page of their own role they don't have.
function canGrant(path: string) {
  const own = auth.user?.page_access
  if (!own || !auth.role) return true
  return !allPagesOf(auth.role).includes(path) || own.includes(path)
}

const pages = computed(() => GRANTABLE_PAGES[props.role])
const grantable = computed(() => pages.value.filter((p) => canGrant(p.path)).map((p) => p.path))
const groups = computed(() => {
  const out: Record<string, typeof pages.value> = {}
  for (const p of pages.value) (out[p.group] ??= []).push(p)
  return out
})

const allPages = computed(() => model.value === null)
const isOn = (path: string) => (model.value === null ? canGrant(path) : model.value.includes(path))

function setAll(on: boolean) {
  model.value = on ? null : [...grantable.value]
}

function toggle(path: string, on: boolean) {
  const current = new Set(model.value ?? grantable.value)
  if (on) current.add(path)
  else current.delete(path)
  model.value = allPagesOf(props.role).filter((p) => current.has(p))
}
</script>

<template>
  <fieldset :disabled="disabled">
    <legend class="field-label">Page access</legend>
    <label class="mb-2 flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" class="size-4 accent-[var(--lumio-accent-primary)]" :checked="allPages" @change="setAll(($event.target as HTMLInputElement).checked)" />
      <span class="font-medium">Every page for this role</span>
    </label>
    <div class="space-y-3 rounded-xl border border-line p-3" :class="allPages && 'opacity-60'">
      <div v-for="(items, group) in groups" :key="group">
        <p class="eyebrow mb-1.5">{{ group }}</p>
        <div class="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          <label v-for="p in items" :key="p.path" class="flex items-center gap-2 text-sm" :class="canGrant(p.path) ? 'cursor-pointer' : 'cursor-not-allowed text-ink-2'">
            <input
              type="checkbox"
              class="size-4 accent-[var(--lumio-accent-primary)]"
              :checked="isOn(p.path)"
              :disabled="allPages || !canGrant(p.path)"
              @change="toggle(p.path, ($event.target as HTMLInputElement).checked)"
            />
            {{ p.label }}
          </label>
        </div>
      </div>
    </div>
    <p class="field-hint">The dashboard, notifications and profile are always available. Untick "Every page" to choose.</p>
  </fieldset>
</template>
