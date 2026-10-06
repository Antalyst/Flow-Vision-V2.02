import type { Approval, DocumentFileInfo, DocumentPermissions, FlowDocument, OrgRoute, QrInfo, RoutingVisit, TrackingEvent } from '~/types'

export interface DocumentDetail {
  document: FlowDocument
  route: OrgRoute | null
  tracking: TrackingEvent[]
  routing: RoutingVisit[]
  approvals: Approval[]
  pending_approval: Approval | null
  active_qr: QrInfo | null
  files: DocumentFileInfo[]
  permissions: DocumentPermissions
}

/**
 * The live server (Vercel) takes at most 4.5 MB per request, so a file bigger than this goes ahead
 * in parts of this size (see `stage`); the form then refers to it by key.
 */
export const UPLOAD_PART_BYTES = 3 * 1024 * 1024

export type DocumentScope = 'all' | 'mine' | 'team' | 'visited' | 'office' | 'incoming' | 'carrying' | 'pickups'

export function useDocuments() {
  const api = useApi()

  return {
    list: (params: { scope?: DocumentScope; status?: string; q?: string; priority?: string; page?: number; limit?: number } = {}) =>
      api.get<{ data: FlowDocument[]; meta: { total: number; page: number; limit: number } }>('/documents', params),
    get: (id: string) => api.get<DocumentDetail>(`/documents/${id}`),
    /** AI reads the file and suggests a title, description and type (nothing is saved). */
    analyze: (form: FormData) =>
      api.post<{ suggestion: { title: string; description: string; document_type: string } }>('/documents/analyze', form),
    create: (form: FormData) => api.post<{ document: FlowDocument }>('/documents', form),
    /**
     * Send a large file ahead in parts of UPLOAD_PART_BYTES. Resolves to its key: append it to the
     * create / analyze form as `upload` instead of the file. `onProgress` gets the bytes sent so far.
     */
    async stage(file: File, onProgress?: (sent: number) => void) {
      let key = ''
      for (let index = 0; index * UPLOAD_PART_BYTES < file.size; index++) {
        const chunk = file.slice(index * UPLOAD_PART_BYTES, (index + 1) * UPLOAD_PART_BYTES)
        const fd = new FormData()
        fd.append('file', new File([chunk], file.name, { type: file.type }))
        if (index === 0) {
          fd.append('size', String(file.size))
          key = (await api.post<{ key: string }>('/uploads', fd)).key
        } else {
          fd.append('key', key)
          fd.append('index', String(index))
          await api.post('/uploads/part', fd)
        }
        onProgress?.(Math.min(file.size, (index + 1) * UPLOAD_PART_BYTES))
      }
      return key
    },
    update: (id: string, form: FormData) => api.patch<{ document: FlowDocument }>(`/documents/${id}`, form),
    remove: (id: string) => api.del(`/documents/${id}`),
    /** `routeId` switches the document to another Document Route as it is (re)submitted. */
    submit: (id: string, routeId?: string | null) => api.post<{ document: FlowDocument }>(`/documents/${id}/submit`, routeId ? { route_id: routeId } : undefined),
    /** Assign (or, before pickup, reassign) the free messenger who carries it to the next office. */
    requestPickup: (id: string, body: { liaison_user_id: string; remarks?: string }) =>
      api.post<{ document: FlowDocument; reassigned: boolean }>(`/documents/${id}/pickup-request`, body),
    cancelPickup: (id: string) => api.del<{ document: FlowDocument }>(`/documents/${id}/pickup-request`),
    startTransit: (id: string) => api.post<{ document: FlowDocument }>(`/documents/${id}/transit`),
    failDelivery: (id: string, remarks: string) => api.post<{ document: FlowDocument }>(`/documents/${id}/fail-delivery`, { remarks }),
    addNote: (id: string, remarks: string) => api.post(`/documents/${id}/notes`, { remarks }),

    /** The session cookie authorizes the download, so a plain link works. */
    fileUrl: (doc: Pick<FlowDocument, 'id'>) => `/api/documents/${doc.id}/file`,
    openFile(doc: Pick<FlowDocument, 'id'>) {
      window.open(`/api/documents/${doc.id}/file`, '_blank', 'noopener')
    },
  }
}

/** Refetch whenever the server reports a document change (or `extra` sources change). */
export function useLiveRefresh(fn: () => unknown) {
  const documents = useDocumentsStore()
  let timer: ReturnType<typeof setTimeout> | undefined
  watch(
    () => documents.version,
    () => {
      // Debounce bursts (one action can emit several updates).
      clearTimeout(timer)
      timer = setTimeout(() => fn(), 300)
    },
  )
  onBeforeUnmount(() => clearTimeout(timer))
}
