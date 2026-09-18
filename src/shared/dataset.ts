import type { FieldRole } from './extraction-v2'
import {
  type CorrectionKind,
  confirmedItems,
  currentFieldValue,
  currentItemValue,
  documentCorrections
} from './field-edits'
import { praticaaiTypeIdOrNull } from './registry-alignment'
import type {
  BoundingBox,
  EvidenceItem,
  ExtractedField,
  FieldItem,
  PickLocation,
  PickMethod,
  ReviewDocument,
  TextSource,
  TypeMatchReason
} from './types'

/**
 * Il dataset annotato: quello che il revisore ha confermato, documento per documento, con
 * quello che il motore aveva proposto accanto. È l'input del benchmark di pratica-ai; il
 * formato è descritto nel README («Export del dataset annotato») e ogni modifica
 * incompatibile deve cambiare `DATASET_FORMAT_VERSION`.
 *
 * Qui non c'è né database né filesystem: si parte da `ReviewDocument`, il contratto che
 * la revisione già usa.
 */

export const DATASET_FORMAT = 'praticaai-reviewer/annotated-dataset'
export const DATASET_FORMAT_VERSION = '1.5.0'

export type EngineVersion = 'v1' | 'v2'

export interface DatasetManifest {
  format: typeof DATASET_FORMAT
  formatVersion: typeof DATASET_FORMAT_VERSION
  exportedAt: string
  app: { name: string; version: string }
  /** Motori e versioni con cui girava l'app al momento dell'export. */
  engines: {
    classifier: EngineVersion
    extraction: EngineVersion
    classifierVersion: string | null
    extractionEngineVersion: string | null
    schemaVersion: string | null
  }
  counts: { documents: number; reviewed: number; discarded: number; corrections: number }
  /** Con quale apprendimento locale lavorava il motore; `null` se non si sa. */
  learning: DatasetLearningSnapshot | null
}

/**
 * La modalità del learner e le regole attive al momento dell'export. Due export con la
 * stessa impronta sono stati precompilati dalle stesse regole: un benchmark la dichiara.
 */
export interface DatasetLearningSnapshot {
  mode: 'LEARNING' | 'FROZEN' | 'BASELINE'
  learnerVersion: string
  activeRules: number
  /** Sha-256 (16 caratteri) delle chiavi delle regole attive, `null` se non ce ne sono. */
  rulesFingerprint: string | null
}

export interface DatasetEvidence {
  page: number
  /** Verbatim dal documento. */
  text: string
  bbox: BoundingBox | null
}

/**
 * Il punto del documento da cui il revisore ha preso un valore. `location` lo ritrova fra
 * le righe dell'elaborazione (righe unite da `\n`), `null` quando non si ritrova con
 * certezza.
 */
export interface DatasetPick {
  method: PickMethod
  page: number
  /** Verbatim: quello che il revisore ha selezionato, o che l'OCR ha letto nell'area. */
  text: string
  bbox: BoundingBox | null
  location: PickLocation | null
}

/** `ENGINE` = proposto dal motore e confermato; `REVIEWER` = scritto dal revisore. */
export type DatasetValueOrigin = 'ENGINE' | 'REVIEWER'

/**
 * Da chi viene una lista: da tutte e due, se il revisore ha aggiunto righe alle proposte.
 *
 * Un campo ripetuto non ha un'origine sola come un campo singolo, ma non averne nessuna
 * era peggio: `origin` mancava solo sui campi `many`, e chi contava le origini leggendo
 * `field.origin` si trovava `undefined` invece di un errore, e li perdeva in silenzio.
 */
export type DatasetListOrigin = DatasetValueOrigin | 'MIXED'

export interface DatasetScalarField {
  name: string
  label: string
  role: FieldRole | null
  cardinality: 'one'
  value: string | null
  origin: DatasetValueOrigin | null
  /** Riga da cui il motore aveva letto la proposta, anche se il revisore l'ha corretta. */
  evidence: DatasetEvidence | null
  /** Da dove il revisore ha preso il valore; `null` se l'ha scritto a mano o non l'ha toccato. */
  pick: DatasetPick | null
}

export interface DatasetListItem {
  value: string
  origin: DatasetValueOrigin
  evidence: DatasetEvidence | null
  pick: DatasetPick | null
}

