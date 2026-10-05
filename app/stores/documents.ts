import { defineStore } from 'pinia'

/**
 * Shared document state. `version` bumps whenever the server pushes a document
 * change, so any page listing documents can watch it and refetch.
 */
export const useDocumentsStore = defineStore('documents', () => {
  const version = ref(0)
  const lastChange = ref<{ id: string; status: string } | null>(null)

  function changed(payload: { id: string; status: string }) {
    lastChange.value = payload
    version.value += 1
  }

  return { version, lastChange, changed }
})
