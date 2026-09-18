import type {
  ExtractionRuleScope,
  ExtractionStrategy,
  FieldReviewStatus,
  FieldRole
} from '@shared/extraction-v2'
import { fieldSemanticType } from '@shared/fields'
import type {
  BoundingBox,
  ConfidenceBand,
  EvidenceItem,
  EvidenceOrigin,
  ExtractedField,
  FieldItem,
  PickLocation,
  PickMethod,
  QueueStatus,
  SemanticType,
  TextSource,
  TimelineItem,
  TypeClassification
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
  /** JSON di `TypeClassification` senza etichette (migrazione 0005). */
  classification_json: string | null
  reviewed_at: string | null
  /** Impronta del layout della prima pagina (migrazione 0006); NULL = non ancora calcolata. */
  template_fingerprint: string | null
  /**
   * Firma normalizzata della testata (migrazione 0016), confrontabile per somiglianza.
   * NULL sui documenti elaborati prima, e su quelli la cui prima pagina non ha ancore.
   */
  template_signature_json: string | null
  /** Nota facoltativa lasciata dal revisore chiudendo il documento (migrazione 0007). */
  review_note: string | null
  /** Sha-256 del file elaborato (migrazione 0010); NULL = elaborato prima. */
  content_sha256: string | null
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
  /** Selezione del revisore da cui viene la correzione (migrazione 0010). */
  corrected_evidence_id: string | null
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
  /** `ENGINE` | `MANUAL` (migrazione 0005). */
  origin: string
  /** 1 = riga proposta tolta dal revisore. */
  removed: number
  /** Selezione del revisore da cui viene la correzione (migrazione 0010). */
  corrected_evidence_id: string | null
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
  /** `ENGINE` | `REVIEWER` (migrazione 0010). */
  origin: string
  /** `TEXT_SELECTION` | `AREA_OCR` | `AREA_TEXT`, solo per le evidenze del revisore. */
  method: string | null
  line_start: number | null
  line_end: number | null
  char_start: number | null
  char_end: number | null
  /** La regola appresa che ha letto il valore (migrazione 0012). */
  rule_id: string | null
  /** Il testo letto è stato sistemato a mano dal revisore (migrazione 0015). */
  text_corrected: number
  /** `LABEL_STRICT` | `NEXT_LINE`: come il motore ha letto il valore (migrazione 0017). */
  extraction_strategy: string | null
  /** `TEMPLATE` | `CLASS`: l'ambito della regola in `rule_id` (migrazione 0017). */
  rule_scope: string | null
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
  return value === 'NATIVE_TEXT' || value === 'OCR' || value === 'DOCX' || value === 'OCR_FAILED'
    ? value
    : null
}

export function toEvidenceOrigin(value: string): EvidenceOrigin {
  return value === 'REVIEWER' ? 'REVIEWER' : 'ENGINE'
}

function toPickMethod(value: string | null): PickMethod | undefined {
  return value === 'TEXT_SELECTION' || value === 'AREA_OCR' || value === 'AREA_TEXT'
    ? value
    : undefined
}

/**
 * La provenienza letta dal database non si fida della colonna: non ha un CHECK, e sulle
 * evidenze di prima della 0017 è vuota. Una parola che il codice non conosce vale come
 * assente — meglio non sapere come è stato letto un valore che dichiararlo a caso.
 */
function toExtractionStrategy(value: string | null): ExtractionStrategy | undefined {
  return value === 'LABEL_STRICT' || value === 'NEXT_LINE' ? value : undefined
}

function toExtractionRuleScope(value: string | null): ExtractionRuleScope | undefined {
  return value === 'TEMPLATE' || value === 'CLASS' ? value : undefined
}

/** La posizione salvata: le righe ci sono sempre quando c'è una posizione, gli offset no. */
export function toPickLocation(
  row: Pick<EvidenceRow, 'line_start' | 'line_end' | 'char_start' | 'char_end'>
): PickLocation | undefined {
  if (row.line_start === null || row.line_end === null) return undefined
  return {
    lineStart: row.line_start,
    lineEnd: row.line_end,
    charStart: row.char_start,
    charEnd: row.char_end
  }
}

