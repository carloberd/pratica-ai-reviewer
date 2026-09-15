import { fieldSemanticType } from '@shared/fields'
import type {
  Annotation,
  BoundingBox,
  ConfidenceBand,
  EvidenceItem,
  ExtractedField,
  QueueStatus,
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
}

export interface EvidenceRow {
  id: string
  document_id: string
  page: number
  text: string
  bbox_json: string | null
  confidence: number
}

export interface AnnotationRow {
  id: string
  document_id: string
  page: number
  bbox_json: string
  kind: string
  note: string | null
  created_at: string
  updated_at: string
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
  return value === 'APPROVED' || value === 'REJECTED' ? value : 'NEEDS_REVIEW'
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
    semanticType: fieldSemanticType(row.name),
    ...(row.updated_at ? { updatedAt: row.updated_at } : {})
  }
}

export function toAnnotation(row: AnnotationRow): Annotation {
  return {
    id: row.id,
    documentId: row.document_id,
    page: row.page,
    bbox: parseBbox(row.bbox_json) ?? { x: 0, y: 0, w: 0, h: 0 },
    kind: row.kind === 'note' ? 'note' : 'highlight',
    ...(row.note !== null ? { note: row.note } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function toTimelineItem(row: EventRow): TimelineItem {
  return { id: row.id, at: row.at, title: row.title, detail: row.detail }
}