export interface DatasetListField {
  name: string
  label: string
  role: FieldRole | null
  cardinality: 'many'
  /** I valori confermati, in ordine. */
  value: string[]
  /**
   * Da chi vengono le righe nel loro insieme: `MIXED` se il revisore ne ha aggiunte alle
   * proposte del motore, `null` se la lista è vuota. La provenienza riga per riga sta in
   * `items`, che è più preciso; questo serve a contare i campi come si contano i singoli.
   */
  origin: DatasetListOrigin | null
  /** Gli stessi valori con provenienza ed evidenza. */
  items: DatasetListItem[]
}

export type DatasetField = DatasetScalarField | DatasetListField

export interface DatasetCorrection {
  field: string
  label: string
  /** Indice della riga nella tabella di revisione, solo per i campi ripetuti. */
  item: number | null
  kind: CorrectionKind
  /** Valore proposto dal motore. */
  before: string | null
  /** Valore messo dal revisore. */
  after: string | null
  /** Da dove il revisore ha preso `after`, se l'ha selezionato sul documento. */
  pick: DatasetPick | null
}

/**
 * Un candidato del classificatore col suo punteggio, in ordine di punteggio.
 *
 * Ci sono anche quando il classificatore non ha assegnato: sono la differenza fra «non ha
 * trovato niente» e «aveva ragione ma sotto soglia», e senza di loro le soglie si tarano
 * a occhio. Le frasi che li sostengono restano fuori: servono a chi revisiona, non a chi
 * misura, e sono verbatim del documento.
 */
export interface DatasetTypeCandidate {
  documentType: string
  /** Lo stesso tipo come lo chiama pratica-ai. */
  registryId: string | null
  score: number
  /** 1 è il primo classificato. */
  rank: number
}

/**
 * Dov'era finito il tipo che il revisore ha poi scelto, fra i candidati del classificatore.
 *
 * È la misura della copertura: `rank: 1` con `decision: 'UNKNOWN'` vuol dire che il
 * classificatore ci aveva preso e si è fermato per una soglia; `rank: null` che il tipo
 * giusto non era proprio in lista, e abbassare le soglie non lo farebbe comparire.
 */
export interface DatasetChosenAmongCandidates {
  rank: number | null
  score: number | null
}

export interface DatasetDocumentType {
  id: string | null
  label: string | null
  /** Gli stessi tipi come li chiama pratica-ai: uguali, meno le tre classi con slug diverso. */
  registry: { id: string | null; proposed: string | null }
  /** Chi ha deciso il tipo che resta: il revisore a mano, o il classificatore. */
  chosenBy: 'REVIEWER' | 'ENGINE' | null
  /** Il tipo proposto dal classificatore, `null` se non ne aveva assegnato uno. */
  proposed: string | null
  proposedConfidence: number | null
  /** Il revisore ha scelto un tipo diverso dalla proposta; `null` se la proposta non è nota. */
  corrected: boolean | null
  /** Che cosa ha deciso il classificatore, e perché; `null` se non l'ha mai visto. */
  decision: 'ASSIGN' | 'UNKNOWN' | null
  reason: TypeMatchReason | null
  /** Distacco fra primo e secondo candidato, e le due soglie con cui va confrontato. */
  margin: number | null
  threshold: number | null
  minimumMargin: number | null
  /** I candidati col punteggio, anche quando il classificatore non ha assegnato. */
  candidates: DatasetTypeCandidate[]
  /** Dov'era il tipo scelto dal revisore, fra quei candidati. */
  chosen: DatasetChosenAmongCandidates | null
}

export interface DatasetDocument {
  /** Chiave stabile: `https://drive.google.com/file/d/<driveFileId>/view`. */
  driveFileId: string
  /** Sha-256 del file elaborato: la chiave dei byte, che non dipende da Drive. */
  contentSha256: string | null
  filename: string
  mime: string
  status: 'REVIEWED' | 'DISCARDED'
  reviewedAt: string | null
  textSource: TextSource | null
  documentType: DatasetDocumentType
  /** L'ultima estrazione che ha prodotto i campi proposti. */
  extraction: {
    engineVersion: string
    schemaVersion: string
    status: string
    completedAt: string | null
  } | null
  /** Vuoto per i documenti scartati: nessuno ne ha confermato i valori. */
  fields: DatasetField[]
  corrections: DatasetCorrection[]
}

