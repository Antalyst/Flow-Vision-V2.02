<script setup lang="ts">
defineProps<{ authority: boolean; officeName?: string | null }>()
</script>

<template>
  <div
    class="flex items-start gap-4 rounded-2xl border p-5"
    :class="authority ? 'border-sage/40 bg-sage/12' : 'border-info/35 bg-info/10'"
    role="status"
  >
    <span class="grid size-11 shrink-0 place-items-center rounded-xl text-white" :class="authority ? 'bg-sage' : 'bg-info'">
      <FIcon :name="authority ? 'shield' : 'eye'" :size="20" />
    </span>
    <div>
      <p class="font-display text-[15px] font-bold tracking-wide" :class="authority ? 'text-sage-ink' : 'text-info-ink'">
        {{ authority ? 'YOU CAN APPROVE DOCUMENTS' : 'YOU CANNOT APPROVE DOCUMENTS' }}
      </p>
      <p class="mt-1 text-sm text-ink-body">
        <template v-if="authority">
          {{ officeName }} is the last office on your organization's route. You can approve or return documents that reach it.
        </template>
        <template v-else>
          {{ officeName ?? 'Your office' }} is not the last office on the route. You can view any document's timeline, but only staff at the last
          office can approve.
        </template>
      </p>
    </div>
  </div>
</template>
