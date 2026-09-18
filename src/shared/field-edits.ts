import { normalizeDateValue } from './date-value'
import type { ExtractedField, FieldItem } from './types'

/**
 * Regole delle modifiche del revisore, per i campi singoli e per le righe dei campi
 * ripetuti. Nessuna dipendenza da Electron o dal database: le usano il main per
 * scrivere, la review per il payload e l'export per il before/after.
 *
 * Il principio è lo stesso ovunque: il valore proposto dal motore non si sovrascrive mai,
 * la correzione gli sta accanto, e riscrivere quello che il motore aveva già proposto non
 * è una correzione.
 */

export type CorrectionKind =
  /** Il motore aveva proposto un valore, il revisore ne ha messo un altro. */
  | 'CHANGED'
  /** Il motore non aveva proposto niente, il revisore ha compilato. */
  | 'FILLED'
  /** Il motore aveva proposto un valore, il revisore l'ha svuotato. */
  | 'CLEARED'
  /** Riga di un campo ripetuto aggiunta dal revisore. */
  | 'ADDED'
  /** Riga proposta dal motore tolta dal revisore. */
  | 'REMOVED'

export interface Correction {
  fieldId: string
  name: string
  label: string
  /** Solo per i campi ripetuti. */
  itemId: string | null
  itemIndex: number | null
  kind: CorrectionKind
  /** Valore proposto dal motore, `null` se non ne aveva proposto uno. */
  before: string | null
  /** Valore messo dal revisore, `null` se l'ha tolto. */
  after: string | null
}

function orNull(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value
}

// ---------------------------------------------------------------------------
// Campi singoli
// ---------------------------------------------------------------------------

/**
 * Quello che il revisore ha scritto, nella forma in cui si salva.
 *
 * Per i campi data è `yyyy-mm-dd`, come la scrive il motore: il revisore ricopia la
 * stringa dal documento — «16/12/2025», «31.05.2024», «31 Maggio 2022» — e due formati
 * diversi per la stessa data rendono il dataset inutilizzabile per misurare l'estrazione.
 * Quello che il revisore ha selezionato resta verbatim nella sua evidenza, quindi la
 * forma originale non si perde.
 *
 * Quello che non è **tutta** una data resta com'è: «03/05/2021 (8 ore), 04/05/2021
 * (8 ore)» si salva intero, perché normalizzarlo vorrebbe dire buttarne via metà.
 */
export function normalizeFieldValue(value: string, isDate: boolean): string {
  const trimmed = value.trim()
  if (!isDate) return trimmed
  return normalizeDateValue(trimmed) ?? trimmed
}

/**
 * La correzione da salvare quando il revisore scrive `next` in un campo che il motore
 * aveva precompilato con `proposed`. `null` = nessuna correzione (annullata, o uguale
 * alla proposta); la stringa vuota = il revisore ha svuotato una proposta sbagliata.
 *
 * Il confronto con la proposta si fa **dopo** la normalizzazione: se il motore aveva letto
 * `2025-12-16` e il revisore ricopia `16/12/2025`, sono d'accordo, e non è una correzione.
 */
export function resolveFieldEdit(
  proposed: string | null,
  next: string | null,
  isDate = false
): string | null {
  if (next === null) return null
  const normalized = normalizeFieldValue(next, isDate)
  return normalized === (proposed ?? '').trim() ? null : normalized
}

/** Il valore del campo come lo vede il revisore: `null` se vuoto. */
export function currentFieldValue(field: Pick<ExtractedField, 'value' | 'correctedValue'>) {
  return orNull(field.correctedValue ?? field.value)
}

// ---------------------------------------------------------------------------
// Righe dei campi ripetuti
// ---------------------------------------------------------------------------

export type ItemEdit =
  /** Salva `value` come correzione (o come valore, per una riga aggiunta a mano). */
  | { type: 'correct'; value: string }
  /** Torna alla proposta del motore. */
  | { type: 'reset' }
  /** Toglie una riga proposta: la proposta resta a database. */
  | { type: 'remove' }
  /** Cancella una riga aggiunta a mano. */
  | { type: 'delete' }
  | { type: 'none' }

/**
 * Cosa diventa quello che il revisore scrive in una riga. `null` annulla la correzione;
 * svuotare una riga proposta la toglie, svuotare una riga aggiunta a mano la cancella.
 */
export function resolveItemEdit(
  item: Pick<FieldItem, 'origin' | 'value' | 'correctedValue'>,
  next: string | null,
  isDate = false
): ItemEdit {
  const trimmed = next === null ? null : normalizeFieldValue(next, isDate)
  if (item.origin === 'MANUAL') {
    if (!trimmed) return { type: 'delete' }
    return trimmed === item.correctedValue ? { type: 'none' } : { type: 'correct', value: trimmed }
  }
  if (trimmed === null || trimmed === item.value.trim()) return { type: 'reset' }
  if (trimmed === '') return { type: 'remove' }
  return { type: 'correct', value: trimmed }
}

/** Il testo di una riga nuova, o `null` se non c'è niente da aggiungere. */
export function normalizeNewItem(value: string, isDate = false): string | null {
  const trimmed = normalizeFieldValue(value, isDate)
  return trimmed === '' ? null : trimmed
}

/** Il valore della riga come lo vede il revisore: `null` se tolta o vuota. */
export function currentItemValue(item: FieldItem): string | null {
  if (item.removed) return null
  return orNull(item.correctedValue ?? item.value)
}

/** Righe nell'ordine della tabella. */
export function sortedItems(items: FieldItem[]): FieldItem[] {
  return [...items].sort((a, b) => a.index - b.index)
}

/** Righe con un valore, cioè quelle che il revisore conferma. */
export function confirmedItems(items: FieldItem[]): FieldItem[] {
  return sortedItems(items).filter((item) => currentItemValue(item) !== null)
}

// ---------------------------------------------------------------------------
// Before/after
// ---------------------------------------------------------------------------

/** Le correzioni di un campo: una sola per un campo singolo, una per riga per un ripetuto. */
export function fieldCorrections(field: ExtractedField): Correction[] {
  const base = { fieldId: field.id, name: field.name, label: field.label }

  if (field.cardinality === 'many') {
    const corrections: Correction[] = []
    for (const item of sortedItems(field.items)) {
      const before = item.origin === 'ENGINE' ? orNull(item.value) : null
      const after = currentItemValue(item)
      if (before === after) continue
      const kind: CorrectionKind =
        before === null ? 'ADDED' : after === null ? 'REMOVED' : 'CHANGED'
      corrections.push({ ...base, itemId: item.id, itemIndex: item.index, kind, before, after })
    }
    return corrections
  }

  if (field.correctedValue === undefined) return []
  const before = orNull(field.value)
  const after = orNull(field.correctedValue)
  if (before === after) return []
  const kind: CorrectionKind = before === null ? 'FILLED' : after === null ? 'CLEARED' : 'CHANGED'
  return [{ ...base, itemId: null, itemIndex: null, kind, before, after }]
}

export function documentCorrections(fields: ExtractedField[]): Correction[] {
  return fields.flatMap(fieldCorrections)
}