export interface AnnotatedDataset {
  manifest: DatasetManifest
  documents: DatasetDocument[]
}

export interface DatasetSource {
  document: ReviewDocument
  extraction: DatasetDocument['extraction']
}

export type DatasetManifestInput = Pick<DatasetManifest, 'exportedAt' | 'app' | 'engines'> &
  Partial<Pick<DatasetManifest, 'learning'>>

function evidenceOf(
  byId: Map<string, EvidenceItem>,
  evidenceId: string | undefined
): DatasetEvidence | null {
  const evidence = evidenceId ? byId.get(evidenceId) : undefined
  if (!evidence) return null
  return { page: evidence.page, text: evidence.text, bbox: evidence.bbox ?? null }
}

function pickOf(
  byId: Map<string, EvidenceItem>,
  evidenceId: string | undefined
): DatasetPick | null {
  const evidence = evidenceId ? byId.get(evidenceId) : undefined
  if (evidence?.origin !== 'REVIEWER' || !evidence.method) return null
  return {
    method: evidence.method,
    page: evidence.page,
    text: evidence.text,
    bbox: evidence.bbox ?? null,
    location: evidence.location ?? null
  }
}

/** Chi ha messo il valore di una riga. La usa anche l'export XLSX, con la stessa semantica. */
export function itemOrigin(item: FieldItem): DatasetValueOrigin {
  if (item.origin === 'MANUAL') return 'REVIEWER'
  return item.correctedValue === undefined || item.correctedValue === item.value
    ? 'ENGINE'
    : 'REVIEWER'
}

/** Da chi vengono le righe di un campo ripetuto; `null` se la lista è vuota. */
export function listOrigin(items: Array<{ origin: DatasetValueOrigin }>): DatasetListOrigin | null {
  if (items.length === 0) return null
  const origins = new Set(items.map((item) => item.origin))
  return origins.size === 1 ? [...origins][0]! : 'MIXED'
}

/** Quello che il motore aveva proposto per un campo singolo, `null` se non ha proposto niente. */
export function proposedFieldValue(field: Pick<ExtractedField, 'value'>): string | null {
  return field.value.trim() === '' ? null : field.value
}

/** Chi ha messo il valore confermato di un campo singolo; `null` se è rimasto vuoto. */
export function fieldOrigin(
  field: Pick<ExtractedField, 'value' | 'correctedValue'>
): DatasetValueOrigin | null {
  const value = currentFieldValue(field)
  if (value === null) return null
  return value === proposedFieldValue(field) ? 'ENGINE' : 'REVIEWER'
}

function toDatasetField(field: ExtractedField, byId: Map<string, EvidenceItem>): DatasetField {
  const common = { name: field.name, label: field.label, role: field.role }

  if (field.cardinality === 'many') {
    const items = confirmedItems(field.items).map((item) => ({
      value: currentItemValue(item)!,
      origin: itemOrigin(item),
      evidence: evidenceOf(byId, item.evidenceId),
      pick: pickOf(byId, item.correctedEvidenceId)
    }))
    return {
      ...common,
      cardinality: 'many',
      value: items.map((item) => item.value),
      origin: listOrigin(items),
      items
    }
  }

  return {
    ...common,
    cardinality: 'one',
    value: currentFieldValue(field),
    origin: fieldOrigin(field),
    evidence: evidenceOf(byId, field.evidenceId),
    pick: pickOf(byId, field.correctedEvidenceId)
  }
}

