import { contextBridge, ipcRenderer } from 'electron'
import type {
  LearningExportResult,
  LearningOverview,
  ManualRuleStatus
} from '../shared/learning-workspace'
import type { LearningMode } from '../shared/local-learning'
import type { ProfileEdit } from '../shared/profile-edit'
import type { ProfileAction } from '../shared/profile-history'
import type {
  ActivityFeed,
  MapEditResult,
  ProfileBundleResult,
  TypeFieldMap
} from '../shared/profile-workspace'
import type {
  AuthStatus,
  CacheUsage,
  DashboardStats,
  DatasetExportResult,
  DocumentFilters,
  DocumentPick,
  DriveListing,
  DriveLocation,
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
    /** Il contenuto di una cartella. Solo metadati: nessun file viene scaricato. */
    list: (location: DriveLocation) => invoke<IpcResultOf<DriveListing>>('drive:list', location),
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
  /** `pick` è il punto del documento da cui viene il valore; assente se scritto a mano. */
  fields: {
    update: (input: {
      documentId: string
      fieldId: string
      correctedValue: string | null
      pick?: DocumentPick
    }) => invoke<IpcResultOf<ReviewDocument>>('fields:update', input),
    /** Riga aggiunta a mano a un campo ripetuto. */
    addItem: (input: { documentId: string; fieldId: string; value: string; pick?: DocumentPick }) =>
      invoke<IpcResultOf<ReviewDocument>>('fields:item-add', input),
    updateItem: (input: {
      documentId: string
      itemId: string
      correctedValue: string | null
      pick?: DocumentPick
    }) => invoke<IpcResultOf<ReviewDocument>>('fields:item-update', input),
    removeItem: (input: { documentId: string; itemId: string; removed: boolean }) =>
      invoke<IpcResultOf<ReviewDocument>>('fields:item-remove', input)
  },
  dataset: {
    /** Chiede dove salvare e scrive il dataset annotato. */
    export: () => invoke<IpcResultOf<DatasetExportResult>>('dataset:export'),
    /** Lo stesso dataset in foglio di calcolo: due tabelle, `documents` e `fields`. */
    exportXlsx: () => invoke<IpcResultOf<XlsxExportResult>>('dataset:export-xlsx')
  },
  /** La mappa «tipo documento ↔ dati da estrarre», corretta dal documento aperto. */
  map: {
    get: (documentId: string) => invoke<IpcResultOf<TypeFieldMap>>('map:get', { documentId }),
    /** Scrive la decisione sul database e rielabora il documento con la mappa nuova. */
    edit: (documentId: string, edit: ProfileEdit) =>
      invoke<IpcResultOf<MapEditResult>>('map:edit', { documentId, edit }),
    /** Annulla una correzione e rielabora il documento con la mappa di prima. */
    revert: (documentId: string, actionId: string) =>
      invoke<IpcResultOf<MapEditResult>>('map:revert', { documentId, actionId })
  },
  profiles: {
    /** Annulla un'azione della cronologia e rimette lo stato che c'era prima. */
    revert: (actionId: string) =>
      invoke<IpcResultOf<ProfileAction>>('profiles:revert', { actionId }),
    /** I file della mappa corretta, da portare in pratica-ai. */
    exportMap: () => invoke<IpcResultOf<ProfileBundleResult>>('profiles:export-map')
  },
  /** Cronologia unica: correzioni alla mappa ed eventi dei documenti. */
  /** La scheda «Apprendimento»: modalità, regole e il loro export. */
  learning: {
    overview: () => invoke<IpcResultOf<LearningOverview>>('learning:overview'),
    setMode: (mode: LearningMode) =>
      invoke<IpcResultOf<LearningOverview>>('learning:set-mode', { mode }),
    setRuleStatus: (ruleId: string, status: ManualRuleStatus) =>
      invoke<IpcResultOf<LearningOverview>>('learning:set-rule-status', { ruleId, status }),
    replay: () => invoke<IpcResultOf<LearningOverview>>('learning:replay'),
    rollbackRule: (ruleId: string) =>
      invoke<IpcResultOf<LearningOverview>>('learning:rollback-rule', { ruleId }),
    export: () => invoke<IpcResultOf<LearningExportResult>>('learning:export')
  },
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
