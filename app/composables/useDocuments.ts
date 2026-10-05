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
