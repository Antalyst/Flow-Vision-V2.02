<script setup lang="ts">
/** Days + hours a document type may take to process (Organization Settings). 0 + 0 = no deadline. */
const days = defineModel<number>('days', { required: true })
const hours = defineModel<number>('hours', { required: true })
// `working`: the organization set working hours, so days are working days and hours working hours.
const props = defineProps<{ id: string; working?: boolean }>()
const d = computed(() => Number(days.value) || 0)
const h = computed(() => Number(hours.value) || 0)
</script>

<template>
  <fieldset>
    <legend class="field-label">Processing time</legend>
    <div class="flex flex-wrap items-center gap-2">
      <div class="relative w-28">
        <label class="sr-only" :for="`${props.id}-days`">Days</label>
        <input :id="`${props.id}-days`" v-model.number="days" type="number" min="0" max="365" step="1" class="input pr-12" />
        <span class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-ink-2">days</span>
      </div>
      <div class="relative w-28">
        <label class="sr-only" :for="`${props.id}-hours`">Hours</label>
        <input :id="`${props.id}-hours`" v-model.number="hours" type="number" min="0" max="23" step="1" class="input pr-10" />
        <span class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-ink-2">hrs</span>
      </div>
    </div>
    <p class="mt-1.5 text-xs text-ink-2">
      <template v-if="d || h">
        Documents of this type should be done within {{ processingLabel(d, h, !!props.working) }} of being submitted.
        <template v-if="props.working">Time outside working hours, on days off and on holidays doesn’t count.</template>
      </template>
      <template v-else>No time limit: these documents get no deadline.</template>
    </p>
  </fieldset>
</template>
