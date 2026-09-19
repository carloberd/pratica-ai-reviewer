import {
  type ClassExtractionProfile,
  FIELD_PII,
  type FieldOntologyEntry
} from '@shared/extraction-v2'
import {
  applyCardinalityOverlay,
  applyHintOverlay,
  applyOverlay,
  EMPTY_OVERLAY,
  type ProfileOverlay
} from '@shared/profile-overlay'
import { z } from 'zod'
import { readRegistryJson } from '../../registry/v2/read-json'

export const LEGACY_FIELD_MAP_FILE = 'legacy_field_map_v2.json'

export type ProfileSource = 'V2_EXPLICIT' | 'LEGACY_FALLBACK' | 'MISSING'

export interface ExtractionRegistryV2 {
  /** Il profilo che il motore deve usare: registry più le correzioni del revisore. */
  profile(documentType: string): ClassExtractionProfile | null
  /** Il profilo come sta nel registry, senza correzioni: serve all'export e ai numeri. */
  baseProfile(documentType: string): ClassExtractionProfile | null
  field(fieldId: string): FieldOntologyEntry | null
  /** Tutti i campi dell'ontologia, in ordine di etichetta: il menu che li elenca tutti. */
  allFields(): FieldOntologyEntry[]
  hints(fieldId: string): string[]
  profileSource(documentType: string): ProfileSource
  /** Nomi campo v1 che la mappa legacy porta su questo id dell'ontologia. */
  legacyNames(fieldId: string): string[]
  /** Versione dei profili: finisce in `extraction_runs.schema_version`. */
  schemaVersion(): string
}

const stringList = z.array(z.string())
const piiSchema = z.enum(FIELD_PII)

// Solo le chiavi che il motore legge: le altre (provenienza, confusables, note)
// restano nel file per chi lo cura, ma qui non devono far fallire l'avvio.
const profileSchema = z.looseObject({
  document_type_id: z.string(),
  canonical_name: z.string(),
  family: z.string(),
  schema_state: z.string(),
  evidence_basis: z.string(),
  required_fields: stringList,
  core_fields: stringList,
  optional_fields: stringList,
  conditional_fields: stringList,
  field_validator_overrides: z.record(z.string(), stringList).optional(),
  field_pii_overrides: z.record(z.string(), piiSchema).optional(),
  field_description_overrides: z.record(z.string(), z.string()).optional(),
  literal_evidence_required: z.boolean(),
  unknown_value_policy: z.literal('LEAVE_EMPTY'),
  review_policy: z.string()
})

const profilesSchema = z.object({
  version: z.string(),
  profiles: z.record(z.string(), profileSchema)
})

const ontologySchema = z.object({
  version: z.string(),
  fields: z.record(
    z.string(),
    z.looseObject({
      id: z.string(),
      label_it: z.string(),
      type: z.enum([
        'string',
        'identifier',
        'date',
        'money',
        'number',
        'integer',
        'boolean',
        'object'
      ]),
      format: z.string().nullable().optional(),
      default_cardinality: z.enum(['one', 'many']),
      pii: piiSchema,
      evidence_required: z.boolean(),
      validators: stringList,
      description: z.string(),
      label_aliases_it: stringList
    })
  )
})

const hintsSchema = z.object({
  version: z.string(),
  hints: z.record(z.string(), z.looseObject({ labels: stringList }))
})

const legacyMapSchema = z.object({
  version: z.string(),
  map: z.record(z.string(), z.string())
})

const legacySchemasSchema = z.record(
  z.string(),
  z.looseObject({
    properties: z.record(z.string(), z.unknown()).optional(),
    required: stringList.optional()
  })
)

/** Mappa nomi campo v1 -> id dell'ontologia v2. Serve anche senza il motore v2. */
export function loadLegacyFieldMap(v2Directory: string): Record<string, string> {
  return readRegistryJson(v2Directory, LEGACY_FIELD_MAP_FILE, legacyMapSchema).map
}

const ROLE_KEYS = [
  'required_fields',
  'core_fields',
  'optional_fields',
  'conditional_fields'
] as const

