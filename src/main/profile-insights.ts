import type { FieldRole } from '@shared/extraction-v2'
import {
  isFieldTestedProfile,
  type MeasuredTypeInput,
  measureType,
  type ProfileFieldRef,
  type ProfileOrigin,
  type ProfileTypeMeasure
} from '@shared/profile-metrics'
import { cardinalityOf } from '@shared/profile-overlay'
import type { Repository } from './db/repository'
import type { ExtractionRegistryV2 } from './extract/v2/profile-loader'

/**
 * Le misure sui profili, lette dal database locale.
 *
 * Tutte le query sui documenti annotati stanno qui: la schermata riceve numeri già
 * fatti, e non c'è una sola query sparsa nella UI. Il conteggio vero e proprio è in
 * `@shared/profile-metrics`, che non conosce né SQLite né Electron.
 *
 * Votano solo i documenti `REVIEWED`: sono quelli con l'annotazione finita. I
 * `DISCARDED` restano fuori — il revisore li ha tolti dal dataset, e quello che il
 * motore aveva proposto su un documento buttato non dice niente sul profilo.
 */

const ROLE_KEYS: Array<
  [FieldRole, 'required_fields' | 'core_fields' | 'optional_fields' | 'conditional_fields']
> = [
  ['required', 'required_fields'],
  ['core', 'core_fields'],
  ['optional', 'optional_fields'],
  ['conditional', 'conditional_fields']
]

export interface ProfileInsightsDeps {
  repo: Repository
  registry: ExtractionRegistryV2
  /** Nome leggibile del tipo (`canonical_name` del registry v1). */
  typeLabel?: (documentType: string) => string | null
}

/** I campi del profilo di un tipo, nell'ordine obbligatori → principali → opzionali. */
export function profileFieldsOf(
  registry: ExtractionRegistryV2,
  documentType: string
): ProfileFieldRef[] {
  const profile = registry.profile(documentType)
  if (!profile) return []

  const fields: ProfileFieldRef[] = []
  const seen = new Set<string>()
  for (const [role, key] of ROLE_KEYS) {
    for (const fieldId of profile[key]) {
      // Un campo elencato due volte nello stesso profilo conta una volta sola, col
      // ruolo più forte: è il ruolo che il motore applica.
      if (seen.has(fieldId)) continue
      seen.add(fieldId)
      fields.push({ fieldId, label: registry.field(fieldId)?.label_it ?? fieldId, role })
    }
  }
  return fields
}

function originOf(registry: ExtractionRegistryV2, documentType: string): ProfileOrigin {
  return registry.profileSource(documentType)
}

/** Gli ingressi puri per un tipo: il profilo attuale e i documenti annotati che votano. */
function inputFor(deps: ProfileInsightsDeps, documentType: string): MeasuredTypeInput {
  const { repo, registry } = deps
  // Il profilo che il motore usa davvero: registry più le decisioni del revisore.
  const profile = registry.profile(documentType)

  const documents = repo.documents
    .list({ status: 'REVIEWED', documentType })
    .map((row) => repo.getReviewDocument(row.id))
    .filter((document) => document !== undefined)
    .map((document) => ({
      documentId: document.id,
      driveFileId: document.driveFileId,
      filename: document.filename,
      reviewedAt: document.reviewedAt,
      fields: document.fields
    }))

  return {
    documentType,
    label: deps.typeLabel?.(documentType) ?? profile?.canonical_name ?? null,
    profileOrigin: originOf(registry, documentType),
    schemaState: profile?.schema_state ?? null,
    fieldTested: isFieldTestedProfile(profile),
    profileFields: profileFieldsOf(registry, documentType),
    decisions: repo.profileMap.forType(documentType),
    fieldLabel: (fieldId) => registry.field(fieldId)?.label_it ?? null,
    fieldCardinality: (fieldId) =>
      cardinalityOf(profile, fieldId, registry.field(fieldId)?.default_cardinality ?? 'one'),
    cardinalityDecisions: repo.profileMap.cardinalityForType(documentType),
    documents
  }
}

/** Le misure di un tipo solo. `null` se di quel tipo non c'è nessun documento annotato. */
export function collectTypeMeasure(
  deps: ProfileInsightsDeps,
  documentType: string
): ProfileTypeMeasure | null {
  const input = inputFor(deps, documentType)
  if (input.documents.length === 0) return null
  return measureType(input)
}

/**
 * La mappa di un tipo con i suoi numeri, anche quando di quel tipo non c'è ancora nessun
 * documento revisionato: il revisore la corregge dal primo documento che apre, e lì i
 * numeri sono zero ma i campi che il motore cerca vanno mostrati lo stesso.
 */
export function collectTypeMap(
  deps: ProfileInsightsDeps,
  documentType: string
): ProfileTypeMeasure {
  return measureType(inputFor(deps, documentType))
}
