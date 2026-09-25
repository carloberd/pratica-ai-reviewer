import type { Cardinality, FieldRole } from './extraction-v2'

/**
 * Le correzioni del revisore applicate sopra il profilo che arriva dal registry.
 *
 * I JSON del registry non si toccano mai: sono la base, e restano quelli del programmer
 * pack. Quello che il revisore decide vive nel database e si applica qui, al volo, ogni
 * volta che il motore chiede il profilo di un tipo. Così una correzione vale subito —
 * sul prossimo documento e sulla prossima rielaborazione — senza riscrivere niente sul
 * disco, e l'export (`@shared/profile-bundle`) usa esattamente questa stessa funzione
 * per produrre i file corretti.
 *
 * Modulo puro: nessun database, nessun Electron, nessun file. Destinazione pratica-ai.
 */

/** Cosa il revisore ha deciso di un campo per un tipo. */
export type FieldState = FieldRole | 'excluded'

/**
 * Gli stati che il database può contenere ma il codice non conosce più.
 *
 * Fino al Brain MVP i ruoli erano quattro: `required`, `core`, `optional`, `conditional`.
 * Le decisioni scritte allora sono ancora nel database, e vanno lette adesso che i ruoli
 * sono due. `core` e `conditional` diventano `optional` perché è quello che **facevano**:
 * solo `required` mandava un documento in revisione per un campo senza valore, gli altri
 * tre no. Un campo che non bloccava prima non deve cominciare a bloccare adesso.
 */
const LEGACY_STATES: Record<string, FieldState> = { core: 'optional', conditional: 'optional' }

/**
 * Lo stato come lo intende il codice di oggi, o `null` se quella riga non si sa leggere.
 *
 * Passa di qui tutto quello che arriva dal database: uno stato che nessuna versione ha
 * mai scritto non deve far cadere né il motore né un export, e nemmeno diventare di
 * nascosto un ruolo che il revisore non ha scelto. Vale «non c'è decisione»: il campo
 * segue il registry, come prima che qualcuno lo toccasse.
 */
export function fieldStateOrNull(state: string | null | undefined): FieldState | null {
  if (state === 'required' || state === 'optional' || state === 'excluded') return state
  return state ? (LEGACY_STATES[state] ?? null) : null
}

/**
 * Le due liste di campi: il profilo del motore le ha, e le ha anche il profilo grezzo del
 * file JSON con tutte le sue chiavi in più. L'overlay lavora su entrambi.
 */
export interface ProfileRoleLists {
  required_fields: string[]
  optional_fields: string[]
}

/** Lo stato deciso, campo per campo, per un tipo solo. */
export type TypeOverrides = Record<string, FieldState>

/** Tutte le decisioni, per tipo documento. */
export type OverridesByType = Record<string, TypeOverrides>

/**
 * Quanti valori chiede un campo su un tipo, dove il revisore l'ha deciso diversamente
 * dall'ontologia. È un'altra decisione rispetto al peso: si prende e si annulla da sola.
 */
export type TypeCardinality = Record<string, Cardinality>

/** Le cardinalità decise, per tipo documento. */
export type CardinalityByType = Record<string, TypeCardinality>

/** Quello che un'azione sulla mappa scrive prima e dopo: un peso, «non utile», o una cardinalità. */
export type MapValue = FieldState | Cardinality

export interface ProfileOverlay {
  fields: OverridesByType
  /** Etichette insegnate al motore, per campo: si sommano a quelle del registry. */
  hintLabels: Record<string, string[]>
  cardinality: CardinalityByType
}

export const EMPTY_OVERLAY: ProfileOverlay = { fields: {}, hintLabels: {}, cardinality: {} }

/** «un solo valore» / «più valori»: come lo legge il revisore. */
export const CARDINALITY_LABELS: Record<Cardinality, string> = {
  one: 'un solo valore',
  many: 'più valori'
}

export const ROLE_KEYS: Record<FieldRole, 'required_fields' | 'optional_fields'> = {
  required: 'required_fields',
  optional: 'optional_fields'
}

export const ROLES: FieldRole[] = ['required', 'optional']

