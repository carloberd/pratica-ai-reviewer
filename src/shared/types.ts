/**
 * Contratti condivisi fra main, preload e renderer.
 *
 * La base è `types/document-review.ts` del modulo PraticaAI Document Review v5.2:
 * i nomi originali (`ReviewDocument`, `ExtractedField`, `EvidenceItem`, `TimelineItem`,
 * `ReviewDecision`, bande HIGH/MEDIUM/LOW) sono mantenuti così come sono, per poter
 * riusare la shell senza riscriverla. Le aggiunte necessarie a questa app desktop
 * (drive, annotazioni, correzioni con before/after) sono marcate con `// v1 reviewer`.
 */

export type ReviewDecision = 'APPROVE' | 'CORRECT' | 'REJECT'
export type ConfidenceBand = 'HIGH' | 'MEDIUM' | 'LOW'
export type QueueStatus = 'NEEDS_REVIEW' | 'APPROVED' | 'REJECTED'

/** v1 reviewer: da dove viene il testo su cui si è fatta la precompilazione. */
export type TextSource = 'NATIVE_TEXT' | 'OCR' | 'DOCX'

/** v1 reviewer: tipo semantico del campo, dal closed set dei 40 campi del registry. */
export type SemanticType = 'date' | 'money' | 'string'

export interface DashboardKpi {
  id: string
  label: string
  value: number
  hint: string
}

export interface BoundingBox {
  x: number
  y: number
  w: number
  h: number
}

export interface EvidenceItem {
  id: string
  label: string
  page: number
  /** Verbatim dal documento: mai normalizzato, mai riscritto. */
  text: string
  confidence: number
  /** v1 reviewer: coordinate pagina pdf.js, assenti quando il text layer non le espone. */
  bbox?: BoundingBox
}

export interface ExtractedField {
  id: string
  /** Nome del campo nel registry PraticaAI, es. `issue_date`. */
  name: string
  /** Etichetta italiana mostrata in UI. */
  label: string
  /** Valore precompilato (normalizzato per date e importi). */
  value: string
  /** v1 reviewer: correzione umana. Valorizzato solo sui campi realmente modificati. */
  correctedValue?: string
  confidence: number
  evidenceId?: string
  /** v1 reviewer: il campo è fra i `required` dello schema del tipo. */
  required: boolean
  semanticType: SemanticType
  updatedAt?: string
}

export interface TimelineItem {
  id: string
  at: string
  title: string
  detail: string
}

export interface Annotation {
  id: string
  documentId: string
  page: number
  bbox: BoundingBox
  kind: 'highlight' | 'note'
  note?: string
  createdAt: string
  updatedAt: string
}

export interface ReviewDocument {
  id: string
  /** v1 reviewer: id del file su Google Drive (sostituisce `understandingId` del v5.2). */
  driveFileId: string
  filename: string
  mime: string
  /** Chiave registry `famiglia.tipo`, oppure slug manuale. `null` = da assegnare a mano. */
  documentType: string | null
  /** Nome leggibile del tipo (canonical_name del registry) quando disponibile. */
  documentTypeLabel: string | null
  typeConfidence: number | null
  status: QueueStatus
  confidence: number
  confidenceBand: ConfidenceBand
  receivedAt: string | null
  syncedAt: string
  source: string
  textSource: TextSource | null
  cachedPath: string | null
  warnings: string[]
  fields: ExtractedField[]
  evidence: EvidenceItem[]
  timeline: TimelineItem[]
}

/** Riga leggera per la tabella documenti: niente campi/evidenze/timeline. */
export interface ReviewDocumentSummary {
  id: string
  driveFileId: string
  filename: string
  mime: string
  documentType: string | null
  documentTypeLabel: string | null
  status: QueueStatus
  confidence: number
  confidenceBand: ConfidenceBand
  receivedAt: string | null
  textSource: TextSource | null
  warnings: string[]
}

/**
 * Payload della review. Compatibile con `ReviewPayload` del modulo v5.2
 * (`POST /v1/document-understandings/{id}/reviews`): `corrections` resta una mappa
 * campo -> valore finale. `changes` è l'estensione v1 reviewer con before/after
 * e provenienza, ignorabile da un backend che conosce solo il contratto v5.2.
 */
export interface ReviewPayload {
  decision: ReviewDecision
  corrections?: Record<string, string>
  note?: string
  changes?: FieldChange[]
}

export interface FieldChange {
  fieldId: string
  name: string
  label: string
  before: string
  after: string
  /** Provenienza del valore di partenza. */
  provenance: {
    textSource: TextSource | null
    evidenceId?: string
    confidence: number
  }
}

export interface DocumentFilters {
  status?: QueueStatus
  documentType?: string
  band?: ConfidenceBand
  /** Query full-text (FTS5) su filename e testo pagina. */
  query?: string
}

export interface AuthStatus {
  configured: boolean
  signedIn: boolean
  email: string | null
  /** Messaggio di setup quando `configured` è false. */
  setupHint?: string
}

export interface SyncResult {
  scanned: number
  added: number
  updated: number
  skipped: number
  processed: number
  errors: Array<{ driveFileId: string; filename: string; message: string }>
}

export interface DashboardStats {
  kpis: DashboardKpi[]
}

/** File trovato su Drive, prima che diventi un documento locale. */
export interface DriveFileSummary {
  id: string
  name: string
  mimeType: string
  modifiedTime: string | null
  size: number | null
  /** Esiste già una riga `documents` per questo file. */
  known: boolean
}

export interface SearchHit {
  documentId: string
  filename: string
  page: number
  snippet: string
}

export interface SyncProgress {
  phase: 'listing' | 'downloading' | 'extracting' | 'done'
  current: number
  total: number
  filename?: string
}

export interface RegistryTypeOption {
  id: string
  label: string
  family: string
}

/** Errore tipato che attraversa il ponte IPC. Mai un `Error` grezzo, mai uno stack. */
export interface IpcError {
  code: IpcErrorCode
  message: string
}

export type IpcErrorCode =
  | 'AUTH_NOT_CONFIGURED'
  | 'AUTH_REQUIRED'
  | 'AUTH_FAILED'
  | 'AUTH_CANCELLED'
  | 'DRIVE_ERROR'
  | 'DB_ERROR'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'EXTRACTION_FAILED'
  | 'UNSUPPORTED'
  | 'INTERNAL'

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError }
