import { defineStore } from 'pinia'

export interface Toast {
  id: number
  tone: 'success' | 'danger' | 'info'
  title: string
  body?: string
  link?: string
}

export const useUiStore = defineStore('ui', () => {
  const toasts = ref<Toast[]>([])
  const sidebarOpen = ref(false)
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

  return { toasts, sidebarOpen, toast, dismiss, success, error, info }
})