/** Il ruolo di un campo in un profilo, `null` se il profilo non lo chiede. */
export function roleIn<T extends ProfileRoleLists>(
  profile: T | null,
  fieldId: string
): FieldRole | null {
  if (!profile) return null
  return ROLES.find((role) => profile[ROLE_KEYS[role]].includes(fieldId)) ?? null
}

/** I campi che il revisore ha marcato come non utili per questo tipo. */
export function excludedFields(overrides: TypeOverrides | undefined): string[] {
  if (!overrides) return []
  return Object.entries(overrides)
    .filter(([, state]) => state === 'excluded')
    .map(([fieldId]) => fieldId)
    .sort()
}

/**
 * Il profilo come il motore lo deve vedere: quello del registry, meno i campi esclusi,
 * con i ruoli che il revisore ha cambiato e più i campi che ha aggiunto.
 *
 * I campi aggiunti vanno in coda alla lista del loro ruolo, in ordine di id: l'ordine
 * dentro una lista non conta per il motore, e in ordine il file esportato non cambia da
 * un export all'altro.
 */
export function applyOverlay<T extends ProfileRoleLists>(
  profile: T,
  overrides: TypeOverrides | undefined
): T {
  if (!overrides || Object.keys(overrides).length === 0) return profile

  // Prima si legge cosa il revisore ha deciso davvero: una decisione scritta quando i
  // ruoli erano quattro si traduce, una che nessuna versione ha mai scritto esce di mezzo
  // e il campo torna a seguire il registry. Toglierlo dalle liste senza rimetterlo da
  // nessuna parte lo farebbe sparire come se fosse stato escluso, che è una decisione
  // che nessuno ha preso.
  const decided = new Map<string, FieldState>()
  for (const [fieldId, state] of Object.entries(overrides)) {
    const value = fieldStateOrNull(state)
    if (value) decided.set(fieldId, value)
  }
  if (decided.size === 0) return profile

  const added: Record<FieldRole, string[]> = { required: [], optional: [] }
  for (const [fieldId, state] of decided) {
    if (state !== 'excluded') added[state].push(fieldId)
  }

  const lists: ProfileRoleLists = { required_fields: [], optional_fields: [] }
  for (const role of ROLES) {
    const key = ROLE_KEYS[role]
    // Un campo con una decisione sopra esce da tutte le liste del registry: se il
    // revisore gli ha dato un ruolo rientra da `added`, se l'ha escluso resta fuori.
    const kept = profile[key].filter((fieldId) => !decided.has(fieldId))
    const fresh = added[role].filter((fieldId) => !kept.includes(fieldId)).sort()
    lists[key] = [...kept, ...fresh]
  }

  return { ...profile, ...lists }
}

/** Le etichette del registry più quelle insegnate, senza ripetizioni. */
export function applyHintOverlay(base: string[], taught: string[] | undefined): string[] {
  if (!taught || taught.length === 0) return base
  const seen = new Set(base.map((label) => label.toLowerCase()))
  const extra = taught.filter((label) => !seen.has(label.toLowerCase()))
  return extra.length === 0 ? base : [...base, ...extra]
}

/**
 * La cardinalità decisa dal revisore scritta sul profilo, in `field_cardinality`. Il motore
 * la legge da lì prima di guardare l'ontologia, e l'export la porta nel file così com'è.
 */
export function applyCardinalityOverlay<T extends { field_cardinality?: TypeCardinality }>(
  profile: T,
  cardinality: TypeCardinality | undefined
): T {
  if (!cardinality || Object.keys(cardinality).length === 0) return profile
  const merged = { ...(profile.field_cardinality ?? {}), ...cardinality }
  const sorted = Object.fromEntries(
    Object.keys(merged)
      .sort()
      .map((fieldId) => [fieldId, merged[fieldId] as Cardinality])
  )
  return { ...profile, field_cardinality: sorted }
}

/** Quanti valori chiede un campo su un profilo: la decisione per il tipo, o l'ontologia. */
export function cardinalityOf(
  profile: { field_cardinality?: TypeCardinality } | null,
  fieldId: string,
  ontologyDefault: Cardinality
): Cardinality {
  return profile?.field_cardinality?.[fieldId] ?? ontologyDefault
}
