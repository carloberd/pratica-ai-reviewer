import type { Cardinality, FieldOntologyEntry } from './extraction-v2'
import type { ProfileAction } from './profile-history'
import { countStandingEdits, isMapEdit } from './profile-history'
import { REVIEWER_EDITED_SCHEMA_STATE } from './profile-metrics'
import {
  applyCardinalityOverlay,
  applyHintOverlay,
  applyOverlay,
  cardinalityOf,
  excludedFields,
  type ProfileOverlay,
  ROLE_KEYS,
  ROLES,
  roleIn,
  type TypeCardinality,
  type TypeOverrides
} from './profile-overlay'

/**
 * I file della mappa corretta, prodotti su richiesta.
 *
 * Il database tiene le decisioni del revisore; qui diventano i file che pratica-ai sa
 * leggere. Nessuno di questi file viene scritto durante il lavoro: si generano quando il
 * revisore esporta, dai JSON del registry che non sono mai stati toccati più le
 * correzioni. Ripetere l'export senza fare altro dà gli stessi byte.
 *
 * Quattro file:
 *
 * - `class_extraction_profiles_v2.json` e `extraction_hints_v2.json`, nella forma del
 *   programmer pack: si sostituiscono ai due del pack e il motore riparte da lì;
 * - `extraction_schemas_v2.json`, uno JSON Schema per tipo con le chiavi dell'ontologia,
 *   nella stessa forma di `extraction_schemas_v2.generated.json`: è quello che
 *   l'Extraction Brain v2 consuma senza traduzioni;
 * - `changelog.json`, che dice cosa è cambiato rispetto al registry e perché, con i
 *   numeri delle annotazioni che hanno motivato ogni decisione.
 *
 * Modulo puro: nessun file, nessun database. Il main gli passa quello che ha letto.
 */

/** Un profilo come sta nel file: le chiavi che servono qui, più tutte le altre. */
export interface RawProfile {
  document_type_id: string
  canonical_name: string
  family: string
  schema_state: string
  evidence_basis: string
  required_fields: string[]
  core_fields: string[]
  optional_fields: string[]
  conditional_fields: string[]
  field_provenance?: Record<string, string>
  /** Uno o più valori per campo, dove il revisore l'ha deciso diversamente dall'ontologia. */
  field_cardinality?: Record<string, Cardinality>
  /** I validatori del campo su questo tipo, al posto di quelli dell'ontologia. */
  field_validator_overrides?: Record<string, string[]>
  [key: string]: unknown
}

export interface ProfilesFile {
  version: string
  profiles: Record<string, RawProfile>
  [key: string]: unknown
}

export interface RawHint {
  labels: string[]
  [key: string]: unknown
}

export interface HintsFile {
  version: string
  hints: Record<string, RawHint>
  [key: string]: unknown
}

export const PROFILES_FILE = 'class_extraction_profiles_v2.json'
export const HINTS_FILE = 'extraction_hints_v2.json'
export const SCHEMAS_FILE = 'extraction_schemas_v2.json'
export const CHANGELOG_FILE = 'changelog.json'

/** Provenienza scritta sui campi che arrivano dalle annotazioni, non dall'AI. */
export const REVIEWER_PROVENANCE = 'REVIEWER_ANNOTATIONS'

/** I campi scartati restano scritti: «non utile» è una decisione, non una cancellazione. */
export const EXCLUDED_KEY = 'x_reviewer_excluded_fields'
export const EDITED_KEY = 'x_reviewer_edited'

export interface BundleFile {
  name: string
  content: string
}

export interface ProfileBundleManifestInput {
  app: { name: string; version: string }
  /** `version` dei profili del registry da cui si parte. */
  schemaVersion: string | null
  exportedAt: string
}

