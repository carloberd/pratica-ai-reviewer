import type { FieldRole } from './extraction-v2'
import { FIELD_ROLE_LABELS, REVIEWER_EDITED_SCHEMA_STATE } from './profile-metrics'

/**
 * La correzione di un'istruzione di estrazione, applicata ai JSON sorgente.
 *
 * Qui non si scrive su disco e non si chiama git: si prendono i due file già letti, si
 * restituiscono i nuovi oggetti e il messaggio di commit che li spiega. Il modulo è puro
 * apposta — la stessa correzione dovrà girare dentro pratica-ai, dove non c'è né Electron
 * né questa UI — e perché un errore nella forma del JSON deve emergere in un test, non
 * sul registry di qualcuno.
 *
 * Nessuna correzione perde profili: si riscrive solo la voce toccata, e tutte le chiavi
 * che questo codice non conosce (provenienza, confusables, note) restano dov'erano.
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

/** Provenienza scritta sui campi che arrivano dalle annotazioni, non dall'AI. */
export const REVIEWER_PROVENANCE = 'REVIEWER_ANNOTATIONS'

type RoleKey = 'required_fields' | 'core_fields' | 'optional_fields' | 'conditional_fields'

const ROLE_KEYS: Record<FieldRole, RoleKey> = {
  required: 'required_fields',
  core: 'core_fields',
  optional: 'optional_fields',
  conditional: 'conditional_fields'
}

const ROLES = Object.keys(ROLE_KEYS) as FieldRole[]

export type ProfileEdit =
  /** Il campo non appartiene al tipo: via dal profilo. */
  | { kind: 'REMOVE_FIELD'; documentType: string; fieldId: string }
  /** Il revisore lo aggiunge sempre a mano: mettilo nel profilo. */
  | { kind: 'ADD_FIELD'; documentType: string; fieldId: string; role: FieldRole }
  /** Il campo c'è ma con il peso sbagliato. */
  | { kind: 'SET_ROLE'; documentType: string; fieldId: string; role: FieldRole }
  /**
   * Il campo è nel profilo ma il motore non lo trova mai: manca l'etichetta con cui
   * compare nei documenti veri. Tocca `extraction_hints_v2.json`, non il profilo.
   */
  | { kind: 'ADD_HINT_LABEL'; documentType: string; fieldId: string; label: string }

/** I numeri che hanno motivato la correzione: finiscono nel messaggio del commit. */
export interface ProfileEditReason {
  documents: number
  confirmed: number
  corrected: number
  manual: number
}

/** Quello che serve sapere del campo: l'ontologia lo conosce, questo modulo no. */
export interface FieldSpecRef {
  label: string
  aliases: string[]
}

export interface ProfileEditInput {
  profiles: ProfilesFile
  hints: HintsFile
  edit: ProfileEdit
  reason: ProfileEditReason
  /** `null` se il campo non esiste nell'ontologia: aggiungerlo romperebbe l'avvio. */
  field: FieldSpecRef | null
  /**
   * Profilo sintetizzato per un tipo senza profilo esplicito (LEGACY_FALLBACK). Se c'è,
   * la prima correzione lo materializza nel file invece di rifiutare la modifica.
   */
  fallbackProfile?: RawProfile | null
}

export interface ProfileEditResult {
  profiles: ProfilesFile
  hints: HintsFile
  changedProfiles: boolean
  changedHints: boolean
  commit: { subject: string; body: string }
}

/** Una correzione impossibile si ferma qui, con una frase che dice cosa non torna. */
export class ProfileEditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileEditError'
  }
}

function roleOf(profile: RawProfile, fieldId: string): FieldRole | null {
  return ROLES.find((role) => profile[ROLE_KEYS[role]].includes(fieldId)) ?? null
}

/** Ruolo di un campo nel profilo di un tipo, `null` se il profilo non lo prevede. */
export function fieldRoleIn(profile: RawProfile | null, fieldId: string): FieldRole | null {
  return profile ? roleOf(profile, fieldId) : null
}

/** Copia profonda delle sole liste: il resto del profilo resta l'oggetto di partenza. */
function withoutField(profile: RawProfile, fieldId: string): RawProfile {
  const next: RawProfile = { ...profile }
  for (const role of ROLES) {
    next[ROLE_KEYS[role]] = profile[ROLE_KEYS[role]].filter((id) => id !== fieldId)
  }
  return next
}

