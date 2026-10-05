import type { Ref } from 'vue'

/** A read-only copy of `source` that only updates after it stops changing for `ms`. */
export function refDebounced<T>(source: Ref<T>, ms = 300): Readonly<Ref<T>> {
  const debounced = ref(source.value) as Ref<T>
  let timer: ReturnType<typeof setTimeout> | undefined
  watch(source, (value) => {
    clearTimeout(timer)
    timer = setTimeout(() => (debounced.value = value), ms)
  })
  onScopeDispose(() => clearTimeout(timer))
  return readonly(debounced) as Readonly<Ref<T>>
}