export interface ProfileBundleInput {
  manifest: ProfileBundleManifestInput
  /** I due file del registry, letti dal disco e mai modificati. */
  profiles: ProfilesFile
  hints: HintsFile
  overlay: ProfileOverlay
  ontology: Record<string, FieldOntologyEntry>
  /**
   * Profili sintetizzati per i tipi che il file non prevede (LEGACY_FALLBACK) ma su cui
   * il revisore ha deciso qualcosa: senza, quelle decisioni non uscirebbero da nessuna
   * parte. Entrano nel file marcati come schemi non verificati.
   */
  fallbackProfiles?: Record<string, RawProfile>
  actions: ProfileAction[]
}

export interface ProfileBundle {
  files: BundleFile[]
  /** Tipi con almeno una decisione del revisore. */
  types: number
  /** Campi aggiunti, scartati, ripesati o con un'altra cardinalità, in totale. */
  fields: number
  /** Azioni sulla mappa ancora in piedi. */
  edits: number
}

/**
 * Due spazi di indentazione e nessun a capo finale: è la forma in cui i file arrivano
 * dal programmer pack, e riscriverli così tiene il diff alle righe cambiate.
 */
export function serializeRegistryJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/** Il profilo materializzato per un tipo che il file non prevedeva. */
function materialize(fallback: RawProfile): RawProfile {
  return {
    ...fallback,
    schema_state: REVIEWER_EDITED_SCHEMA_STATE,
    evidence_basis: 'REVIEWER_ANNOTATIONS+LEGACY_REGISTRY'
  }
}

/** Il profilo del registry con sopra le decisioni, e la traccia di chi le ha prese. */
function correctedProfile(
  base: RawProfile,
  overrides: TypeOverrides,
  cardinality: TypeCardinality
): RawProfile {
  const next = applyCardinalityOverlay(applyOverlay(base, overrides), cardinality)
  const excluded = excludedFields(overrides)

  const provenance: Record<string, string> = { ...(base.field_provenance ?? {}) }
  for (const [fieldId, state] of Object.entries(overrides)) {
    if (state === 'excluded') delete provenance[fieldId]
    else provenance[fieldId] = REVIEWER_PROVENANCE
  }

  const corrected: RawProfile = { ...next, field_provenance: provenance, [EDITED_KEY]: true }
  if (excluded.length > 0) corrected[EXCLUDED_KEY] = excluded
  else delete corrected[EXCLUDED_KEY]
  const validators = validatorOverridesIn(corrected)
  if (validators) corrected.field_validator_overrides = validators
  else delete corrected.field_validator_overrides
  return corrected
}

/**
 * Le eccezioni ai validatori dei soli campi che il profilo corretto chiede ancora. Un campo
 * segnato «non utile» esce dal profilo, e un'eccezione su un campo fuori profilo farebbe
 * rifiutare il file esportato al loader che lo rilegge.
 */
function validatorOverridesIn(profile: RawProfile): Record<string, string[]> | null {
  const overrides = profile.field_validator_overrides
  if (!overrides) return null
  const kept = Object.entries(overrides).filter(([fieldId]) => roleIn(profile, fieldId) !== null)
  return kept.length > 0 ? Object.fromEntries(kept) : null
}

/** Le etichette insegnate, in coda a quelle del registry. */
function correctedHints(hints: HintsFile, overlay: ProfileOverlay): HintsFile {
  const taught = Object.entries(overlay.hintLabels).filter(([, labels]) => labels.length > 0)
  if (taught.length === 0) return hints

  const next: Record<string, RawHint> = { ...hints.hints }
  for (const [fieldId, labels] of taught) {
    const current = next[fieldId]
    next[fieldId] = current
      ? { ...current, labels: applyHintOverlay(current.labels, labels) }
      : { labels: [...labels], regexes: [], scope: 'whole_document', candidate_limit: 10 }
  }
  return { ...hints, hints: next }
}

// ---------------------------------------------------------------------------
// Lo JSON Schema per tipo
// ---------------------------------------------------------------------------

type JsonSchemaProperty = Record<string, unknown>