function withField(profile: RawProfile, fieldId: string, role: FieldRole): RawProfile {
  const next = withoutField(profile, fieldId)
  // In coda: l'ordine dentro una lista non conta per il motore, e mettere in fondo
  // tiene il diff a una riga.
  next[ROLE_KEYS[role]] = [...next[ROLE_KEYS[role]], fieldId]
  next.field_provenance = { ...(profile.field_provenance ?? {}), [fieldId]: REVIEWER_PROVENANCE }
  return next
}

function replaceProfile(
  file: ProfilesFile,
  documentType: string,
  profile: RawProfile
): ProfilesFile {
  return { ...file, profiles: { ...file.profiles, [documentType]: profile } }
}

/**
 * Un profilo nato da un LEGACY_FALLBACK e corretto qui non è uno schema verificato: lo
 * `schema_state` lo dice, e la schermata continua a marcarlo.
 */
function materialize(fallback: RawProfile): RawProfile {
  return {
    ...fallback,
    schema_state: REVIEWER_EDITED_SCHEMA_STATE,
    evidence_basis: 'REVIEWER_ANNOTATIONS+LEGACY_REGISTRY'
  }
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`
}

function documentsPhrase(count: number): string {
  return plural(count, 'documento', 'documenti')
}

/** «confermato 3, corretto 1, a mano 8 su 12 documenti annotati». */
function numbersLine(reason: ProfileEditReason): string {
  return (
    `Numeri su ${documentsPhrase(reason.documents)} annotati: ` +
    `${reason.confirmed} confermati, ${reason.corrected} corretti, ${reason.manual} a mano.`
  )
}

/** Quante volte il campo ha avuto un valore, su quel tipo. */
function usedCount(reason: ProfileEditReason): number {
  return reason.confirmed + reason.corrected + reason.manual
}

/** Quante volte il revisore ce l'ha messo lui: è la ragione per aggiungerlo al profilo. */
function requestedCount(reason: ProfileEditReason): number {
  return reason.corrected + reason.manual
}

const BODY_FOOTER =
  'Correzione fatta dalla schermata «Istruzioni per tipo» di praticaai-reviewer, ' +
  'guidata dalle annotazioni del revisore.'

export function applyProfileEdit(input: ProfileEditInput): ProfileEditResult {
  const { edit, reason } = input
  const existing = input.profiles.profiles[edit.documentType] ?? null
  const base = existing ?? (input.fallbackProfile ? materialize(input.fallbackProfile) : null)

  if (!base) {
    throw new ProfileEditError(
      `Il tipo «${edit.documentType}» non ha un profilo da correggere, né uno schema v1 da cui ricavarlo.`
    )
  }

  if (edit.kind === 'ADD_HINT_LABEL') {
    return addHintLabel(input, edit, base)
  }

  const current = roleOf(base, edit.fieldId)

  if (edit.kind === 'REMOVE_FIELD') {
    if (current === null) {
      throw new ProfileEditError(
        `Il profilo di «${edit.documentType}» non chiede «${edit.fieldId}»: non c'è niente da togliere.`
      )
    }
    const profile = withoutField(base, edit.fieldId)
    if (profile.field_provenance) {
      const { [edit.fieldId]: _removed, ...rest } = profile.field_provenance
      profile.field_provenance = rest
    }
    return {
      profiles: replaceProfile(input.profiles, edit.documentType, profile),
      hints: input.hints,
      changedProfiles: true,
      changedHints: false,
      commit: {
        // Il messaggio non deve dire «mai usato» se i numeri dicono il contrario: chi
        // legge la storia del registry deve potersi fidare del motivo scritto lì.
        subject:
          usedCount(reason) === 0
            ? `profile(${edit.documentType}): rimuove ${edit.fieldId}, mai usato su ${documentsPhrase(reason.documents)}`
            : `profile(${edit.documentType}): rimuove ${edit.fieldId}, usato su ${usedCount(reason)} di ${documentsPhrase(reason.documents)}`,
        body: [
          usedCount(reason) === 0
            ? `Il campo era ${FIELD_ROLE_LABELS[current]} nel profilo, ma su nessuno dei documenti annotati di questo tipo ha avuto un valore: non appartiene al tipo.`
            : `Il campo era ${FIELD_ROLE_LABELS[current]} nel profilo e viene tolto lo stesso: la decisione è del revisore, non dei numeri.`,
          '',
          numbersLine(reason),
          BODY_FOOTER
        ].join('\n')
      }
    }
  }

  if (edit.kind === 'ADD_FIELD') {
    if (current !== null) {
      throw new ProfileEditError(
        `Il profilo di «${edit.documentType}» prevede già «${edit.fieldId}» come ${FIELD_ROLE_LABELS[current]}.`
      )
    }
    if (!input.field) {
      throw new ProfileEditError(
        `«${edit.fieldId}» non è un campo dell'ontologia: un profilo che lo cita impedirebbe l'avvio.`
      )
    }
    const result = withHint(input, edit.fieldId, input.field)
    return {
      profiles: replaceProfile(
        input.profiles,
        edit.documentType,
        withField(base, edit.fieldId, edit.role)
      ),
      hints: result.hints,
      changedProfiles: true,
      changedHints: result.changed,
      commit: {
        subject:
          requestedCount(reason) === 0
            ? `profile(${edit.documentType}): aggiunge ${edit.fieldId} come ${FIELD_ROLE_LABELS[edit.role]}`
            : `profile(${edit.documentType}): aggiunge ${edit.fieldId} come ${FIELD_ROLE_LABELS[edit.role]}, richiesto su ${documentsPhrase(requestedCount(reason))}`,
        body: [
          requestedCount(reason) === 0
            ? 'Il profilo non prevedeva il campo: da ora il motore lo cerca.'
            : 'Il profilo non prevedeva il campo, ma il revisore lo mette lui sui documenti di questo tipo: ora lo cerca il motore.',
          '',
          numbersLine(reason),
          BODY_FOOTER
        ].join('\n')
      }
    }
  }

  if (current === null) {
    throw new ProfileEditError(
      `Il profilo di «${edit.documentType}» non chiede «${edit.fieldId}»: prima va aggiunto.`
    )
  }
  if (current === edit.role) {
    throw new ProfileEditError(
      `«${edit.fieldId}» è già ${FIELD_ROLE_LABELS[edit.role]} nel profilo di «${edit.documentType}».`
    )
  }

  return {
    profiles: replaceProfile(
      input.profiles,
      edit.documentType,
      withField(base, edit.fieldId, edit.role)
    ),
    hints: input.hints,
    changedProfiles: true,
    changedHints: false,
    commit: {
      subject: `profile(${edit.documentType}): ${edit.fieldId} da ${FIELD_ROLE_LABELS[current]} a ${FIELD_ROLE_LABELS[edit.role]}`,
      body: [numbersLine(reason), BODY_FOOTER].join('\n')
    }
  }
}

