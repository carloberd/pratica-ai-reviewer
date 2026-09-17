import type { FieldRole } from './extraction-v2'

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
 * Le quattro liste di campi: il profilo del motore le ha, e le ha anche il profilo
 * grezzo del file JSON con tutte le sue chiavi in più. L'overlay lavora su entrambi.
 */
export interface ProfileRoleLists {
  required_fields: string[]
  core_fields: string[]
  optional_fields: string[]
  conditional_fields: string[]
}

/** Lo stato deciso, campo per campo, per un tipo solo. */
export type TypeOverrides = Record<string, FieldState>

/** Tutte le decisioni, per tipo documento. */
export type OverridesByType = Record<string, TypeOverrides>

export interface ProfileOverlay {
  fields: OverridesByType
  /** Etichette insegnate al motore, per campo: si sommano a quelle del registry. */
  hintLabels: Record<string, string[]>
}

export const EMPTY_OVERLAY: ProfileOverlay = { fields: {}, hintLabels: {} }

export const ROLE_KEYS: Record<
  FieldRole,
  'required_fields' | 'core_fields' | 'optional_fields' | 'conditional_fields'
> = {
  required: 'required_fields',
  core: 'core_fields',
  optional: 'optional_fields',
  conditional: 'conditional_fields'
}

export const ROLES: FieldRole[] = ['required', 'core', 'optional', 'conditional']

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

  const added: Record<FieldRole, string[]> = {
    required: [],
    core: [],
    optional: [],
    conditional: []
  }
  for (const [fieldId, state] of Object.entries(overrides)) {
    if (state !== 'excluded') added[state].push(fieldId)
  }

  const lists: ProfileRoleLists = {
    required_fields: [],
    core_fields: [],
    optional_fields: [],
    conditional_fields: []
  }
  for (const role of ROLES) {
    const key = ROLE_KEYS[role]
    // Un campo con una decisione sopra esce da tutte le liste del registry: se il
    // revisore gli ha dato un ruolo rientra da `added`, se l'ha escluso resta fuori.
    const kept = profile[key].filter((fieldId) => !(fieldId in overrides))
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