/**
 * La forma di un campo, dedotta dall'ontologia come nel file del programmer pack. La
 * cardinalità è quella del profilo: l'ontologia, o la decisione del revisore per il tipo.
 * I validatori anche: quelli dell'ontologia, o l'eccezione del profilo per il tipo.
 */
function propertyFor(
  field: FieldOntologyEntry,
  cardinality: Cardinality,
  validators: string[]
): JsonSchemaProperty {
  const scalar: JsonSchemaProperty =
    field.type === 'date'
      ? { type: 'string', format: 'date' }
      : field.type === 'money' || field.type === 'number'
        ? { type: 'number' }
        : field.type === 'integer'
          ? { type: 'integer' }
          : field.type === 'boolean'
            ? { type: 'boolean' }
            : field.type === 'object'
              ? { type: 'object', additionalProperties: true }
              : { type: 'string' }

  const shape: JsonSchemaProperty =
    cardinality === 'many' ? { type: 'array', items: scalar } : scalar

  return {
    ...shape,
    'x-praticaai-evidence-required': field.evidence_required,
    'x-praticaai-pii': field.pii,
    'x-praticaai-validators': validators
  }
}

/** I campi di un profilo nell'ordine obbligatori → principali → opzionali → condizionali. */
function orderedFields(profile: RawProfile): string[] {
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const role of ROLES) {
    for (const fieldId of profile[ROLE_KEYS[role]]) {
      if (seen.has(fieldId)) continue
      seen.add(fieldId)
      ordered.push(fieldId)
    }
  }
  return ordered
}

/**
 * Lo JSON Schema di un tipo. Un campo che l'ontologia non conosce resta fuori dallo
 * schema: uno schema che cita un campo senza forma non è caricabile, e il changelog lo
 * segnala invece di lasciarlo sparire in silenzio.
 */
export function jsonSchemaFor(
  documentType: string,
  profile: RawProfile,
  ontology: Record<string, FieldOntologyEntry>
): { schema: Record<string, unknown>; unknownFields: string[] } {
  const properties: Record<string, JsonSchemaProperty> = {}
  const unknownFields: string[] = []

  for (const fieldId of orderedFields(profile)) {
    const field = ontology[fieldId]
    if (!field) {
      unknownFields.push(fieldId)
      continue
    }
    properties[fieldId] = propertyFor(
      field,
      cardinalityOf(profile, fieldId, field.default_cardinality),
      profile.field_validator_overrides?.[fieldId] ?? field.validators
    )
  }

  return {
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `schema.document.${documentType}.v2`,
      type: 'object',
      properties,
      required: profile.required_fields.filter((fieldId) => ontology[fieldId]),
      additionalProperties: false,
      'x-praticaai-schema-state': profile.schema_state,
      'x-praticaai-evidence-basis': profile.evidence_basis,
      'x-praticaai-literal-evidence-required': profile.literal_evidence_required ?? true
    },
    unknownFields
  }
}

// ---------------------------------------------------------------------------
// Il pacchetto
// ---------------------------------------------------------------------------

/** Cosa è cambiato su un tipo, rispetto al registry di partenza. */
export interface TypeChange {
  documentType: string
  added: Array<{ fieldId: string; role: string }>
  excluded: string[]
  rerolled: Array<{ fieldId: string; from: string; to: string }>
  /** Campi che su questo tipo chiedono un numero di valori diverso dall'ontologia. */
  cardinality: Array<{ fieldId: string; from: Cardinality; to: Cardinality }>
}