/** L'etichetta nuova in coda alle altre: quelle che c'erano continuano a funzionare. */
function withHint(
  input: ProfileEditInput,
  fieldId: string,
  field: FieldSpecRef
): { hints: HintsFile; changed: boolean } {
  if (input.hints.hints[fieldId]) return { hints: input.hints, changed: false }
  const seeded: RawHint = {
    labels: [...new Set([field.label, ...field.aliases].filter((label) => label.trim() !== ''))],
    regexes: [],
    scope: 'whole_document',
    candidate_limit: 10
  }
  return {
    hints: { ...input.hints, hints: { ...input.hints.hints, [fieldId]: seeded } },
    changed: true
  }
}

function addHintLabel(
  input: ProfileEditInput,
  edit: Extract<ProfileEdit, { kind: 'ADD_HINT_LABEL' }>,
  base: RawProfile
): ProfileEditResult {
  const label = edit.label.trim()
  if (label === '') {
    throw new ProfileEditError('L’etichetta da cercare nel documento non può essere vuota.')
  }
  if (roleOf(base, edit.fieldId) === null) {
    throw new ProfileEditError(
      `Il profilo di «${edit.documentType}» non chiede «${edit.fieldId}»: un'etichetta in più non servirebbe a niente.`
    )
  }

  const current = input.hints.hints[edit.fieldId]
  const labels = current?.labels ?? []
  if (labels.some((existing) => existing.toLowerCase() === label.toLowerCase())) {
    throw new ProfileEditError(`«${label}» è già fra le etichette di ${edit.fieldId}.`)
  }

  const entry: RawHint = current
    ? { ...current, labels: [...labels, label] }
    : { labels: [label], regexes: [], scope: 'whole_document', candidate_limit: 10 }

  return {
    profiles: input.profiles,
    hints: { ...input.hints, hints: { ...input.hints.hints, [edit.fieldId]: entry } },
    changedProfiles: false,
    changedHints: true,
    commit: {
      subject: `hints(${edit.fieldId}): aggiunge l'etichetta «${label}»`,
      body: [
        `Su «${edit.documentType}» il campo è nel profilo ma il motore non lo trova:`,
        'il revisore lo riempie a mano. Questa è l’etichetta con cui compare nei documenti.',
        '',
        numbersLine(input.reason),
        BODY_FOOTER
      ].join('\n')
    }
  }
}
