import { DocumentFile, type Row } from './models.ts'

export interface DocumentFileDto {
  /** `main` for documents created before document_files (their one file is documents.file_url). */
  id: string
  name: string
  type: string | null
  size: number
  /** Opens the file (the session cookie authorizes it). */
  url: string
}

/** A document's files in order — one, or several for a bulk upload under the same QR code. */
export async function documentFileList(doc: Row): Promise<DocumentFileDto[]> {
  const rows = await DocumentFile.findAll({ where: { document_id: doc.id }, order: [['sort_order', 'ASC']] })
  if (rows.length) {
    return rows.map((r) => ({
      id: r.id as string,
      name: r.file_name as string,
      type: (r.file_type as string | null) ?? null,
      size: Number(r.file_size ?? 0),
      url: `/api/documents/${doc.id}/files/${r.id}`,
    }))
  }
  if (!doc.file_url) return []
  return [
    {
      id: 'main',
      name: String(doc.file_url).split('/').pop()!,
      type: doc.file_type ?? null,
      size: Number(doc.file_size ?? 0),
      url: `/api/documents/${doc.id}/file`,
    },
  ]
}

/** The stored path (file_url) of one of the document's files; `main` / missing = documents.file_url. */
export async function documentFileUrl(doc: Row, fileId: string | null | undefined): Promise<string | null> {
  if (!fileId || fileId === 'main') return doc.file_url ?? null
  const row = await DocumentFile.findOne({ where: { id: fileId, document_id: doc.id }, attributes: ['file_url'] })
  return (row?.file_url as string | undefined) ?? null
}
