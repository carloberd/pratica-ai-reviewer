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
  TextSource
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
export const DATASET_FORMAT_VERSION = '1.3.0'

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
    return { ...common, cardinality: 'many', value: items.map((item) => item.value), items }
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
  const proposed = document.classification?.proposedType ?? null
  const known = document.classification !== null
  const chosenBy = !document.documentType
    ? null
    : document.typeConfidence === null
      ? 'REVIEWER'
      : 'ENGINE'
  return {
    id: document.documentType,
    label: document.documentTypeLabel,
    registry: {
      id: praticaaiTypeIdOrNull(document.documentType),
      proposed: praticaaiTypeIdOrNull(proposed)
    },
    chosenBy,
    proposed,
    proposedConfidence: proposed ? (document.classification?.confidence ?? null) : null,
    corrected: known ? document.documentType !== proposed : null
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
