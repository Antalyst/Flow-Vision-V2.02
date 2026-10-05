import { FetchError } from 'ofetch'

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

/** Pull a human-readable message out of an API error (h3 shape: { statusCode, message, data }). */
export function apiErrorMessage(err: unknown, fallback = 'Something went wrong') {
  if (err instanceof FetchError) {
    if (!err.response) return 'Cannot reach the FlowVision server.'
    return (err.data as { message?: string } | undefined)?.message ?? fallback
  }
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') return err.message
  return fallback
}

/**
 * API client for the same-origin Nitro routes. Auth is the httpOnly session cookie:
 * the browser sends it automatically, and during SSR `useRequestFetch` forwards the
 * incoming request's cookie so server-rendered pages see the signed-in user.
 */
export function useApi() {
  const fetcher = useRequestFetch()

  async function request<T>(method: Method, path: string, opts: { query?: Record<string, unknown>; body?: unknown } = {}): Promise<T> {
    try {
      return (await fetcher(`/api${path}`, {
        method,
        query: opts.query,
        body: opts.body as Record<string, unknown> | FormData | undefined,
      })) as T
    } catch (err) {
      // Session expired or revoked mid-visit: drop local state and go to sign-in.
      if (import.meta.client && err instanceof FetchError && err.response?.status === 401 && !path.startsWith('/auth/')) {
        const auth = useAuthStore()
        if (auth.user) {
          auth.clear()
          await navigateTo({ path: '/login', query: { redirect: useRoute().fullPath } })
        }
      }
      throw err
    }
  }

  return {
    get: <T>(path: string, query?: Record<string, unknown>) => request<T>('GET', path, { query }),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body }),
    patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
    del: <T>(path: string) => request<T>('DELETE', path),
  }
}
