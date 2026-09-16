import { fieldSemanticType } from '@shared/fields'
import type {
  BoundingBox,
  ConfidenceBand,
  EvidenceItem,
  ExtractedField,
  QueueStatus,
  SemanticType,
  TextSource,
  TimelineItem
} from '@shared/types'

export interface DocumentRow {
  id: string
  drive_file_id: string
  filename: string
  mime: string
  document_type: string | null
  type_confidence: number | null
  confidence: number | null
  confidence_band: string | null
  status: string
  cached_path: string | null
  text_source: string | null
  received_at: string | null
  synced_at: string
}

export interface FieldRow {
  id: string
  document_id: string
  name: string
  label: string
  value: string | null
  corrected_value: string | null
  confidence: number
  evidence_id: string | null
  updated_at: string | null
  /** Colonne v2 (migrazione 0004): nulle sulle righe scritte dal motore v1. */
  semantic_type: string | null
  cardinality: string
  review_status: string | null
  validation_errors_json: string | null
  role: string | null
}

/** Un elemento di un campo `many` (righe fattura, rate, ...). I valori sono JSON. */
export interface FieldItemRow {
  id: string
  field_id: string
  item_index: number
  value_json: string | null
  corrected_value_json: string | null
  confidence: number
  evidence_id: string | null
  validation_errors_json: string | null
  updated_at: string | null
}

export interface ExtractionRunRow {
  id: string
  document_id: string
  engine_version: string
  schema_version: string
  document_type: string
  started_at: string
  completed_at: string | null
  status: string
  missing_required_json: string | null
  conflicts_json: string | null
  metrics_json: string | null
}

export interface EvidenceRow {
  id: string
  document_id: string
  page: number
  text: string
  bbox_json: string | null
  confidence: number
}

export interface EventRow {
  id: string
  document_id: string
  at: string
  title: string
  detail: string
}

export function parseBbox(json: string | null): BoundingBox | undefined {
  if (!json) return undefined
  try {
    const parsed = JSON.parse(json) as Partial<BoundingBox>
    if (
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number' &&
      typeof parsed.w === 'number' &&
      typeof parsed.h === 'number'
    ) {
      return { x: parsed.x, y: parsed.y, w: parsed.w, h: parsed.h }
    }
  } catch {
    // Un bbox illeggibile non deve far saltare la lettura del documento.
  }
  return undefined
}

export function toStatus(value: string): QueueStatus {
  return value === 'REVIEWED' || value === 'DISCARDED' ? value : 'NEEDS_REVIEW'
}

export function toBand(value: string | null): ConfidenceBand {
  return value === 'HIGH' || value === 'MEDIUM' ? value : 'LOW'
}

export function toTextSource(value: string | null): TextSource | null {
  return value === 'NATIVE_TEXT' || value === 'OCR' || value === 'DOCX' ? value : null
}

export function toEvidenceItem(row: EvidenceRow, label: string): EvidenceItem {
  const bbox = parseBbox(row.bbox_json)
  return {
    id: row.id,
    label,
    page: row.page,
    text: row.text,
    confidence: row.confidence,
    ...(bbox ? { bbox } : {})
  }
}

/**
 * Il tipo semantico della UI: dalla colonna v2 quando c'è, altrimenti dal closed set dei
 * 40 campi v1. Gli altri tipi dell'ontologia (identificativi, numeri) si editano come testo.
 */
export function semanticTypeOf(row: Pick<FieldRow, 'name' | 'semantic_type'>): SemanticType {
  if (row.semantic_type === null || row.semantic_type === undefined) {
    return fieldSemanticType(row.name)
  }
  return row.semantic_type === 'date' || row.semantic_type === 'money'
    ? row.semantic_type
    : 'string'
}

export function toExtractedField(row: FieldRow, required: boolean): ExtractedField {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    value: row.value ?? '',
    ...(row.corrected_value !== null ? { correctedValue: row.corrected_value } : {}),
    confidence: row.confidence,
    ...(row.evidence_id ? { evidenceId: row.evidence_id } : {}),
    required,
    semanticType: semanticTypeOf(row),
    ...(row.updated_at ? { updatedAt: row.updated_at } : {})
  }
}

export function toTimelineItem(row: EventRow): TimelineItem {
  return { id: row.id, at: row.at, title: row.title, detail: row.detail }
}
