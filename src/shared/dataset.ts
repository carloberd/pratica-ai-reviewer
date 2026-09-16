import type { FieldRole } from './extraction-v2'
import {
  type CorrectionKind,
  confirmedItems,
  currentFieldValue,
  currentItemValue,
  documentCorrections
} from './field-edits'
import type {
  BoundingBox,
  EvidenceItem,
  ExtractedField,
  FieldItem,
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
export const DATASET_FORMAT_VERSION = '1.0.0'

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
}

export interface DatasetEvidence {
  page: number
  /** Verbatim dal documento. */
  text: string
  bbox: BoundingBox | null
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
}

export interface DatasetListItem {
  value: string
  origin: DatasetValueOrigin
  evidence: DatasetEvidence | null
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
}

export interface DatasetDocumentType {
  id: string | null
  label: string | null
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

export type DatasetManifestInput = Pick<DatasetManifest, 'exportedAt' | 'app' | 'engines'>

function evidenceOf(
  byId: Map<string, EvidenceItem>,
  evidenceId: string | undefined
): DatasetEvidence | null {
  const evidence = evidenceId ? byId.get(evidenceId) : undefined
  if (!evidence) return null
  return { page: evidence.page, text: evidence.text, bbox: evidence.bbox ?? null }
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
      evidence: evidenceOf(byId, item.evidenceId)
    }))
    return { ...common, cardinality: 'many', value: items.map((item) => item.value), items }
  }

  return {
    ...common,
    cardinality: 'one',
    value: currentFieldValue(field),
    origin: fieldOrigin(field),
    evidence: evidenceOf(byId, field.evidenceId)
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

  return {
    driveFileId: document.driveFileId,
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
          after: correction.after
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
      }
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
