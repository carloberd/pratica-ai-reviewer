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
export type FieldRole = 'required' | 'optional'
export type FieldReviewStatus = 'AUTO_ACCEPTED' | 'NEEDS_REVIEW' | 'MISSING' | 'CONFLICT'

/** Quanto è personale il dato di un campo: i valori del pack, dal meno al più delicato. */
export const FIELD_PII = ['none', 'personal', 'business', 'sensitive', 'financial'] as const
export type FieldPii = (typeof FIELD_PII)[number]

export interface FieldOntologyEntry {
  id: string
  label_it: string
  type: ExtractionScalar
  format?: string | null
  default_cardinality: Cardinality
  pii: FieldPii
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
  required_fields: string[]
  optional_fields: string[]
  literal_evidence_required: boolean
  unknown_value_policy: 'LEAVE_EMPTY'
  review_policy: string
  /**
   * La cardinalità decisa per questo tipo, solo dove è diversa da `default_cardinality`
   * dell'ontologia. Il registry non la scrive: la mette il revisore (`@shared/profile-overlay`).
   */
  field_cardinality?: Record<string, Cardinality>
  /**
   * I validatori di un campo su questo tipo, al posto di quelli dell'ontologia: su una nota
   * di credito `money.total` può essere negativo, su una fattura no. Solo per i campi del
   * profilo; lista vuota vuol dire nessun validatore. Lo scrive il registry, non il revisore.
   */
  field_validator_overrides?: Record<string, string[]>
  /**
   * Il `pii` di un campo su questo tipo, al posto di quello dell'ontologia: `document.number`
   * è `none` su una fattura e `sensitive` su una carta d'identità, dove prende il posto di
   * `identity.document_number`. Solo per i campi del profilo. Lo scrive il registry.
   */
  field_pii_overrides?: Record<string, FieldPii>
  /**
   * Cosa vuol dire un campo su questo tipo, al posto della descrizione dell'ontologia:
   * su una ricevuta di bonifico `bank.iban` è l'IBAN di chi incassa, e accanto c'è il
   * conto da cui il bonifico parte. Solo per i campi del profilo. Lo scrive il registry,
   * e il revisore la legge sulla scheda del campo nella mappa del tipo.
   */
  field_description_overrides?: Record<string, string>
}

/** Il `pii` di un campo su un tipo: l'eccezione del profilo, o quello dell'ontologia. */
export function piiOf(
  profile: Pick<ClassExtractionProfile, 'field_pii_overrides'> | null | undefined,
  fieldId: string,
  spec: Pick<FieldOntologyEntry, 'pii'>
): FieldPii {
  return profile?.field_pii_overrides?.[fieldId] ?? spec.pii
}

/**
 * Cosa vuol dire un campo su un tipo: l'eccezione del profilo, o la descrizione
 * dell'ontologia. Le 257 descrizioni del pack ripetono l'etichetta e non dicono niente di
 * più: `null` quando non c'è altro da leggere oltre al nome del campo.
 */
export function descriptionOf(
  profile: Pick<ClassExtractionProfile, 'field_description_overrides'> | null | undefined,
  fieldId: string,
  spec: Pick<FieldOntologyEntry, 'label_it' | 'description'> | null | undefined
): string | null {
  const override = profile?.field_description_overrides?.[fieldId]
  if (override) return override
  if (!spec || spec.description === spec.label_it) return null
  return spec.description || null
}

/**
 * ## Come il motore ha letto il valore
 *
 * Le due letture che l'estrazione sa fare oggi: il valore subito dopo l'etichetta sulla
 * stessa riga, oppure in testa alla riga successiva quando quella dell'etichetta finisce
 * lì. Non c'è altro, e il tipo non promette altro: un vocabolario che elenca modi di
 * leggere che nessuno produce diventa documentazione falsa il giorno dopo. Chi accenderà
 * una lettura nuova allargherà questo tipo insieme al codice che la fa.
 */
export type ExtractionStrategy = 'LABEL_STRICT' | 'NEXT_LINE'

/**
 * ## L'ambito della regola appresa che ha letto il valore
 *
 * Le stesse due parole di `LearningRuleScope`, riscritte qui perché il contratto
 * dell'estrazione sta sotto a quello del learner e importarlo girerebbe in tondo. Che le
 * due liste restino la stessa lista non è affidato alla buona volontà: il lettore dei fatti
 * assegna un `LearningRuleScope` a questo campo, quindi il giorno in cui una delle due
 * cresce senza l'altra è `tsc` ad accorgersene.
 */
export type ExtractionRuleScope = 'TEMPLATE' | 'CLASS'

export interface ExtractionEvidenceV2 {
  page: number
  text: string
  bbox?: { x: number; y: number; w: number; h: number }
  /** La regola appresa che ha trovato l'etichetta; assente per le etichette del registry. */
  ruleId?: string
  /** Con quale delle due letture il valore è stato preso. */
  strategy?: ExtractionStrategy
  /** L'ambito della regola in `ruleId`; assente quando l'etichetta è del registry. */
  ruleScope?: ExtractionRuleScope
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
  /**
   * Il valore è dedotto, non letto: non ha evidenza, perché nel documento non c'è. Oggi
   * solo la scadenza di un attestato di formazione (`@shared/training-expiry`). Un valore
   * letto non lo porta mai, e chi misura l'estrazione deve poterli separare.
   */
  computed?: boolean
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
