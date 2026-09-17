import type { ClassExtractionProfile, FieldRole } from './extraction-v2'
import { FIELD_ROLE_LABELS } from './profile-metrics'
import { type FieldState, roleIn, type TypeOverrides } from './profile-overlay'

/**
 * Una correzione alla mappa «tipo documento ↔ dati da estrarre».
 *
 * Qui non si scrive niente: si prende lo stato attuale della mappa (il profilo del
 * registry con sopra le decisioni già prese) e si restituisce cosa cambierebbe, più la
 * frase che finirà in cronologia. Chi chiama decide se scriverla — il database in
 * `src/main/profile-map.ts`, i test in memoria.
 *
 * Il modulo è puro apposta: la stessa correzione dovrà girare dentro pratica-ai, dove
 * non c'è né Electron né questa UI, e un errore nelle regole deve emergere in un test.
 */

export type ProfileEdit =
  /** Il campo non è utile per questo tipo: resta scritto che è stato scartato. */
  | { kind: 'REMOVE_FIELD'; documentType: string; fieldId: string }
  /** Il campo serve e il registry non lo prevede: entra nella mappa col peso scelto. */
  | { kind: 'ADD_FIELD'; documentType: string; fieldId: string; role: FieldRole }
  /** Il campo c'è ma con il peso sbagliato. */
  | { kind: 'SET_ROLE'; documentType: string; fieldId: string; role: FieldRole }
  /** Via la decisione del revisore: il campo torna a fare quello che dice il registry. */
  | { kind: 'RESTORE_FIELD'; documentType: string; fieldId: string }
  /**
   * Il campo è nella mappa ma il motore non lo trova mai: manca l'etichetta con cui
   * compare nei documenti veri. Non cambia la mappa, cambia come si cerca.
   */
  | { kind: 'ADD_HINT_LABEL'; documentType: string; fieldId: string; label: string }

export type ProfileEditKind = ProfileEdit['kind']

/** I numeri che hanno motivato la correzione: finiscono in cronologia con lei. */
export interface ProfileEditReason {
  documents: number
  confirmed: number
  corrected: number
  manual: number
}

/** Quello che serve sapere del campo: l'ontologia lo conosce, questo modulo no. */
export interface FieldSpecRef {
  id: string
  label: string
  aliases: string[]
}

export interface ProfileEditInput {
  edit: ProfileEdit
  /** Il profilo del registry per quel tipo, senza le decisioni del revisore. */
  profile: ClassExtractionProfile | null
  /** Le decisioni già prese su quel tipo. */
  overrides: TypeOverrides
  /** Le etichette con cui il motore cerca il campo adesso, registry incluso. */
  hintLabels: string[]
  /** `null` se il campo non esiste nell'ontologia: nessun motore saprebbe cercarlo. */
  field: FieldSpecRef | null
  reason: ProfileEditReason
}

/** Cosa cambia, detto in modo che chi scrive sul database non debba ragionarci. */
export interface ProfileEditPlan {
  edit: ProfileEdit
  documentType: string
  fieldId: string
  /** Lo stato del campo prima della correzione: ruolo, «non utile», o `null`. */
  before: FieldState | null
  /** Lo stato dopo. `null` significa «torna a quello che dice il registry». */
  after: FieldState | null
  /** La riga da scrivere su `profile_overrides`, o `null` per cancellarla. */
  override: FieldState | null
  /** Il valore che c'era su `profile_overrides`: serve ad annullare l'azione. */
  previousOverride: FieldState | null
  /** L'etichetta insegnata, solo per ADD_HINT_LABEL. */
  label: string | null
  /** La frase che il revisore legge in cronologia. */
  detail: string
  reason: ProfileEditReason
}

/** Una correzione impossibile si ferma qui, con una frase che dice cosa non torna. */
export class ProfileEditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileEditError'
  }
}

