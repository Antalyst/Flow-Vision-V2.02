import type { Office, OrgRoute } from '~/types'

export interface RouteStepInput {
  office_id: string
  action_label: string
}

export interface RouteInput {
  name: string
  description?: string
  steps: RouteStepInput[]
}

export function useRoutes() {
  const api = useApi()
  return {
    /** Active Document Routes — the ones a new document can follow. */
    list: () => api.get<{ data: OrgRoute[] }>('/routes'),
    create: (body: RouteInput) => api.post<{ route: OrgRoute }>('/routes', body),
    update: (id: string, body: Partial<RouteInput>) => api.patch<{ route: OrgRoute; moved_documents: number }>(`/routes/${id}`, body),
    remove: (id: string) => api.del<{ ok: true; retired: boolean }>(`/routes/${id}`),
    offices: (all = false) => api.get<{ data: Office[] }>('/offices', all ? { active: 'all' } : undefined),
    createOffice: (body: Partial<Office>) => api.post<{ office: Office }>('/offices', body),
    updateOffice: (id: string, body: Partial<Office>) => api.patch<{ office: Office }>(`/offices/${id}`, body),
  }
}
