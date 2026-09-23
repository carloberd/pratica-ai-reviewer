import {
  type ClassExtractionProfile,
  FIELD_PII,
  type FieldOntologyEntry
} from '@shared/extraction-v2'
import { DOCUMENT_FIELDS_FILE, FIELDS_FILE } from '@shared/profile-bundle'
import {
  applyCardinalityOverlay,
  applyHintOverlay,
  applyOverlay,
  EMPTY_OVERLAY,
  type ProfileOverlay
} from '@shared/profile-overlay'
import { z } from 'zod'
import { readRegistryJson } from '../../registry/read-json'
import { fold } from '../heuristics'
import { LEGACY_FIELD_MAP } from '../legacy-field-map'

export type ProfileSource = 'EXPLICIT' | 'MISSING'

export interface ExtractionRegistry {
  /** Il profilo che il motore deve usare: registry più le correzioni del revisore. */
  profile(documentType: string): ClassExtractionProfile | null
  /** Il profilo come sta nel registry, senza correzioni: serve all'export e ai numeri. */
  baseProfile(documentType: string): ClassExtractionProfile | null
  field(fieldId: string): FieldOntologyEntry | null
  /** Tutti i campi dell'ontologia, in ordine di etichetta: il menu che li elenca tutti. */
  allFields(): FieldOntologyEntry[]
  /** Le etichette con cui cercare un campo nel testo: la sua e i suoi alias. */
  hints(fieldId: string): string[]
  /**
   * Le intestazioni che aprono la sezione di una parte, ripiegate, per parte: su una
   * fattura elettronica «Cedente prestatore (fornitore)» apre quella dell'emittente.
   */
  sections(): Array<{ party: string; label: string }>
  profileSource(documentType: string): ProfileSource
  /** Nomi campo v1 che la tabella di migrazione porta su questo id dell'ontologia. */
  legacyNames(fieldId: string): string[]
  /** I tipi che il registry conosce, per il menu della revisione. */
  documentTypes(): Array<{ id: string; label: string; family: string }>
  /** Versione del registry: finisce in `extraction_runs.schema_version`. */
  schemaVersion(): string
}

const stringList = z.array(z.string())
const piiSchema = z.enum(FIELD_PII)

// Solo le chiavi che il motore legge: le altre restano nel file per chi lo cura, ma qui
// non devono far fallire l'avvio.
const documentTypeSchema = z.looseObject({
  document_type_id: z.string(),
  canonical_name: z.string(),
  family: z.string(),
  schema_state: z.string(),
  required_fields: stringList,
  optional_fields: stringList,
  derived_fields: stringList.optional(),
  field_validator_overrides: z.record(z.string(), stringList).optional(),
  field_pii_overrides: z.record(z.string(), piiSchema).optional(),
  field_description_overrides: z.record(z.string(), z.string()).optional()
})

const documentFieldsSchema = z.object({
  version: z.string(),
  document_types: z.record(z.string(), documentTypeSchema)
})

const fieldsSchema = z.object({
  version: z.string(),
  // Le intestazioni che aprono il blocco di una parte, per parte.
  sections: z.record(z.string(), stringList).optional(),
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
      label_aliases_it: stringList,
      columns: z
        .array(
          z.object({
            id: z.string(),
            label_it: z.string(),
            type: z.enum(['string', 'identifier', 'date', 'money', 'number', 'integer', 'boolean']),
            format: z.string().nullable().optional()
          })
        )
        .optional(),
      enum: stringList.optional(),
      scale: z.literal('0_100').optional(),
      derived: z.boolean().optional()
    })
  )
})

const ROLE_KEYS = ['required_fields', 'optional_fields'] as const

/**
 * Carica i due file del registry: i campi e, per ogni tipo, quali vuole.
 *
 * Un tipo che il registry non elenca non ha profilo e non ha campi da estrarre: dopo il
 * Brain MVP i tipi sono 171, quelli che valgono la pena di leggere, e per gli altri non
 * si inventa una mappa che nessuno ha guardato.
 *
 * Ogni riferimento incrociato — i campi di un tipo, le eccezioni ai validatori, al `pii`
 * e alle descrizioni — è controllato qui: un tipo che cita un campo inesistente è un
 * errore d'avvio, non un campo che manca in silenzio a ogni documento di quel tipo.
 */
