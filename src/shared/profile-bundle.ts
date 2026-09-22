import { type Cardinality, type FieldOntologyEntry, type FieldPii, piiOf } from './extraction-v2'
import type { ProfileAction } from './profile-history'
import { countStandingEdits, isMapEdit } from './profile-history'
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
 * revisore esporta, dai due JSON del registry che non sono mai stati toccati più le
 * correzioni. Ripetere l'export senza fare altro dà gli stessi byte.
 *
 * Quattro file:
 *
 * - `fields.json` e `document_fields.json`, nella forma del registry: si sostituiscono ai
 *   due sul disco e il motore riparte da lì. Le etichette insegnate dal revisore entrano
 *   in `label_aliases_it`, dove il registry tiene le sue;
 * - `extraction_schemas.json`, uno JSON Schema per tipo con le chiavi dell'ontologia: è
 *   quello che l'Extraction Brain consuma senza traduzioni;
 * - `changelog.json`, che dice cosa è cambiato rispetto al registry e perché, con i
 *   numeri delle annotazioni che hanno motivato ogni decisione.
 *
 * Modulo puro: nessun file, nessun database. Il main gli passa quello che ha letto.
 */

/** La mappa di un tipo come sta nel file: le chiavi che servono qui, più tutte le altre. */
export interface RawProfile {
  document_type_id: string
  canonical_name: string
  family: string
  /** Quanto il profilo è stato messo alla prova su documenti veri: lo dice il registry. */
  schema_state: string
  required_fields: string[]
  optional_fields: string[]
  field_provenance?: Record<string, string>
  /** Uno o più valori per campo, dove il revisore l'ha deciso diversamente dall'ontologia. */
  field_cardinality?: Record<string, Cardinality>
  /** I validatori del campo su questo tipo, al posto di quelli dell'ontologia. */
  field_validator_overrides?: Record<string, string[]>
  /** Il `pii` del campo su questo tipo, al posto di quello dell'ontologia. */
  field_pii_overrides?: Record<string, FieldPii>
  /** Cosa vuol dire il campo su questo tipo, al posto della descrizione dell'ontologia. */
  field_description_overrides?: Record<string, string>
  [key: string]: unknown
}

export interface DocumentFieldsFile {
  version: string
  document_types: Record<string, RawProfile>
  [key: string]: unknown
}

export interface FieldsFile {
  version: string
  fields: Record<string, FieldOntologyEntry>
  [key: string]: unknown
}

export const FIELDS_FILE = 'fields.json'
export const DOCUMENT_FIELDS_FILE = 'document_fields.json'
export const SCHEMAS_FILE = 'extraction_schemas.json'
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
  catalog: FieldsFile
  map: DocumentFieldsFile
  overlay: ProfileOverlay
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
  const validators = overridesIn(corrected, corrected.field_validator_overrides)
  if (validators) corrected.field_validator_overrides = validators
  else delete corrected.field_validator_overrides
  const pii = overridesIn(corrected, corrected.field_pii_overrides)
  if (pii) corrected.field_pii_overrides = pii
  else delete corrected.field_pii_overrides
  const descriptions = overridesIn(corrected, corrected.field_description_overrides)
  if (descriptions) corrected.field_description_overrides = descriptions
  else delete corrected.field_description_overrides
  return corrected
}

/**
 * Le eccezioni per campo (validatori, `pii`, descrizione) dei soli campi che il profilo
 * corretto chiede ancora. Un campo segnato «non utile» esce dal profilo, e un'eccezione su
 * un campo fuori profilo farebbe rifiutare il file esportato al loader che lo rilegge.
 */
function overridesIn<T>(
  profile: RawProfile,
  overrides: Record<string, T> | undefined
): Record<string, T> | null {
  if (!overrides) return null
  const kept = Object.entries(overrides).filter(([fieldId]) => roleIn(profile, fieldId) !== null)
  return kept.length > 0 ? Object.fromEntries(kept) : null
}

/**
 * Le etichette insegnate, in coda agli alias del registry.
 *
 * Non c'è più un file di hint separato: le etichette con cui il motore cerca un campo
 * stanno tutte in `label_aliases_it`, e quelle che il revisore ha insegnato finiscono lì
 * accanto alle altre. Un'etichetta insegnata su un campo che l'ontologia non ha resta
 * fuori: il file esportato deve poter essere riletto.
 */
function correctedCatalog(catalog: FieldsFile, overlay: ProfileOverlay): FieldsFile {
  const taught = Object.entries(overlay.hintLabels).filter(([, labels]) => labels.length > 0)
  if (taught.length === 0) return catalog

  const next: Record<string, FieldOntologyEntry> = { ...catalog.fields }
  for (const [fieldId, labels] of taught) {
    const current = next[fieldId]
    if (!current) continue
    next[fieldId] = {
      ...current,
      label_aliases_it: applyHintOverlay(current.label_aliases_it, labels)
    }
  }
  return { ...catalog, fields: next }
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
  validators: string[],
  pii: FieldPii
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
    'x-praticaai-pii': pii,
    'x-praticaai-validators': validators
  }
}

/** I campi di un profilo nell'ordine obbligatori → opzionali. */
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
      profile.field_validator_overrides?.[fieldId] ?? field.validators,
      piiOf(profile, fieldId, field)
    )
  }

  return {
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `schema.document.${documentType}`,
      type: 'object',
      properties,
      required: profile.required_fields.filter((fieldId) => ontology[fieldId]),
      additionalProperties: false,
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
  const { manifest, overlay } = input
  const ontology = input.catalog.fields
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

  const documentTypes: Record<string, RawProfile> = { ...input.map.document_types }
  const changes: TypeChange[] = []
  let fields = 0

  for (const { documentType, overrides, cardinality } of touched) {
    // Un tipo che il registry non elenca non ha una mappa da correggere: le decisioni
    // restano nel database, e ci tornano se quel tipo rientra.
    const base = input.map.document_types[documentType] ?? null
    if (!base) continue

    documentTypes[documentType] = correctedProfile(base, overrides, cardinality)
    changes.push(changesFor(documentType, base, overrides, cardinality, ontology))
    fields += new Set([...Object.keys(overrides), ...Object.keys(cardinality)]).size
  }

  const correctedMap: DocumentFieldsFile = { ...input.map, document_types: documentTypes }
  const catalog = correctedCatalog(input.catalog, overlay)

  const schemas: Record<string, unknown> = {}
  const unknownByType: Record<string, string[]> = {}
  for (const [documentType, profile] of Object.entries(documentTypes)) {
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
    /** Campi citati da un tipo ma assenti dall'ontologia: fuori dagli schemi. */
    fieldsWithoutOntology: unknownByType
  }

  return {
    files: [
      { name: FIELDS_FILE, content: serializeRegistryJson(catalog) },
      { name: DOCUMENT_FIELDS_FILE, content: serializeRegistryJson(correctedMap) },
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
