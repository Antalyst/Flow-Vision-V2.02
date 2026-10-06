import { defineStore } from 'pinia'

export interface Toast {
  id: number
  tone: 'success' | 'danger' | 'info'
  title: string
  body?: string
  link?: string
}

export interface ConfirmOptions {
  title: string
  body?: string
  confirmLabel?: string
  /** Shown on the confirm button while `action` runs, e.g. "Deleting…". */
  busyLabel?: string
  tone?: 'danger' | 'primary'
  icon?: string
  /**
   * Runs after the person confirms, with the dialog kept open and its button spinning
   * until it settles, so the confirmation and its result read as one step.
   */
  action?: () => Promise<unknown>
}

interface ConfirmRequest extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

export const useUiStore = defineStore('ui', () => {
  const toasts = ref<Toast[]>([])
  const sidebarOpen = ref(false)
  const confirmRequest = shallowRef<ConfirmRequest | null>(null)
  let nextId = 1

  function toast(t: Omit<Toast, 'id'>, ttl = 4500) {
    const id = nextId++
    toasts.value.push({ id, ...t })
    setTimeout(() => dismiss(id), ttl)
  }
  function dismiss(id: number) {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  const success = (title: string, body?: string) => toast({ tone: 'success', title, body })
  const error = (title: string, body?: string) => toast({ tone: 'danger', title, body }, 7000)
  const info = (title: string, body?: string, link?: string) => toast({ tone: 'info', title, body, link })

  /** Ask before a consequential action. Resolves true once confirmed (and `action`, if given, has run). */
  function confirm(options: ConfirmOptions) {
    confirmRequest.value?.resolve(false)
    return new Promise<boolean>((resolve) => {
      confirmRequest.value = { ...options, resolve }
    })
  }

  return { toasts, sidebarOpen, confirmRequest, toast, dismiss, success, error, info, confirm }
})