export function toEvidenceItem(row: EvidenceRow, label: string): EvidenceItem {
  const bbox = parseBbox(row.bbox_json)
  const method = toPickMethod(row.method)
  const location = toPickLocation(row)
  const strategy = toExtractionStrategy(row.extraction_strategy)
  const ruleScope = toExtractionRuleScope(row.rule_scope)
  return {
    id: row.id,
    label,
    page: row.page,
    text: row.text,
    confidence: row.confidence,
    ...(bbox ? { bbox } : {}),
    origin: toEvidenceOrigin(row.origin),
    ...(method ? { method } : {}),
    ...(location ? { location } : {}),
    ...(row.text_corrected === 1 ? { textCorrected: true as const } : {}),
    ...(row.rule_id ? { ruleId: row.rule_id } : {}),
    ...(strategy ? { strategy } : {}),
    ...(ruleScope ? { ruleScope } : {})
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

const ROLES: FieldRole[] = ['required', 'core', 'optional', 'conditional']
const REVIEW_STATUSES: FieldReviewStatus[] = [
  'AUTO_ACCEPTED',
  'NEEDS_REVIEW',
  'MISSING',
  'CONFLICT'
]

/** I valori delle righe sono JSON: una stringa per riga, qualunque altra cosa diventa testo. */
export function parseItemValue(json: string | null): string | null {
  if (json === null) return null
  try {
    const parsed: unknown = JSON.parse(json)
    if (parsed === null) return null
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed)
  } catch {
    return json
  }
}

export function toFieldItem(row: FieldItemRow): FieldItem {
  const corrected = parseItemValue(row.corrected_value_json)
  return {
    id: row.id,
    index: row.item_index,
    value: parseItemValue(row.value_json) ?? '',
    ...(corrected !== null ? { correctedValue: corrected } : {}),
    confidence: row.confidence,
    ...(row.evidence_id ? { evidenceId: row.evidence_id } : {}),
    ...(row.corrected_evidence_id ? { correctedEvidenceId: row.corrected_evidence_id } : {}),
    origin: row.origin === 'MANUAL' ? 'MANUAL' : 'ENGINE',
    removed: row.removed === 1,
    ...(row.updated_at ? { updatedAt: row.updated_at } : {})
  }
}

/**
 * La classificazione salvata. Un JSON illeggibile vale come assente: la scheda tipo
 * perde i candidati, ma il documento resta apribile.
 */
export function parseClassification(
  json: string | null,
  labelOf: (documentType: string) => string | null
): TypeClassification | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as TypeClassification
    if (!Array.isArray(parsed.candidates)) return null
    return {
      ...parsed,
      candidates: parsed.candidates.map((candidate) => ({
        ...candidate,
        label: labelOf(candidate.documentType)
      }))
    }
  } catch {
    return null
  }
}

export function toExtractedField(
  row: FieldRow,
  required: boolean,
  items: FieldItemRow[] = []
): ExtractedField {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    value: row.value ?? '',
    ...(row.corrected_value !== null ? { correctedValue: row.corrected_value } : {}),
    confidence: row.confidence,
    ...(row.evidence_id ? { evidenceId: row.evidence_id } : {}),
    ...(row.corrected_evidence_id ? { correctedEvidenceId: row.corrected_evidence_id } : {}),
    required,
    semanticType: semanticTypeOf(row),
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
    cardinality: row.cardinality === 'many' ? 'many' : 'one',
    role: ROLES.find((role) => role === row.role) ?? null,
    reviewStatus: REVIEW_STATUSES.find((status) => status === row.review_status) ?? null,
    items: row.cardinality === 'many' ? items.map(toFieldItem) : []
  }
}

export function toTimelineItem(row: EventRow): TimelineItem {
  return { id: row.id, at: row.at, title: row.title, detail: row.detail }
}
