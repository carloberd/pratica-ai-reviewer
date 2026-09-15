import { contextBridge, ipcRenderer } from 'electron'
import type {
  Annotation,
  AuthStatus,
  BoundingBox,
  DashboardStats,
  DocumentFilters,
  DriveFileSummary,
  RegistryTypeOption,
  ReviewDocument,
  ReviewDocumentSummary,
  ReviewPayload,
  SearchHit,
  SyncProgress,
  SyncResult
} from '../shared/types'

/**
 * Unico ponte fra renderer e main. Il renderer non ha Node, non ha rete verso Google
 * e non vede mai un token: può solo invocare questi canali.
 *
 * Ogni canale risponde con `IpcResult<T>` (`{ ok: true, data }` oppure
 * `{ ok: false, error: { code, message } }`): oggetti clonabili, nessuna eccezione
 * che attraversa il ponte e nessuno stack trace nel renderer.
 */
const invoke = <T>(channel: string, payload?: unknown): Promise<T> =>
  ipcRenderer.invoke(channel, payload) as Promise<T>

export const reviewerApi = {
  auth: {
    login: () => invoke<IpcResultOf<AuthStatus>>('auth:login'),
    status: () => invoke<IpcResultOf<AuthStatus>>('auth:status'),
    logout: () => invoke<IpcResultOf<AuthStatus>>('auth:logout')
  },
  drive: {
    list: () => invoke<IpcResultOf<DriveFileSummary[]>>('drive:list'),
    sync: () => invoke<IpcResultOf<SyncResult>>('drive:sync')
  },
  docs: {
    list: (filters?: DocumentFilters) =>
      invoke<IpcResultOf<ReviewDocumentSummary[]>>('docs:list', filters ?? {}),
    get: (id: string) => invoke<IpcResultOf<ReviewDocument>>('docs:get', { id }),
    stats: () => invoke<IpcResultOf<DashboardStats>>('docs:stats'),
    setType: (id: string, documentType: string | null) =>
      invoke<IpcResultOf<ReviewDocument>>('docs:set-type', { id, documentType }),
    types: () => invoke<IpcResultOf<RegistryTypeOption[]>>('docs:types')
  },
  fields: {
    update: (input: { documentId: string; fieldId: string; correctedValue: string | null }) =>
      invoke<IpcResultOf<ReviewDocument>>('fields:update', input)
  },
  review: {
    submit: (input: { documentId: string; payload: ReviewPayload }) =>
      invoke<IpcResultOf<ReviewDocument>>('review:submit', input)
  },
  annotations: {
    list: (documentId: string) =>
      invoke<IpcResultOf<Annotation[]>>('annotations:list', { documentId }),
    add: (input: {
      documentId: string
      page: number
      bbox: BoundingBox
      kind: 'highlight' | 'note'
      note?: string
    }) => invoke<IpcResultOf<Annotation>>('annotations:add', input),
    update: (input: { id: string; bbox?: BoundingBox; note?: string | null }) =>
      invoke<IpcResultOf<Annotation>>('annotations:update', input),
    delete: (id: string) => invoke<IpcResultOf<{ id: string }>>('annotations:delete', { id })
  },
  search: {
    query: (text: string) => invoke<IpcResultOf<SearchHit[]>>('search:query', { text })
  },
  pdf: {
    /** Legge dalla cache locale il PDF di un documento. Nessun contenuto remoto. */
    read: (documentId: string) => invoke<IpcResultOf<ArrayBuffer>>('pdf:read', { documentId })
  },
  docx: {
    text: (documentId: string) => invoke<IpcResultOf<string>>('docx:text', { documentId })
  },
  onSyncProgress: (listener: (progress: SyncProgress) => void): (() => void) => {
    const handler = (_event: unknown, progress: SyncProgress) => listener(progress)
    ipcRenderer.on('drive:sync-progress', handler)
    return () => {
      ipcRenderer.off('drive:sync-progress', handler)
    }
  }
}

type IpcResultOf<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

contextBridge.exposeInMainWorld('reviewer', reviewerApi)
