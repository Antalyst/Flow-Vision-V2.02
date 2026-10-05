import { defineStore } from 'pinia'
import type { AppNotification } from '~/types'

export const useNotificationsStore = defineStore('notifications', () => {
  const items = ref<AppNotification[]>([])
  const unread = ref(0)
  const loaded = ref(false)

  async function load() {
    const res = await useApi().get<{ data: AppNotification[]; unread: number }>('/notifications', { limit: 50 })
    items.value = res.data
    unread.value = res.unread
    loaded.value = true
  }

  /** Load once per session — called by the route middleware so SSR renders the right badge. */
  async function ensureLoaded() {
    if (!loaded.value) await load().catch(() => {})
  }

  function reset() {
    items.value = []
    unread.value = 0
    loaded.value = false
  }

  async function markRead(n: AppNotification) {
    if (n.is_read) return
    n.is_read = true
    unread.value = Math.max(0, unread.value - 1)
    await useApi().patch(`/notifications/${n.id}/read`).catch(() => {})
  }

  async function markAllRead() {
    items.value.forEach((n) => (n.is_read = true))
    unread.value = 0
    await useApi().post('/notifications/read-all')
  }

  /** Called for every pushed notification: bump the badge and refresh the list in the background. */
  function received() {
    unread.value += 1
    load().catch(() => {})
  }

  return { items, unread, loaded, load, ensureLoaded, reset, markRead, markAllRead, received }
})
