import type { ProfileEditReason } from './profile-edit'
import type { MapValue } from './profile-overlay'

/**
 * La cronologia: tutto quello che è stato fatto, in ordine di tempo.
 *
 * Due sorgenti, una lista sola. Le azioni sulla mappa «tipo ↔ dati da estrarre» stanno
 * in `profile_actions`; gli eventi dei documenti (aperto, tipo cambiato, salvato,
 * scartato) sono quelli che il database registra da sempre nella timeline del singolo
 * documento. Chi valida la mappa deve poterli leggere insieme: una correzione presa il
 * martedì si capisce solo accanto alle annotazioni che l'hanno motivata.
 *
 * Modulo puro: qui si decide cosa si legge, non come si interroga il database.
 */

export type ProfileActionKind =
  | 'ADD_FIELD'
  | 'REMOVE_FIELD'
  | 'SET_ROLE'
  | 'RESTORE_FIELD'
  | 'ADD_HINT_LABEL'
  | 'SET_CARDINALITY'
  | 'REVERT'
  | 'RERUN'
  | 'EXPORT'

/** Un'azione sulla mappa, come attraversa il ponte IPC e come finisce nell'export. */
export interface ProfileAction {
  id: string
  at: string
  kind: ProfileActionKind
  documentType: string | null
  fieldId: string | null
  label: string | null
  /** Peso o «non utile»; per SET_CARDINALITY, `one` o `many`. */
  before: MapValue | null
  after: MapValue | null
  /** La decisione che c'era prima, da rimettere annullando: `null` = seguiva il registry. */
  previousOverride: MapValue | null
  detail: string
  /** I numeri delle annotazioni quando l'azione è stata fatta. */
  reason: ProfileEditReason | null
  /** L'azione annullata da questa, se è un annullamento. */
  revertsId: string | null
  /** Quando questa azione è stata annullata; `null` finché vale. */
  revertedAt: string | null
}

/** Un evento della revisione di un documento, con il documento a cui appartiene. */
export interface DocumentEventEntry {
  id: string
  at: string
  documentId: string
  filename: string
  documentType: string | null
  title: string
  detail: string
}

/** Una riga della cronologia, comunque sia nata. */
export interface ActivityEntry {
  id: string
  at: string
  source: 'MAP' | 'DOCUMENT'
  title: string
  detail: string
  documentType: string | null
  documentId: string | null
  filename: string | null
  fieldId: string | null
  /** `true` se l'azione si può ancora annullare da qui. */
  revertable: boolean
  revertedAt: string | null
}

export const ACTION_TITLES: Record<ProfileActionKind, string> = {
  ADD_FIELD: 'Campo aggiunto alla mappa',
  REMOVE_FIELD: 'Campo segnato non utile',
  SET_ROLE: 'Peso del campo cambiato',
  RESTORE_FIELD: 'Campo riportato al registry',
  ADD_HINT_LABEL: 'Etichetta insegnata al motore',
  SET_CARDINALITY: 'Numero di valori cambiato',
  REVERT: 'Azione annullata',
  RERUN: 'Documenti rielaborati',
  EXPORT: 'Mappa esportata'
}

/** Le azioni che cambiano la mappa: solo queste si possono annullare. */
const REVERTABLE: ProfileActionKind[] = [
  'ADD_FIELD',
  'REMOVE_FIELD',
  'SET_ROLE',
  'RESTORE_FIELD',
  'ADD_HINT_LABEL',
  'SET_CARDINALITY'
]

/** Le azioni che lasciano un segno sulla mappa, annullamenti esclusi. */
export function isMapEdit(kind: ProfileActionKind): boolean {
  return REVERTABLE.includes(kind)
}

/**
 * Cosa di un campo cambia un'azione. Il peso (con aggiunta, scarto e ripristino) e la
 * cardinalità sono due decisioni separate: si annullano ognuna seguendo la propria fila,
 * e un peso cambiato dopo non blocca l'annullamento di una cardinalità presa prima.
 */
export function actionTrack(kind: ProfileActionKind): 'ROLE' | 'CARDINALITY' | 'HINT' | null {
  if (kind === 'ADD_HINT_LABEL') return 'HINT'
  if (kind === 'SET_CARDINALITY') return 'CARDINALITY'
  return isMapEdit(kind) ? 'ROLE' : null
}

/**
 * Quali azioni si possono ancora annullare.
 *
 * Solo l'ultima azione su un campo, per ciascuna delle sue decisioni: annullarne una più vecchia rimetterebbe uno stato
 * che nel frattempo qualcuno ha già cambiato, e la cronologia direbbe una cosa mentre la
 * mappa ne dice un'altra. Le etichette insegnate non hanno questo problema — ognuna sta
 * per conto suo — e restano annullabili finché non lo sono state.
 */
export function revertableActions(actions: ProfileAction[]): Set<string> {
  const revertable = new Set<string>()
  const seen = new Set<string>()
  // Dalla più recente alla più vecchia: la prima che si incontra su un campo è l'ultima
  // che è stata fatta.
  for (const action of [...actions].sort((a, b) => b.at.localeCompare(a.at))) {
    if (!isMapEdit(action.kind) || action.revertedAt) continue
    if (action.kind === 'ADD_HINT_LABEL') {
      revertable.add(action.id)
      continue
    }
    const key = JSON.stringify([action.documentType, action.fieldId, actionTrack(action.kind)])
    if (seen.has(key)) continue
    seen.add(key)
    revertable.add(action.id)
  }
  return revertable
}

/** Le due sorgenti in una lista sola, dalla più recente alla più vecchia. */
export function buildActivity(
  actions: ProfileAction[],
  events: DocumentEventEntry[]
): ActivityEntry[] {
  const revertable = revertableActions(actions)

  const fromActions: ActivityEntry[] = actions.map((action) => ({
    id: action.id,
    at: action.at,
    source: 'MAP',
    title: ACTION_TITLES[action.kind],
    detail: action.detail,
    documentType: action.documentType,
    documentId: null,
    filename: null,
    fieldId: action.fieldId,
    revertable: revertable.has(action.id),
    revertedAt: action.revertedAt
  }))

  const fromEvents: ActivityEntry[] = events.map((event) => ({
    id: event.id,
    at: event.at,
    source: 'DOCUMENT',
    title: event.title,
    detail: event.detail,
    documentType: event.documentType,
    documentId: event.documentId,
    filename: event.filename,
    fieldId: null,
    revertable: false,
    revertedAt: null
  }))

  return [...fromActions, ...fromEvents].sort((a, b) => b.at.localeCompare(a.at))
}

/** Quante correzioni alla mappa sono ancora in piedi, per la riga di riepilogo. */
export function countStandingEdits(actions: ProfileAction[]): number {
  return actions.filter((action) => isMapEdit(action.kind) && action.revertedAt === null).length
}