/**
 * Carica i profili v2 espliciti e il registry v1 corrente.
 *
 * Il registry del reviewer ha 511 tipi, mentre i profili espliciti vengono dal
 * checkpoint Document Brain a 496 classi: un tipo senza profilo esplicito non deve
 * far saltare l'estrazione né sparire in silenzio. Se il tipo esiste in
 * `extraction_schemas.json`, si sintetizza un profilo conservativo LEGACY_FALLBACK con i
 * campi v1 portati sull'ontologia. Non vale quanto un profilo v2: è marcato come tale.
 *
 * Ogni riferimento incrociato (campi dei profili, eccezioni ai validatori, destinazioni
 * della mappa legacy) è controllato qui: un profilo che cita un campo inesistente è un
 * errore d'avvio, non un campo che manca in silenzio a ogni documento di quel tipo.
 */
export function createExtractionRegistryV2(
  v2Directory: string,
  legacyRegistryDirectory: string,
  overlay: () => ProfileOverlay = () => EMPTY_OVERLAY
): ExtractionRegistryV2 {
  const profiles = readRegistryJson(
    v2Directory,
    'class_extraction_profiles_v2.json',
    profilesSchema
  )
  const ontology = readRegistryJson(v2Directory, 'field_ontology_v2.json', ontologySchema)
  const hints = readRegistryJson(v2Directory, 'extraction_hints_v2.json', hintsSchema)
  const legacyMap = loadLegacyFieldMap(v2Directory)
  const legacySchemas = readRegistryJson(
    legacyRegistryDirectory,
    'extraction_schemas.json',
    legacySchemasSchema
  )

  const unknownRefs: string[] = []
  for (const [documentType, profile] of Object.entries(profiles.profiles)) {
    for (const key of ROLE_KEYS) {
      for (const fieldId of profile[key]) {
        if (!ontology.fields[fieldId]) unknownRefs.push(`${documentType}.${key}: ${fieldId}`)
      }
    }
    // Un'eccezione ai validatori, al `pii` o alla descrizione vale per un campo che il tipo
    // chiede: su un campo fuori profilo non cambierebbe niente, e dice che il profilo o
    // l'eccezione sono sbagliati.
    for (const overrides of [
      'field_validator_overrides',
      'field_pii_overrides',
      'field_description_overrides'
    ] as const) {
      for (const fieldId of Object.keys(profile[overrides] ?? {})) {
        if (!ontology.fields[fieldId] || !ROLE_KEYS.some((key) => profile[key].includes(fieldId))) {
          unknownRefs.push(`${documentType}.${overrides}: ${fieldId}`)
        }
      }
    }
  }
  for (const [legacy, fieldId] of Object.entries(legacyMap)) {
    if (!ontology.fields[fieldId])
      unknownRefs.push(`${LEGACY_FIELD_MAP_FILE}: ${legacy} -> ${fieldId}`)
  }
  if (unknownRefs.length > 0) {
    throw new Error(
      `Registry v2: ${unknownRefs.length} riferimenti a campi assenti da field_ontology_v2.json ` +
        `o dal profilo che li cita, in ${v2Directory} (primo: ${unknownRefs[0]}).`
    )
  }

  const legacyByField = new Map<string, string[]>()
  for (const [legacy, fieldId] of Object.entries(legacyMap)) {
    legacyByField.set(fieldId, [...(legacyByField.get(fieldId) ?? []), legacy])
  }

  const synthesized = new Map<string, ClassExtractionProfile>()

  function fallbackProfile(documentType: string): ClassExtractionProfile | null {
    const cached = synthesized.get(documentType)
    if (cached) return cached

    const schema = legacySchemas[documentType]
    if (!schema) return null

    const toFieldId = (legacy: string): string | null => legacyMap[legacy] ?? null
    const rawFields = Object.keys(schema.properties ?? {})
    const requiredLegacy = new Set(schema.required ?? [])

    const requiredFields = unique(
      rawFields.filter((legacy) => requiredLegacy.has(legacy)).map(toFieldId)
    )
    const coreFields = unique(rawFields.map(toFieldId)).filter(
      (fieldId) => !requiredFields.includes(fieldId)
    )

    const profile: ClassExtractionProfile = {
      document_type_id: documentType,
      canonical_name: documentType,
      family: documentType.split('.')[0] ?? '',
      schema_state: 'EXTRACTION_SCHEMA_LEGACY_FALLBACK',
      evidence_basis: 'CURRENT_REVIEWER_V1_1_0_REGISTRY',
      required_fields: requiredFields,
      core_fields: coreFields,
      optional_fields: [],
      conditional_fields: [],
      literal_evidence_required: true,
      unknown_value_policy: 'LEAVE_EMPTY',
      review_policy: 'REVIEW_LOW_CONFIDENCE_MISSING_REQUIRED_CONFLICTS_ONLY'
    }
    synthesized.set(documentType, profile)
    return profile
  }

  const sortedFields = Object.values(ontology.fields).sort((a, b) =>
    a.label_it.localeCompare(b.label_it, 'it')
  )

  function baseProfile(documentType: string): ClassExtractionProfile | null {
    return profiles.profiles[documentType] ?? fallbackProfile(documentType)
  }

  return {
    profile(documentType) {
      const base = baseProfile(documentType)
      // Le decisioni del revisore stanno nel database e si applicano qui: il motore
      // vede già la mappa corretta, senza che nessuno abbia riscritto un JSON.
      if (!base) return null
      const current = overlay()
      return applyCardinalityOverlay(
        applyOverlay(base, current.fields[documentType]),
        current.cardinality[documentType]
      )
    },
    baseProfile,
    field: (fieldId) => ontology.fields[fieldId] ?? null,
    allFields: () => sortedFields,
    hints: (fieldId) =>
      applyHintOverlay(hints.hints[fieldId]?.labels ?? [], overlay().hintLabels[fieldId]),
    profileSource(documentType) {
      if (profiles.profiles[documentType]) return 'V2_EXPLICIT'
      if (legacySchemas[documentType]) return 'LEGACY_FALLBACK'
      return 'MISSING'
    },
    legacyNames: (fieldId) => legacyByField.get(fieldId) ?? [],
    schemaVersion: () => profiles.version
  }
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))]
}

