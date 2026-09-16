/**
 * Contratti condivisi fra main, preload e renderer.
 *
 * La base è `types/document-review.ts` del modulo PraticaAI Document Review v5.2:
 * i nomi originali (`ReviewDocument`, `ExtractedField`, `EvidenceItem`, `TimelineItem`,
 * `ReviewDecision`, bande HIGH/MEDIUM/LOW) sono mantenuti così come sono, per poter
 * riusare la shell senza riscriverla. Le aggiunte necessarie a questa app desktop
 * (drive, correzioni con before/after) sono marcate con `// v1 reviewer`.
 */

import type { Cardinality, FieldReviewStatus, FieldRole } from './extraction-v2'

/**
 * v1 reviewer: quello che il revisore sceglie davvero. `SAVE` chiude il documento come
 * revisionato — tipo e campi sono a database, il documento entra nel dataset; `DISCARD`
 * lo toglie di mezzo. La distinzione fra approvare e correggere non è una scelta umana:
 * è la conseguenza dei campi toccati, e la calcola `buildReviewPayload`.
 */
export type ReviewAction = 'SAVE' | 'DISCARD'

/** Decisione nella forma del contratto v5.2. Derivata da `ReviewAction`, mai chiesta all'utente. */
export type ReviewDecision = 'APPROVE' | 'CORRECT' | 'REJECT'
export type ConfidenceBand = 'HIGH' | 'MEDIUM' | 'LOW'

/**
 * v1 reviewer: `REVIEWED` = annotato e buono per il dataset, `DISCARDED` = da tenere
 * fuori dai test futuri. Sostituiscono `APPROVED`/`REJECTED` del v5.2, che parlavano
 * di approvazione di una pratica invece che di idoneità di un dato.
 */
export type QueueStatus = 'NEEDS_REVIEW' | 'REVIEWED' | 'DISCARDED'

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
  /** v2 reviewer: `many` per i campi ripetuti (righe fattura, rate), che vivono in `items`. */
  cardinality: Cardinality
  /** v2 reviewer: ruolo nel profilo del tipo; `null` sulle righe scritte dal motore v1. */
  role: FieldRole | null
  reviewStatus: FieldReviewStatus | null
  /** v2 reviewer: una voce per riga, solo per `cardinality = 'many'`. */
  items: FieldItem[]
}

/** v2 reviewer: da dove viene una riga di un campo ripetuto. */
export type FieldItemOrigin = 'ENGINE' | 'MANUAL'

/** v2 reviewer: una riga di un campo ripetuto. */
export interface FieldItem {
  id: string
  /** Posizione stabile della riga: le proposte del motore prima, le aggiunte a mano dopo. */
  index: number
  /** Valore proposto dal motore; stringa vuota per una riga aggiunta a mano. */
  value: string
  /** Correzione umana, o il valore di una riga aggiunta a mano. */
  correctedValue?: string
  confidence: number
  evidenceId?: string
  origin: FieldItemOrigin
  /** Riga proposta che il revisore ha tolto: resta visibile per poterla ripristinare. */
  removed: boolean
  updatedAt?: string
}

export interface TimelineItem {
  id: string
  at: string
  title: string
  detail: string
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
  /** v2 reviewer: esito del classificatore sull'ultima elaborazione, coi candidati. */
  classification: TypeClassification | null
  /** v2 reviewer: quando il revisore ha salvato o scartato il documento. */
  reviewedAt: string | null
}

/** v2 reviewer: motivo per cui il classificatore ha assegnato o no il tipo. */
export type TypeMatchReason =
  | 'OK'
  | 'BELOW_THRESHOLD'
  | 'LOW_MARGIN'
  | 'FILENAME_ONLY'
  | 'HARD_NEGATIVE'
  | 'NO_SIGNAL'

export type TypeSignalSource =
  | 'title-zone'
  | 'page'
  | 'filename'
  | 'positive-signal'
  | 'negative-signal'
  | 'hard-negative-signal'

/** Riga del documento da cui viene un indizio: si raggiunge come un'evidenza. */
export interface DocumentLocation {
  page: number
  /** Verbatim dal documento. */
  text: string
  bbox?: BoundingBox
}

/** Un indizio che ha spostato il punteggio di un candidato. */
export interface TypeSignal {
  source: TypeSignalSource
  /** Frase del registry (normalizzata) che ha fatto scattare l'indizio. */
  phrase: string
  delta: number
  /** Riga del documento che la contiene; assente per il nome del file o se non ritrovata. */
  location?: DocumentLocation
}

export interface TypeCandidate {
  documentType: string
  /** Nome leggibile dal registry, aggiunto in lettura. */
  label: string | null
  score: number
  signals: TypeSignal[]
}

/**
 * v2 reviewer: quello che il classificatore ha proposto, indipendentemente da quello che
 * il revisore ha poi scelto. `proposedType` è `null` quando il motore non ha assegnato.
 */
export interface TypeClassification {
  engine: 'v1' | 'v2'
  /** Versione dei segnali del classificatore v2; `null` col v1. */
  version: string | null
  decision: 'ASSIGN' | 'UNKNOWN'
  reason: TypeMatchReason
  proposedType: string | null
  confidence: number
  /** Distacco fra primo e secondo candidato; `null` col v1, che non lo calcola. */
  margin: number | null
  threshold: number | null
  minimumMargin: number | null
  candidates: TypeCandidate[]
}

/** Come la salva il main: le etichette dei tipi si aggiungono in lettura dal registry. */
export type StoredTypeClassification = Omit<TypeClassification, 'candidates'> & {
  candidates: Array<Omit<TypeCandidate, 'label'>>
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

/** Quello che il renderer manda al main: l'azione, non la decisione. */
export interface ReviewSubmission {
  action: ReviewAction
  note?: string
}

export interface FieldChange {
  fieldId: string
  name: string
  label: string
  /** v2 reviewer: indice della riga, solo per i campi ripetuti. */
  itemIndex?: number
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

/** Esito dell'apertura di un file di Drive. */
export interface FetchResult {
  documentId: string
  downloaded: boolean
  processed: boolean
}

export interface CacheUsage {
  files: number
  bytes: number
}

export interface DashboardStats {
  kpis: DashboardKpi[]
}

/**
 * File visto su Drive. È solo metadato: il contenuto non viene scaricato finché
 * qualcuno non apre il documento.
 */
export interface DriveFileSummary {
  id: string
  name: string
  mimeType: string
  modifiedTime: string | null
  size: number | null
  /** Id del documento locale, se questo file è già stato aperto almeno una volta. */
  documentId: string | null
  /** La copia locale c'è ed è allineata a quella su Drive. */
  cached: boolean
  /** Su Drive c'è una versione più recente di quella elaborata in locale. */
  stale: boolean
  status: QueueStatus | null
}

export interface SearchHit {
  documentId: string
  filename: string
  page: number
  snippet: string
}

export interface FetchProgress {
  phase: 'downloading' | 'extracting' | 'done'
  filename: string
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

/** v2 reviewer: esito dell'export del dataset annotato. */
export interface DatasetExportResult {
  /** `false` se il revisore ha annullato la scelta del file. */
  saved: boolean
  path: string | null
  documents: number
  corrections: number
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError }
