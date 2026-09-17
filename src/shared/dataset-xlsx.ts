import { type DatasetValueOrigin, fieldOrigin, itemOrigin, proposedFieldValue } from './dataset'
import type { Cardinality, FieldRole } from './extraction-v2'
import { currentFieldValue, currentItemValue, sortedItems } from './field-edits'
import type { EvidenceItem, ExtractedField, FieldItem, ReviewDocument } from './types'

/**
 * Il dataset annotato in forma tabellare, per chi lo lavora in foglio invece che in
 * JSON. Due tabelle, legate da `document_id`: una riga per documento e una riga per
 * campo — o per riga di un campo ripetuto, che `item_index` ordina.
 *
 * È un secondo export, parallelo a quello JSON: le regole del valore confermato e della
 * provenienza sono le stesse (`@shared/dataset`, `@shared/field-edits`), quello che
 * cambia è solo la forma. Qui non c'è né database né filesystem né exceljs: entrano i
 * `ReviewDocument` già letti, escono le righe.
 */

export interface XlsxDocumentRow {
  document_id: string
  drive_file_id: string
  /** Il tipo assegnato dal classificatore: `null` se UNKNOWN o se l'ha scelto il revisore. */
  document_type_predicted: string | null
  /** La verità del revisore, anche quando coincide con la predizione. */
  document_type_final: string | null
  classifier_confidence: number | null
  /** Secondo candidato del classificatore v2; vuoto col v1, che non lo calcola. */
  runner_up: string | null
  /** Distacco fra primo e secondo candidato; vuoto col v1. */
  margin: number | null
  /** Impronta del layout della prima pagina; vuota se la copia locale non è più in cache. */
  template_fingerprint: string | null
  review_status: 'REVIEWED' | 'DISCARDED'
  /** Nota scritta dal revisore chiudendo il documento; vuota se non l'ha scritta. */
  review_note: string | null
}

export interface XlsxFieldRow {
  /** Chiave verso il foglio `documents`. */
  document_id: string
  field_name: string
  label: string
  role: FieldRole | null
  cardinality: Cardinality
  /** `null` per i campi singoli, l'indice della riga per i ripetuti. */
  item_index: number | null
  value_predicted: string | null
  value_final: string | null
  origin: DatasetValueOrigin | null
  confidence: number | null
  evidence_page: number | null
  /** Verbatim dal documento. */
  evidence_text: string | null
  /** JSON del riquadro in unità di pagina pdf.js a scala 1, `null` senza coordinate. */
  evidence_bbox: string | null
}

export interface XlsxRows {
  documents: XlsxDocumentRow[]
  fields: XlsxFieldRow[]
}

export interface XlsxSource {
  document: ReviewDocument
  /** `metrics_json` dell'ultimo run del documento: è quello che corrisponde ai campi di adesso. */
  metricsJson: string | null
  templateFingerprint: string | null
}

/** L'ordine delle colonne dei due fogli: è il contratto del file. */
export const XLSX_DOCUMENT_COLUMNS: Array<keyof XlsxDocumentRow> = [
  'document_id',
  'drive_file_id',
  'document_type_predicted',
  'document_type_final',
  'classifier_confidence',
  'runner_up',
  'margin',
  'template_fingerprint',
  'review_status',
  'review_note'
]

export const XLSX_FIELD_COLUMNS: Array<keyof XlsxFieldRow> = [
  'document_id',
  'field_name',
  'label',
  'role',
  'cardinality',
  'item_index',
  'value_predicted',
  'value_final',
  'origin',
  'confidence',
  'evidence_page',
  'evidence_text',
  'evidence_bbox'
]

interface ClassifierAudit {
  runnerUp: string | null
  margin: number | null
}

const NO_AUDIT: ClassifierAudit = { runnerUp: null, margin: null }

/**
 * Runner-up e margine dall'audit del classificatore salvato nel run.
 *
 * Il v1 non li calcola e non li scrive: restano vuoti, e non si inventano. Un
 * `metrics_json` illeggibile vale come assente — un documento non esce dall'export
 * perché il suo audit è rotto.
 */
export function classifierAudit(metricsJson: string | null): ClassifierAudit {
  if (!metricsJson) return NO_AUDIT
  let parsed: unknown
  try {
    parsed = JSON.parse(metricsJson)
  } catch {
    return NO_AUDIT
  }
  const classifier = (parsed as { classifier?: unknown } | null)?.classifier
  if (!classifier || typeof classifier !== 'object') return NO_AUDIT
  const { runnerUp, margin } = classifier as { runnerUp?: unknown; margin?: unknown }
  const documentType = (runnerUp as { documentType?: unknown } | null)?.documentType
  return {
    runnerUp: typeof documentType === 'string' && documentType !== '' ? documentType : null,
    margin: typeof margin === 'number' ? margin : null
  }
}