export function createExtractionRegistry(
  registryDirectory: string,
  overlay: () => ProfileOverlay = () => EMPTY_OVERLAY
): ExtractionRegistry {
  const catalog = readRegistryJson(registryDirectory, FIELDS_FILE, fieldsSchema)
  const map = readRegistryJson(registryDirectory, DOCUMENT_FIELDS_FILE, documentFieldsSchema)

  // Le intestazioni di sezione, dalla più lunga: «Cedente prestatore (fornitore)» prima di
  // «Cedente prestatore», così una riga che le contiene tutte e due non conta due volte.
  const sectionLabels = Object.entries(catalog.sections ?? {})
    .flatMap(([party, labels]) => labels.map((label) => ({ party, label: fold(label) })))
    .filter((entry) => entry.label.length > 0)
    .sort((a, b) => b.label.length - a.label.length)

  const unknownRefs: string[] = []
  for (const [documentType, entry] of Object.entries(map.document_types)) {
    for (const key of ROLE_KEYS) {
      for (const fieldId of entry[key]) {
        if (!catalog.fields[fieldId]) unknownRefs.push(`${documentType}.${key}: ${fieldId}`)
      }
    }
    // I derivati non si leggono, ma esistono: un id sbagliato lì è sbagliato lo stesso.
    for (const fieldId of entry.derived_fields ?? []) {
      if (!catalog.fields[fieldId]) unknownRefs.push(`${documentType}.derived_fields: ${fieldId}`)
    }
    // Un'eccezione ai validatori, al `pii` o alla descrizione vale per un campo che il tipo
    // chiede: su un campo fuori mappa non cambierebbe niente, e dice che la mappa o
    // l'eccezione sono sbagliate.
    for (const overrides of [
      'field_validator_overrides',
      'field_pii_overrides',
      'field_description_overrides'
    ] as const) {
      for (const fieldId of Object.keys(entry[overrides] ?? {})) {
        if (!catalog.fields[fieldId] || !ROLE_KEYS.some((key) => entry[key].includes(fieldId))) {
          unknownRefs.push(`${documentType}.${overrides}: ${fieldId}`)
        }
      }
    }
  }
  for (const [legacy, fieldId] of Object.entries(LEGACY_FIELD_MAP)) {
    if (!catalog.fields[fieldId]) unknownRefs.push(`legacy-field-map: ${legacy} -> ${fieldId}`)
  }
  if (unknownRefs.length > 0) {
    throw new Error(
      `Registry: ${unknownRefs.length} riferimenti a campi assenti da ${FIELDS_FILE} ` +
        `o dal tipo che li cita, in ${registryDirectory} (primo: ${unknownRefs[0]}).`
    )
  }

  const legacyByField = new Map<string, string[]>()
  for (const [legacy, fieldId] of Object.entries(LEGACY_FIELD_MAP)) {
    legacyByField.set(fieldId, [...(legacyByField.get(fieldId) ?? []), legacy])
  }

  const sortedFields = Object.values(catalog.fields).sort((a, b) =>
    a.label_it.localeCompare(b.label_it, 'it')
  )

  const types = Object.values(map.document_types)
    .map((entry) => ({
      id: entry.document_type_id,
      label: entry.canonical_name,
      family: entry.family
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'it'))

  /** La mappa del tipo nella forma che il motore usa. */
  const profiles = new Map<string, ClassExtractionProfile>()
  for (const [documentType, entry] of Object.entries(map.document_types)) {
    profiles.set(documentType, {
      ...entry,
      document_type_id: entry.document_type_id,
      canonical_name: entry.canonical_name,
      family: entry.family,
      schema_state: entry.schema_state,
      required_fields: entry.required_fields,
      optional_fields: entry.optional_fields,
      derived_fields: entry.derived_fields,
      literal_evidence_required: true,
      unknown_value_policy: 'LEAVE_EMPTY',
      review_policy: 'REVIEW_LOW_CONFIDENCE_MISSING_REQUIRED_CONFLICTS_ONLY'
    })
  }

  function baseProfile(documentType: string): ClassExtractionProfile | null {
    return profiles.get(documentType) ?? null
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
    field: (fieldId) => catalog.fields[fieldId] ?? null,
    allFields: () => sortedFields,
    hints: (fieldId) => {
      const spec = catalog.fields[fieldId]
      const base = spec ? [spec.label_it, ...spec.label_aliases_it] : []
      return applyHintOverlay(base, overlay().hintLabels[fieldId])
    },
    sections: () => sectionLabels,
    profileSource: (documentType) => (profiles.has(documentType) ? 'EXPLICIT' : 'MISSING'),
    legacyNames: (fieldId) => legacyByField.get(fieldId) ?? [],
    documentTypes: () => types,
    schemaVersion: () => map.version
  }
}

export interface ReloadableExtractionRegistry extends ExtractionRegistry {
  /**
   * Rilegge i JSON del registry dal disco. Le correzioni del revisore non passano di qui
   * — stanno nel database e si applicano a ogni lettura — ma il registry sul disco può
   * cambiare sotto, e questo lo rilegge senza riavviare.
   *
   * Se i nuovi file non sono validi l'errore risale al chiamante e resta in uso il
   * registry di prima: un JSON scritto male non deve lasciare l'app senza mappa.
   */
  reload(): void
}

/**
 * Il registry dietro un riferimento sostituibile. La pipeline lo tiene per tutta la vita
 * del processo, quindi non può essere l'istanza: deve poter cambiare sotto.
 */
export function createReloadableExtractionRegistry(
  registryDirectory: string,
  overlay: () => ProfileOverlay = () => EMPTY_OVERLAY
): ReloadableExtractionRegistry {
  let current = createExtractionRegistry(registryDirectory, overlay)

  return {
    profile: (documentType) => current.profile(documentType),
    baseProfile: (documentType) => current.baseProfile(documentType),
    field: (fieldId) => current.field(fieldId),
    allFields: () => current.allFields(),
    hints: (fieldId) => current.hints(fieldId),
    sections: () => current.sections(),
    profileSource: (documentType) => current.profileSource(documentType),
    legacyNames: (fieldId) => current.legacyNames(fieldId),
    documentTypes: () => current.documentTypes(),
    schemaVersion: () => current.schemaVersion(),
    reload() {
      current = createExtractionRegistry(registryDirectory, overlay)
    }
  }
}
