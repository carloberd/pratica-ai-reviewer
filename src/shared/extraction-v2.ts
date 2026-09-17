export type ExtractionScalar =
  | 'string'
  | 'identifier'
  | 'date'
  | 'money'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'

export type Cardinality = 'one' | 'many'
export type FieldRole = 'required' | 'core' | 'optional' | 'conditional'
export type FieldReviewStatus = 'AUTO_ACCEPTED' | 'NEEDS_REVIEW' | 'MISSING' | 'CONFLICT'

export interface FieldOntologyEntry {
  id: string
  label_it: string
  type: ExtractionScalar
  format?: string | null
  default_cardinality: Cardinality
  pii: 'none' | 'personal' | 'business' | 'sensitive' | 'financial'
  evidence_required: boolean
  validators: string[]
  description: string
  label_aliases_it: string[]
}

export interface ClassExtractionProfile {
  document_type_id: string
  canonical_name: string
  family: string
  schema_state: string
  evidence_basis: string
  required_fields: string[]
  core_fields: string[]
  optional_fields: string[]
  conditional_fields: string[]
  literal_evidence_required: boolean
  unknown_value_policy: 'LEAVE_EMPTY'
  review_policy: string
  /**
   * La cardinalità decisa per questo tipo, solo dove è diversa da `default_cardinality`
   * dell'ontologia. Il registry non la scrive: la mette il revisore (`@shared/profile-overlay`).
   */
  field_cardinality?: Record<string, Cardinality>
}

export interface ExtractionEvidenceV2 {
  page: number
  text: string
  bbox?: { x: number; y: number; w: number; h: number }
}

export interface FieldCandidateV2 {
  fieldId: string
  value: unknown
  normalizedValue: unknown
  confidence: number
  evidence: ExtractionEvidenceV2
  validatorsPassed: string[]
  validatorsFailed: string[]
}

export interface ExtractedFactV2 {
  fieldId: string
  role: FieldRole
  cardinality: Cardinality
  value: unknown
  confidence: number
  evidence: ExtractionEvidenceV2[]
  reviewStatus: FieldReviewStatus
  validationErrors: string[]
}

export interface ExtractionResultV2 {
  documentType: string
  schemaState: string
  facts: ExtractedFactV2[]
  missingRequired: string[]
  conflicts: string[]
  coverage: number
  confidence: number
}