function toDocumentRow(source: XlsxSource): XlsxDocumentRow {
  const { document } = source
  const { runnerUp, margin } = classifierAudit(source.metricsJson)
  return {
    document_id: document.id,
    drive_file_id: document.driveFileId,
    document_type_predicted: document.typeConfidence === null ? null : document.documentType,
    document_type_final: document.documentType,
    classifier_confidence: document.typeConfidence,
    runner_up: runnerUp,
    margin,
    template_fingerprint: source.templateFingerprint,
    review_status: document.status === 'DISCARDED' ? 'DISCARDED' : 'REVIEWED',
    // Una nota di soli spazi non è una nota: in foglio sarebbe una cella che sembra
    // piena e non dice niente.
    review_note: document.reviewNote?.trim() ? document.reviewNote.trim() : null
  }
}

function withEvidence(
  row: Omit<XlsxFieldRow, 'evidence_page' | 'evidence_text' | 'evidence_bbox'>,
  byId: Map<string, EvidenceItem>,
  evidenceId: string | undefined
): XlsxFieldRow {
  const evidence = evidenceId ? byId.get(evidenceId) : undefined
  return {
    ...row,
    evidence_page: evidence?.page ?? null,
    evidence_text: evidence?.text ?? null,
    evidence_bbox: evidence?.bbox ? JSON.stringify(evidence.bbox) : null
  }
}

function itemRow(
  documentId: string,
  field: ExtractedField,
  item: FieldItem,
  byId: Map<string, EvidenceItem>
): XlsxFieldRow {
  const value = currentItemValue(item)
  return withEvidence(
    {
      document_id: documentId,
      field_name: field.name,
      label: field.label,
      role: field.role,
      cardinality: 'many',
      item_index: item.index,
      value_predicted: item.value.trim() === '' ? null : item.value,
      value_final: value,
      origin: value === null ? null : itemOrigin(item),
      confidence: item.confidence
    },
    byId,
    item.evidenceId
  )
}

function fieldRows(
  documentId: string,
  field: ExtractedField,
  byId: Map<string, EvidenceItem>
): XlsxFieldRow[] {
  const common = {
    document_id: documentId,
    field_name: field.name,
    label: field.label,
    role: field.role,
    cardinality: field.cardinality
  }

  if (field.cardinality === 'many') {
    // Ci sono anche le righe tolte dal revisore, con `value_final` vuoto: come per un
    // campo singolo svuotato, quello che il motore aveva proposto resta misurabile.
    const items = sortedItems(field.items)
    if (items.length > 0) {
      return items.map((item) => itemRow(documentId, field, item, byId))
    }
    // Nessuna riga: il campo esiste nel profilo e il motore non ha trovato niente.
    // Una riga vuota lo dice; senza, il campo sparirebbe dal foglio.
    return [
      withEvidence(
        {
          ...common,
          item_index: null,
          value_predicted: null,
          value_final: null,
          origin: null,
          confidence: field.confidence
        },
        byId,
        undefined
      )
    ]
  }

  return [
    withEvidence(
      {
        ...common,
        item_index: null,
        value_predicted: proposedFieldValue(field),
        value_final: currentFieldValue(field),
        origin: fieldOrigin(field),
        confidence: field.confidence
      },
      byId,
      field.evidenceId
    )
  ]
}

/**
 * Le righe dei due fogli.
 *
 * Entrano solo i documenti chiusi dal revisore, in ordine di nome file e poi di id
 * Drive: due export dello stesso database sono identici. Degli scartati resta la riga
 * nel foglio `documents` col loro stato, senza campi — nessuno ne ha confermato i
 * valori, esattamente come nell'export JSON.
 */
export function buildXlsxRows(sources: XlsxSource[]): XlsxRows {
  const closed = sources
    .filter((source) => source.document.status !== 'NEEDS_REVIEW')
    .sort(
      (a, b) =>
        a.document.filename.localeCompare(b.document.filename, 'it') ||
        a.document.driveFileId.localeCompare(b.document.driveFileId)
    )

  const documents = closed.map(toDocumentRow)
  const fields = closed.flatMap(({ document }) => {
    if (document.status !== 'REVIEWED') return []
    const byId = new Map(document.evidence.map((item) => [item.id, item]))
    return document.fields.flatMap((field) => fieldRows(document.id, field, byId))
  })

  return { documents, fields }
}

/** Nome proposto per il file: `praticaai-dataset-2026-09-16.xlsx`. */
export function datasetXlsxFileName(now: Date): string {
  return `praticaai-dataset-${now.toISOString().slice(0, 10)}.xlsx`
}
