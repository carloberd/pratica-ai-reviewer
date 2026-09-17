import { contextBridge, ipcRenderer } from 'electron'
import type { ProfileEdit } from '../shared/profile-edit'
import type {
  ActivityFeed,
  ProfileBundleResult,
  ProfileEditOutcome,
  ProfileReportResult,
  ProfileWorkspace,
  TypeRerunResult
} from '../shared/profile-workspace'
import type {
  AuthStatus,
  CacheUsage,
  DashboardStats,
  DatasetExportResult,
  DocumentFilters,
  DriveFileSummary,
  FetchProgress,
  FetchResult,
  RegistryTypeOption,
  ReviewDocument,
  ReviewDocumentSummary,
  ReviewSubmission,
  SearchHit,
  XlsxExportResult
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
  /**
   * Serve alla UI per lasciare spazio ai semafori di macOS, che su quella
   * piattaforma stanno sopra al contenuto.
   */
  platform: process.platform,
  auth: {
    login: () => invoke<IpcResultOf<AuthStatus>>('auth:login'),
    status: () => invoke<IpcResultOf<AuthStatus>>('auth:status'),
    logout: () => invoke<IpcResultOf<AuthStatus>>('auth:logout')
  },
  drive: {
    /** Solo metadati: nessun file viene scaricato. */
    list: () => invoke<IpcResultOf<DriveFileSummary[]>>('drive:list'),
    /** Scarica ed elabora un singolo file, su richiesta. */
    fetch: (driveFileId: string, options?: { force?: boolean }) =>
      invoke<IpcResultOf<FetchResult>>('drive:fetch', {
        driveFileId,
        force: options?.force ?? false
      }),
    cacheUsage: () => invoke<IpcResultOf<CacheUsage>>('drive:cache-usage')
  },
  docs: {
    list: (filters?: DocumentFilters) =>
      invoke<IpcResultOf<ReviewDocumentSummary[]>>('docs:list', filters ?? {}),
    get: (id: string) => invoke<IpcResultOf<ReviewDocument>>('docs:get', { id }),
    stats: () => invoke<IpcResultOf<DashboardStats>>('docs:stats'),
    setType: (id: string, documentType: string | null) =>
      invoke<IpcResultOf<ReviewDocument>>('docs:set-type', { id, documentType }),
    /** Toglie dalla cache la copia locale, lasciando intatti dati estratti ed evidenze. */
    evict: (id: string) => invoke<IpcResultOf<{ freedBytes: number }>>('docs:evict', { id }),
    types: () => invoke<IpcResultOf<RegistryTypeOption[]>>('docs:types')
  },
  fields: {
    update: (input: { documentId: string; fieldId: string; correctedValue: string | null }) =>
      invoke<IpcResultOf<ReviewDocument>>('fields:update', input),
    /** Riga aggiunta a mano a un campo ripetuto. */
    addItem: (input: { documentId: string; fieldId: string; value: string }) =>
      invoke<IpcResultOf<ReviewDocument>>('fields:item-add', input),
    updateItem: (input: { documentId: string; itemId: string; correctedValue: string | null }) =>
      invoke<IpcResultOf<ReviewDocument>>('fields:item-update', input),
    removeItem: (input: { documentId: string; itemId: string; removed: boolean }) =>
      invoke<IpcResultOf<ReviewDocument>>('fields:item-remove', input)
  },
  dataset: {
    /** Chiede dove salvare e scrive il dataset annotato. */
    export: () => invoke<IpcResultOf<DatasetExportResult>>('dataset:export'),
    /** Lo stesso dataset in foglio di calcolo: due tabelle, `documents` e `fields`. */
    exportXlsx: () => invoke<IpcResultOf<XlsxExportResult>>('dataset:export-xlsx')
  },
  /** Misure e correzione della mappa «tipo documento ↔ dati da estrarre». */
  profiles: {
    list: () => invoke<IpcResultOf<ProfileWorkspace>>('profiles:list'),
    /** Scrive la decisione sul database: nessun file del registry viene toccato. */
    edit: (edit: ProfileEdit) =>
      invoke<IpcResultOf<{ outcome: ProfileEditOutcome; workspace: ProfileWorkspace }>>(
        'profiles:edit',
        { edit }
      ),
    /** Annulla un'azione della cronologia e rimette lo stato che c'era prima. */
    revert: (actionId: string) =>
      invoke<IpcResultOf<{ outcome: ProfileEditOutcome; workspace: ProfileWorkspace }>>(
        'profiles:revert',
        { actionId }
      ),
    /** Rielabora dalla cache i documenti annotati di un tipo e confronta i numeri. */
    rerun: (documentType: string) =>
      invoke<IpcResultOf<{ rerun: TypeRerunResult; workspace: ProfileWorkspace }>>(
        'profiles:rerun',
        { documentType }
      ),
    export: (format: 'json' | 'csv') =>
      invoke<IpcResultOf<ProfileReportResult>>('profiles:export', { format }),
    /** I file della mappa corretta, da portare in pratica-ai. */
    exportMap: () => invoke<IpcResultOf<ProfileBundleResult>>('profiles:export-map')
  },
  /** Cronologia unica: correzioni alla mappa ed eventi dei documenti. */
  history: {
    list: () => invoke<IpcResultOf<ActivityFeed>>('history:list')
  },
  review: {
    submit: (input: { documentId: string; payload: ReviewSubmission }) =>
      invoke<IpcResultOf<ReviewDocument>>('review:submit', input)
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
  ocr: {
    /** Testo di un ritaglio di pagina (PNG) evidenziato durante la revisione. */
    region: (image: Uint8Array) => invoke<IpcResultOf<{ text: string }>>('ocr:region', { image })
  },
  onFetchProgress: (listener: (progress: FetchProgress) => void): (() => void) => {
    const handler = (_event: unknown, progress: FetchProgress) => listener(progress)
    ipcRenderer.on('drive:fetch-progress', handler)
    return () => {
      ipcRenderer.off('drive:fetch-progress', handler)
    }
  }
}

type IpcResultOf<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

contextBridge.exposeInMainWorld('reviewer', reviewerApi)
