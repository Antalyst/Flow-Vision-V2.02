<script setup lang="ts">
/** Organization Settings: the logo printed on every QR label and on document templates. */
const props = defineProps<{ logoUrl: string | null }>()
const emit = defineEmits<{ changed: [] }>()

const api = useApi()
const ui = useUiStore()
const auth = useAuthStore()
const { busy, run } = useAction()
const input = ref<HTMLInputElement | null>(null)

async function upload(file?: File | null) {
  if (!file) return
  if (!/^image\/(png|jpe?g)$/.test(file.type)) return ui.error('Use a PNG or JPG image')
  if (file.size > 2 * 1024 * 1024) return ui.error('Image too large', 'Logos can be up to 2 MB.')
  const fd = new FormData()
  fd.append('file', file)
  const ok = await run('logo', () => api.post('/org/logo', fd), 'Logo saved — it now prints on QR labels')
  if (input.value) input.value.value = ''
  if (ok) done()
}

async function remove() {
  await ui.confirm({
    title: 'Remove the logo?',
    body: 'QR labels and document templates print without a logo until you upload another one.',
    confirmLabel: 'Remove logo',
    busyLabel: 'Removing…',
    action: async () => {
      if (await run('logo-del', () => api.del('/org/logo'), 'Logo removed')) done()
    },
  })
}

function done() {
  emit('changed')
  // The QR printer reads the logo from the signed-in user's organization.
  auth.fetchMe().catch(() => {})
}
</script>

<template>
  <section class="card card-pad max-w-2xl">
    <h2 class="text-lg">Logo</h2>
    <p class="mt-1 text-sm text-ink-body">Printed at the top of every document QR label and on the letterhead of your document templates. PNG or JPG, up to 2 MB.</p>
    <div class="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center">
      <div class="grid size-28 shrink-0 place-items-center overflow-hidden rounded-2xl border border-dashed border-line bg-white">
        <img v-if="props.logoUrl" :src="props.logoUrl" alt="Organization logo" class="max-h-24 max-w-24 object-contain" />
        <FIcon v-else name="image" :size="28" class="text-ink-3" />
      </div>
      <div class="flex flex-wrap gap-2">
        <input ref="input" type="file" accept="image/png,image/jpeg" class="sr-only" @change="upload(($event.target as HTMLInputElement).files?.[0])" />
        <button class="btn btn-primary" :disabled="!!busy" :aria-busy="busy === 'logo'" @click="input?.click()">
          <FIcon name="upload" :size="16" /> {{ busy === 'logo' ? 'Uploading…' : props.logoUrl ? 'Replace logo' : 'Upload logo' }}
        </button>
        <button v-if="props.logoUrl" class="btn btn-ghost text-danger-ink" :disabled="!!busy" :aria-busy="busy === 'logo-del'" @click="remove"><FIcon name="trash-2" :size="16" /> Remove</button>
      </div>
    </div>
  </section>
</template>
