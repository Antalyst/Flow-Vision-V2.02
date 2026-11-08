import { defineStore } from 'pinia'
import type { AppNotification } from '~/types'

/** How many unread notifications the bell's dropdown shows (a display limit only). */
export const BELL_LIMIT = 10

export const useNotificationsStore = defineStore('notifications', () => {
  /** The latest notifications, read or not (the Notifications page). */
  const items = ref<AppNotification[]>([])
  /** The latest unread ones, newest first (the bell's dropdown). */
  const latestUnread = ref<AppNotification[]>([])
  /** Every unread notification of the account (the badge), from the server. */
  const unread = ref(0)
  const loaded = ref(false)
  const unreadLoaded = ref(false)
  // Bumped by reset() (sign-out): a response that arrives afterwards belongs to the previous account and is dropped.
  let session = 0
  // Notifications being marked read, so a second click doesn't send a second request.
  const reading = new Set<AppNotification['id']>()

  async function load() {
    const at = session
    const res = await useApi().get<{ data: AppNotification[]; unread: number }>('/notifications', { limit: 50 })
    if (at !== session) return
    items.value = res.data
    unread.value = res.unread
    loaded.value = true
  }

  /** The bell's list: only the latest unread ones, and the total unread count, in one request. */
  async function loadUnread() {
    const at = session
    const res = await useApi().get<{ data: AppNotification[]; unread: number }>('/notifications', { unread: 'true', limit: BELL_LIMIT })
    if (at !== session) return
    latestUnread.value = res.data
    unread.value = res.unread
    unreadLoaded.value = true
  }

  /** Load once per session — called by the route middleware so SSR renders the right badge. */
  async function ensureLoaded() {
    if (!loaded.value) await load().catch(() => {})
  }

  function reset() {
    session++
    reading.clear()
    items.value = []
    latestUnread.value = []
    unread.value = 0
    loaded.value = false
    unreadLoaded.value = false
  }

  /**
   * Mark one notification read (only that one). Nothing changes on screen until the database has it: then the
   * badge takes the server's unread total and both lists drop it. On failure it stays unread and the error is thrown.
   */
  async function markRead(n: AppNotification) {
    if (n.is_read || reading.has(n.id)) return
    const at = session
    reading.add(n.id)
    try {
      const res = await useApi().patch<{ unread?: number }>(`/notifications/${n.id}/read`)
      if (at !== session) return
      n.is_read = true
      const listed = items.value.find((x) => x.id === n.id)
      if (listed) listed.is_read = true
      latestUnread.value = latestUnread.value.filter((x) => x.id !== n.id)
      unread.value = typeof res.unread === 'number' ? res.unread : Math.max(0, unread.value - 1)
    } finally {
      reading.delete(n.id)
    }
  }

  /** Mark every notification read; the lists and badge change once the server has done it (else it throws). */
  async function markAllRead() {
    const at = session
    await useApi().post('/notifications/read-all')
    if (at !== session) return
    items.value.forEach((n) => (n.is_read = true))
    latestUnread.value = []
    unread.value = 0
  }

  /** Called for every pushed notification: bump the badge and refresh the lists in the background. */
  function received() {
    unread.value += 1
    load().catch(() => {})
    if (unreadLoaded.value) loadUnread().catch(() => {})
  }

  /**
   * Read state changed in another tab or on another device (pushed with the new unread total): take the count,
   * and reload whatever this tab is showing so read notifications disappear from the unread list.
   */
  function changed(total?: number) {
    if (typeof total === 'number') unread.value = total
    if (loaded.value) load().catch(() => {})
    if (unreadLoaded.value) loadUnread().catch(() => {})
  }

  return { items, latestUnread, unread, loaded, unreadLoaded, load, loadUnread, ensureLoaded, reset, markRead, markAllRead, received, changed }
})