function toDocumentType(document: ReviewDocument): DatasetDocumentType {
  const classification = document.classification
  const proposed = classification?.proposedType ?? null
  const known = classification !== null
  const chosenBy = !document.documentType
    ? null
    : document.typeConfidence === null
      ? 'REVIEWER'
      : 'ENGINE'

  const candidates: DatasetTypeCandidate[] = (classification?.candidates ?? []).map(
    (candidate, index) => ({
      documentType: candidate.documentType,
      registryId: praticaaiTypeIdOrNull(candidate.documentType),
      score: candidate.score,
      rank: index + 1
    })
  )
  // Senza un tipo scelto non c'è niente da cercare in lista; con un tipo che non c'è,
  // `rank: null` dice che non abbassare le soglie non basterebbe a trovarlo.
  const found = document.documentType
    ? (candidates.find((candidate) => candidate.documentType === document.documentType) ?? null)
    : null

  return {
    id: document.documentType,
    label: document.documentTypeLabel,
    registry: {
      id: praticaaiTypeIdOrNull(document.documentType),
      proposed: praticaaiTypeIdOrNull(proposed)
    },
    chosenBy,
    proposed,
    proposedConfidence: proposed ? (classification?.confidence ?? null) : null,
    corrected: known ? document.documentType !== proposed : null,
    decision: classification?.decision ?? null,
    reason: classification?.reason ?? null,
    margin: classification?.margin ?? null,
    threshold: classification?.threshold ?? null,
    minimumMargin: classification?.minimumMargin ?? null,
    candidates,
    chosen: document.documentType
      ? { rank: found?.rank ?? null, score: found?.score ?? null }
      : null
  }
}

export function toDatasetDocument(source: DatasetSource): DatasetDocument | null {
  const { document } = source
  if (document.status === 'NEEDS_REVIEW') return null

  const reviewed = document.status === 'REVIEWED'
  const byId = new Map(document.evidence.map((item) => [item.id, item]))
  const fieldsById = new Map(document.fields.map((field) => [field.id, field]))
  /** La selezione dietro una correzione: quella della riga, o del campo singolo. */
  const correctionPick = (correction: { fieldId: string; itemId: string | null }) => {
    const field = fieldsById.get(correction.fieldId)
    const source =
      correction.itemId === null
        ? field
        : field?.items.find((item) => item.id === correction.itemId)
    return pickOf(byId, source?.correctedEvidenceId)
  }

  return {
    driveFileId: document.driveFileId,
    contentSha256: document.contentSha256,
    filename: document.filename,
    mime: document.mime,
    status: document.status,
    reviewedAt: document.reviewedAt,
    textSource: document.textSource,
    documentType: toDocumentType(document),
    extraction: source.extraction,
    fields: reviewed ? document.fields.map((field) => toDatasetField(field, byId)) : [],
    corrections: reviewed
      ? documentCorrections(document.fields).map((correction) => ({
          field: correction.name,
          label: correction.label,
          item: correction.itemIndex,
          kind: correction.kind,
          before: correction.before,
          after: correction.after,
          pick: correction.after === null ? null : correctionPick(correction)
        }))
      : []
  }
}

/**
 * Il dataset completo. Entrano solo i documenti chiusi dal revisore, in ordine di nome
 * file e poi di id Drive: due export dello stesso database sono identici salvo la data.
 */
export function buildDataset(
  manifest: DatasetManifestInput,
  sources: DatasetSource[]
): AnnotatedDataset {
  const documents = sources
    .map(toDatasetDocument)
    .filter((document): document is DatasetDocument => document !== null)
    .sort(
      (a, b) =>
        a.filename.localeCompare(b.filename, 'it') || a.driveFileId.localeCompare(b.driveFileId)
    )

  return {
    manifest: {
      format: DATASET_FORMAT,
      formatVersion: DATASET_FORMAT_VERSION,
      exportedAt: manifest.exportedAt,
      app: manifest.app,
      engines: manifest.engines,
      counts: {
        documents: documents.length,
        reviewed: documents.filter((document) => document.status === 'REVIEWED').length,
        discarded: documents.filter((document) => document.status === 'DISCARDED').length,
        corrections: documents.reduce((sum, document) => sum + document.corrections.length, 0)
      },
      learning: manifest.learning ?? null
    },
    documents
  }
}

/** JSON leggibile, una chiave per riga: il file si apre e si confronta a occhio. */
export function serializeDataset(dataset: AnnotatedDataset): string {
  return `${JSON.stringify(dataset, null, 2)}\n`
}

/** Nome proposto per il file: `praticaai-dataset-2026-09-16.json`. */
export function datasetFileName(now: Date): string {
  return `praticaai-dataset-${now.toISOString().slice(0, 10)}.json`
}