export interface ReloadableExtractionRegistryV2 extends ExtractionRegistryV2 {
  /**
   * Rilegge i JSON dei profili dal disco. Le correzioni del revisore non passano più di
   * qui — stanno nel database e si applicano a ogni lettura — ma il registry sul disco
   * può cambiare sotto (un pack aggiornato), e questo lo rilegge senza riavviare.
   *
   * Se i nuovi file non sono validi l'errore risale al chiamante e resta in uso il
   * registry di prima: un JSON scritto male non deve lasciare l'app senza profili.
   */
  reload(): void
}

/**
 * Il registry v2 dietro un riferimento sostituibile. La pipeline lo tiene per tutta la
 * vita del processo, quindi non può essere l'istanza: deve poter cambiare sotto.
 */
export function createReloadableExtractionRegistryV2(
  v2Directory: string,
  legacyRegistryDirectory: string,
  overlay: () => ProfileOverlay = () => EMPTY_OVERLAY
): ReloadableExtractionRegistryV2 {
  let current = createExtractionRegistryV2(v2Directory, legacyRegistryDirectory, overlay)

  return {
    profile: (documentType) => current.profile(documentType),
    baseProfile: (documentType) => current.baseProfile(documentType),
    field: (fieldId) => current.field(fieldId),
    allFields: () => current.allFields(),
    hints: (fieldId) => current.hints(fieldId),
    profileSource: (documentType) => current.profileSource(documentType),
    legacyNames: (fieldId) => current.legacyNames(fieldId),
    schemaVersion: () => current.schemaVersion(),
    reload() {
      current = createExtractionRegistryV2(v2Directory, legacyRegistryDirectory, overlay)
    }
  }
}
