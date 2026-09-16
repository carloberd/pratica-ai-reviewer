import type { FieldRole } from './extraction-v2'
import { confirmedItems, currentFieldValue } from './field-edits'
import type { ExtractedField, ReviewDocument, TypeMatchReason, TypeSignalSource } from './types'

/**
 * Regole della schermata di revisione che non dipendono da React: quali campi vanno
 * compilati a mano e quando proporre i candidati di tipo. Stanno qui per essere testate
 * senza un DOM e per seguire il codice quando finirà dentro pratica-ai.
 */

/** Il motore ha proposto qualcosa per questo campo: un valore, o almeno una riga. */
export function hasEngineProposal(field: ExtractedField): boolean {
  if (field.cardinality === 'many') {
    return field.items.some((item) => item.origin === 'ENGINE' && item.value.trim() !== '')
  }
  return field.value.trim() !== ''
}

/** Il campo, allo stato attuale, non ha valore: né proposto né messo dal revisore. */
export function isFieldEmpty(field: ExtractedField): boolean {
  if (field.cardinality === 'many') return confirmedItems(field.items).length === 0
  return currentFieldValue(field) === null
}

const ROLE_RANK: Record<FieldRole, number> = { required: 0, core: 1, conditional: 2, optional: 3 }

function roleRank(field: ExtractedField): number {
  if (field.role) return ROLE_RANK[field.role]
  return field.required ? 0 : 1
}

export interface FieldGroups {
  /** Campi dove il motore non ha proposto niente: si riempiono a mano. Obbligatori prima. */
  toFill: ExtractedField[]
  /** Campi con una proposta da controllare, nell'ordine del profilo. */
  proposed: ExtractedField[]
  /** Quanti campi di `toFill` sono ancora vuoti. */
  stillEmpty: number
}

/**
 * Divide i campi fra quelli da riempire a mano e quelli da controllare. L'appartenenza
 * dipende dalla proposta del motore, non dal valore attuale: un campo compilato dal
 * revisore resta dov'è invece di saltare nell'altro gruppo mentre ci sta lavorando, e
 * il contatore dice quanti ne mancano ancora. Nessun campo viene nascosto.
 */
export function groupFieldsForReview(fields: ExtractedField[]): FieldGroups {
  const toFill = fields
    .map((field, order) => ({ field, order }))
    .filter(({ field }) => !hasEngineProposal(field))
    .sort((a, b) => roleRank(a.field) - roleRank(b.field) || a.order - b.order)
    .map(({ field }) => field)
  const proposed = fields.filter(hasEngineProposal)
  return { toFill, proposed, stillEmpty: toFill.filter(isFieldEmpty).length }
}

/**
 * Un tipo assegnato col margine sotto questo multiplo del margine minimo è un'assegnazione
 * da ricontrollare: il classificatore l'ha data, ma il secondo candidato era vicino.
 */
export const LOW_MARGIN_FACTOR = 2

/**
 * I candidati si propongono in evidenza quando servono a decidere: tipo non assegnato,
 * oppure assegnato dal motore con un margine basso. Se il tipo l'ha scelto il revisore
 * la scelta vale, e i candidati restano consultabili senza insistere.
 */
export function shouldSuggestCandidates(
  document: Pick<ReviewDocument, 'documentType' | 'typeConfidence' | 'classification'>
): boolean {
  const classification = document.classification
  if (!classification || classification.candidates.length === 0) return false
  if (!document.documentType) return true
  if (document.typeConfidence === null) return false
  if (classification.decision === 'UNKNOWN') return true
  return (
    classification.margin !== null &&
    classification.minimumMargin !== null &&
    classification.margin < classification.minimumMargin * LOW_MARGIN_FACTOR
  )
}

/** Perché il classificatore non ha assegnato il tipo, come lo legge il revisore. */
export const TYPE_MATCH_REASON_LABELS: Record<Exclude<TypeMatchReason, 'OK'>, string> = {
  BELOW_THRESHOLD: 'il punteggio non raggiunge la soglia',
  LOW_MARGIN: 'il margine sul secondo candidato è troppo stretto',
  FILENAME_ONLY: 'la frase compare solo nel nome del file',
  HARD_NEGATIVE: 'il testo contiene un segnale che esclude il tipo',
  NO_SIGNAL: 'nessun alias o segnale del registry compare nel testo'
}

/** Dove il classificatore ha trovato un indizio. */
export const TYPE_SIGNAL_SOURCE_LABELS: Record<TypeSignalSource, string> = {
  'title-zone': 'nel titolo',
  page: 'nel testo',
  filename: 'nel nome del file',
  'positive-signal': 'segnale a favore',
  'negative-signal': 'segnale contrario',
  'hard-negative-signal': 'segnale che esclude'
}