function changesFor(
  documentType: string,
  base: RawProfile | null,
  overrides: TypeOverrides,
  cardinality: TypeCardinality,
  ontology: Record<string, FieldOntologyEntry>
): TypeChange {
  const change: TypeChange = {
    documentType,
    added: [],
    excluded: [],
    rerolled: [],
    cardinality: []
  }
  for (const [fieldId, to] of Object.entries(cardinality)) {
    const from = ontology[fieldId]?.default_cardinality ?? 'one'
    if (from !== to) change.cardinality.push({ fieldId, from, to })
  }
  change.cardinality.sort((a, b) => a.fieldId.localeCompare(b.fieldId))
  for (const [fieldId, state] of Object.entries(overrides)) {
    const from = base
      ? (ROLES.find((role) => base[ROLE_KEYS[role]].includes(fieldId)) ?? null)
      : null
    if (state === 'excluded') change.excluded.push(fieldId)
    else if (from === null) change.added.push({ fieldId, role: state })
    else if (from !== state) change.rerolled.push({ fieldId, from, to: state })
  }
  change.added.sort((a, b) => a.fieldId.localeCompare(b.fieldId))
  change.excluded.sort()
  change.rerolled.sort((a, b) => a.fieldId.localeCompare(b.fieldId))
  return change
}

export function buildProfileBundle(input: ProfileBundleInput): ProfileBundle {
  const { manifest, overlay, ontology } = input
  const touched = [
    ...new Set([...Object.keys(overlay.fields), ...Object.keys(overlay.cardinality)])
  ]
    .map((documentType) => ({
      documentType,
      overrides: overlay.fields[documentType] ?? {},
      cardinality: overlay.cardinality[documentType] ?? {}
    }))
    .filter(
      (entry) =>
        Object.keys(entry.overrides).length > 0 || Object.keys(entry.cardinality).length > 0
    )
    .sort((a, b) => a.documentType.localeCompare(b.documentType))

  const profiles: Record<string, RawProfile> = { ...input.profiles.profiles }
  const changes: TypeChange[] = []
  let fields = 0

  for (const { documentType, overrides, cardinality } of touched) {
    const explicit = input.profiles.profiles[documentType] ?? null
    const fallback = input.fallbackProfiles?.[documentType]
    const base = explicit ?? (fallback ? materialize(fallback) : null)
    if (!base) continue

    profiles[documentType] = correctedProfile(base, overrides, cardinality)
    changes.push(changesFor(documentType, explicit, overrides, cardinality, ontology))
    fields += new Set([...Object.keys(overrides), ...Object.keys(cardinality)]).size
  }

  const correctedProfiles: ProfilesFile = { ...input.profiles, profiles }
  const hints = correctedHints(input.hints, overlay)

  const schemas: Record<string, unknown> = {}
  const unknownByType: Record<string, string[]> = {}
  for (const [documentType, profile] of Object.entries(profiles)) {
    const { schema, unknownFields } = jsonSchemaFor(documentType, profile, ontology)
    schemas[documentType] = schema
    if (unknownFields.length > 0) unknownByType[documentType] = unknownFields
  }

  const changelog = {
    manifest: {
      app: manifest.app,
      exportedAt: manifest.exportedAt,
      registrySchemaVersion: manifest.schemaVersion,
      counts: {
        types: changes.length,
        fields,
        actions: input.actions.length,
        standingEdits: countStandingEdits(input.actions)
      }
    },
    /** La mappa come sta adesso, tipo per tipo: solo quello che il revisore ha deciso. */
    changes,
    /** Ogni azione, anche quelle annullate: la cronologia non si riscrive. */
    actions: input.actions.map((action) => ({
      ...action,
      standing: isMapEdit(action.kind) && action.revertedAt === null
    })),
    /** Campi citati da un profilo ma assenti dall'ontologia: fuori dagli schemi. */
    fieldsWithoutOntology: unknownByType
  }

  return {
    files: [
      { name: PROFILES_FILE, content: serializeRegistryJson(correctedProfiles) },
      { name: HINTS_FILE, content: serializeRegistryJson(hints) },
      { name: SCHEMAS_FILE, content: serializeRegistryJson(schemas) },
      { name: CHANGELOG_FILE, content: serializeRegistryJson(changelog) }
    ],
    types: changes.length,
    fields,
    edits: countStandingEdits(input.actions)
  }
}

/** Il nome della cartella proposta al revisore: `mappa-tipi-2026-09-17`. */
export function bundleFolderName(now: Date): string {
  return `mappa-tipi-${now.toISOString().slice(0, 10)}`
}