/** Lo stato attuale di un campo: la decisione del revisore, se c'è, o il registry. */
export function stateOf(
  profile: ClassExtractionProfile | null,
  overrides: TypeOverrides,
  fieldId: string
): FieldState | null {
  return overrides[fieldId] ?? roleIn(profile, fieldId)
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`
}

function documentsPhrase(count: number): string {
  return plural(count, 'documento annotato', 'documenti annotati')
}

/** Quante volte il campo ha avuto un valore su quel tipo. */
function usedCount(reason: ProfileEditReason): number {
  return reason.confirmed + reason.corrected + reason.manual
}

/** Quante volte ce l'ha messo il revisore: è la ragione per aggiungerlo alla mappa. */
function requestedCount(reason: ProfileEditReason): number {
  return reason.corrected + reason.manual
}

function nameOf(field: FieldSpecRef | null, fieldId: string): string {
  return field ? `«${field.label}» (${fieldId})` : `«${fieldId}»`
}

function stateLabel(state: FieldState): string {
  return state === 'excluded' ? 'non utile' : FIELD_ROLE_LABELS[state]
}

/**
 * Cosa cambierebbe questa correzione, e perché.
 *
 * Le regole sono poche e tutte qui: non si esclude un campo che la mappa non chiede,
 * non si aggiunge un campo che c'è già, non si insegna un'etichetta a un campo che
 * nessuno cerca, e non si cita un campo che l'ontologia non conosce — un motore che
 * riceve un id inventato non può cercarlo, e il file esportato non sarebbe caricabile.
 */
export function planProfileEdit(input: ProfileEditInput): ProfileEditPlan {
  const { edit, overrides, profile, reason } = input
  const { documentType, fieldId } = edit
  const before = stateOf(profile, overrides, fieldId)
  const previousOverride = overrides[fieldId] ?? null
  const base = {
    edit,
    documentType,
    fieldId,
    before,
    previousOverride,
    label: null,
    reason
  }

  if (edit.kind === 'ADD_HINT_LABEL') {
    const label = edit.label.trim()
    if (label === '') {
      throw new ProfileEditError('L’etichetta da cercare nel documento non può essere vuota.')
    }
    if (before === null || before === 'excluded') {
      throw new ProfileEditError(
        `La mappa di «${documentType}» non chiede ${nameOf(input.field, fieldId)}: un'etichetta in più non servirebbe a niente.`
      )
    }
    if (input.hintLabels.some((existing) => existing.toLowerCase() === label.toLowerCase())) {
      throw new ProfileEditError(`«${label}» è già fra le etichette di ${fieldId}.`)
    }
    return {
      ...base,
      after: before,
      override: previousOverride,
      label,
      detail: `Insegnata l'etichetta «${label}» per ${nameOf(input.field, fieldId)} su ${documentType}: il campo era nella mappa ma il motore non lo trovava.`
    }
  }

  if (edit.kind === 'RESTORE_FIELD') {
    if (previousOverride === null) {
      throw new ProfileEditError(
        `Su ${nameOf(input.field, fieldId)} non c'è nessuna decisione da togliere: «${documentType}» segue già il registry.`
      )
    }
    const registryRole = roleIn(profile, fieldId)
    return {
      ...base,
      after: registryRole,
      override: null,
      detail:
        registryRole === null
          ? `${nameOf(input.field, fieldId)} torna fuori dalla mappa di ${documentType}: era ${stateLabel(previousOverride)} per decisione del revisore, il registry non lo prevede.`
          : `${nameOf(input.field, fieldId)} torna a ${FIELD_ROLE_LABELS[registryRole]} su ${documentType}, come dice il registry.`
    }
  }

  if (!input.field) {
    throw new ProfileEditError(
      `«${fieldId}» non è un campo dell'ontologia: nessun motore saprebbe cercarlo.`
    )
  }

  if (edit.kind === 'REMOVE_FIELD') {
    if (before === 'excluded') {
      throw new ProfileEditError(
        `${nameOf(input.field, fieldId)} è già segnato non utile per «${documentType}».`
      )
    }
    if (before === null) {
      throw new ProfileEditError(
        `La mappa di «${documentType}» non chiede ${nameOf(input.field, fieldId)}: non c'è niente da segnare.`
      )
    }
    return {
      ...base,
      after: 'excluded',
      override: 'excluded',
      detail:
        usedCount(reason) === 0
          ? `${nameOf(input.field, fieldId)} segnato non utile per ${documentType}: era ${FIELD_ROLE_LABELS[before]} e su ${documentsPhrase(reason.documents)} non ha mai avuto un valore.`
          : `${nameOf(input.field, fieldId)} segnato non utile per ${documentType}: era ${FIELD_ROLE_LABELS[before]} e viene scartato lo stesso, con un valore su ${plural(usedCount(reason), 'documento', 'documenti')}.`
    }
  }

  if (edit.kind === 'ADD_FIELD') {
    if (before !== null && before !== 'excluded') {
      throw new ProfileEditError(
        `La mappa di «${documentType}» prevede già ${nameOf(input.field, fieldId)} come ${FIELD_ROLE_LABELS[before]}.`
      )
    }
    return {
      ...base,
      after: edit.role,
      override: edit.role,
      detail:
        before === 'excluded'
          ? `${nameOf(input.field, fieldId)} rientra nella mappa di ${documentType} come ${FIELD_ROLE_LABELS[edit.role]}: era segnato non utile.`
          : requestedCount(reason) === 0
            ? `${nameOf(input.field, fieldId)} aggiunto alla mappa di ${documentType} come ${FIELD_ROLE_LABELS[edit.role]}: il registry non lo prevedeva.`
            : `${nameOf(input.field, fieldId)} aggiunto alla mappa di ${documentType} come ${FIELD_ROLE_LABELS[edit.role]}: il revisore lo ha messo lui su ${plural(requestedCount(reason), 'documento', 'documenti')}.`
    }
  }

  if (before === null || before === 'excluded') {
    throw new ProfileEditError(
      `La mappa di «${documentType}» non chiede ${nameOf(input.field, fieldId)}: prima va aggiunto.`
    )
  }
  if (before === edit.role) {
    throw new ProfileEditError(
      `${nameOf(input.field, fieldId)} è già ${FIELD_ROLE_LABELS[edit.role]} nella mappa di «${documentType}».`
    )
  }

  return {
    ...base,
    after: edit.role,
    override: edit.role,
    detail: `${nameOf(input.field, fieldId)} passa da ${FIELD_ROLE_LABELS[before]} a ${FIELD_ROLE_LABELS[edit.role]} su ${documentType}.`
  }
}

/** La frase di un annullamento, scritta dal punto di vista di chi legge la cronologia. */
export function describeRevert(action: { detail: string; at: string }): string {
  return `Annullata l'azione del ${action.at}: ${action.detail}`
}

export { stateLabel }
