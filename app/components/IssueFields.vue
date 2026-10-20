<script setup lang="ts">
import { DESCRIPTION_REQUIRED, ISSUE_CATEGORIES, ISSUE_CATEGORY_META, ISSUE_DESCRIPTION_MAX, priorityOf, type IssueCategory } from '#shared/issue-categories'

/**
 * The fields of a new issue: what's wrong (title), its category — whose priority is shown read-only, it is
 * decided by the server from the category — and the details. "Other" asks what is wrong with the document
 * (required) in a separate box, so text typed there is never sent with another category, and the reverse.
 */
export interface IssueFieldsModel {
  title: string
  category: IssueCategory
  details: string
  otherText: string
}

const model = defineModel<IssueFieldsModel>({ required: true })
const props = withDefaults(defineProps<{ idPrefix?: string }>(), { idPrefix: 'issue' })

const PRIORITY_TONE = { LOW: 'neutral', MEDIUM: 'info', HIGH: 'warning', CRITICAL: 'danger' } as const
const priority = computed(() => priorityOf(model.value.category))
const needsDescription = computed(() => DESCRIPTION_REQUIRED.includes(model.value.category))
const id = (name: string) => `${props.idPrefix}-${name}`
</script>

<template>
  <div class="space-y-4">
    <div>
      <label class="field-label" :for="id('title')">What's wrong?</label>
      <input :id="id('title')" v-model="model.title" class="input" required maxlength="255" placeholder="e.g. Missing signature of the department head" />
    </div>
    <div class="grid grid-cols-1 items-end gap-4 sm:grid-cols-2">
      <div>
        <label class="field-label" :for="id('category')">Category</label>
        <select :id="id('category')" v-model="model.category" class="input">
          <option v-for="c in ISSUE_CATEGORIES" :key="c" :value="c">{{ ISSUE_CATEGORY_META[c].label }}</option>
        </select>
      </div>
      <div>
        <p class="field-label" :id="id('priority-label')">Priority</p>
        <p class="flex min-h-[42px] items-center gap-2" :aria-labelledby="id('priority-label')">
          <ToneBadge :tone="PRIORITY_TONE[priority]" dot>{{ priority.charAt(0) + priority.slice(1).toLowerCase() }}</ToneBadge>
          <span class="text-xs text-ink-2">Set by the category</span>
        </p>
      </div>
    </div>
    <div v-if="needsDescription">
      <label class="field-label" :for="id('other')">What's wrong with the document?</label>
      <textarea
        :id="id('other')"
        v-model="model.otherText"
        class="input"
        rows="3"
        required
        :maxlength="ISSUE_DESCRIPTION_MAX"
        placeholder="Describe the problem so the other office knows what to fix"
      />
    </div>
    <div v-else>
      <label class="field-label" :for="id('details')">Details <span class="font-normal text-ink-2">(optional)</span></label>
      <textarea :id="id('details')" v-model="model.details" class="input" rows="3" :maxlength="ISSUE_DESCRIPTION_MAX" />
    </div>
  </div>
</template>
