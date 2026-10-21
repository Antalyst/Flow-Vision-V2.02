/**
 * The current time for relative timestamps, shared by every component and ticking every 30 seconds.
 * It is null on the server and during hydration, so server and client render the same text first.
 */
export function useNow() {
  const now = useState<number | null>('fv-now', () => null)
  onMounted(() => {
    now.value = Date.now()
    const timer = setInterval(() => (now.value = Date.now()), 30_000)
    onBeforeUnmount(() => clearInterval(timer))
  })
  return now
}
