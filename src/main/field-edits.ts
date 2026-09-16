import { normalizeNewItem, resolveFieldEdit, resolveItemEdit } from '@shared/field-edits'
import type { Repository } from './db/repository'
import { parseItemValue } from './db/rows'
import { ReviewerError } from './errors'

/**
 * Le modifiche del revisore ai campi, con le regole di `@shared/field-edits`. Nessuna
 * dipendenza da Electron: i canali IPC le chiamano e basta. Ogni funzione verifica che
 * campo e riga appartengano al documento indicato, perché gli id arrivano dal renderer.
 */

function fieldOf(repo: Repository, documentId: string, fieldId: string) {
  const field = repo.fields.get(fieldId)
  if (!field || field.document_id !== documentId) {
    throw new ReviewerError('NOT_FOUND', 'Campo non trovato su questo documento.')
  }
  return field
}

function itemOf(repo: Repository, documentId: string, itemId: string) {
  const item = repo.fields.getItem(itemId)
  if (!item || item.document_id !== documentId) {
    throw new ReviewerError('NOT_FOUND', 'Riga non trovata su questo documento.')
  }
  return item
}

/** Correzione di un campo singolo. `null` la annulla, la stringa vuota svuota la proposta. */
export function updateFieldValue(
  repo: Repository,
  input: { documentId: string; fieldId: string; correctedValue: string | null }
): void {
  const field = fieldOf(repo, input.documentId, input.fieldId)
  if (field.cardinality === 'many') {
    throw new ReviewerError('INVALID_INPUT', 'Il campo è ripetuto: si modifica riga per riga.')
  }
  repo.fields.setCorrectedValue(field.id, resolveFieldEdit(field.value, input.correctedValue))
}

/** Riga aggiunta dal revisore a un campo ripetuto, in coda alle altre. */
export function addFieldItem(
  repo: Repository,
  input: { documentId: string; fieldId: string; value: string }
): void {
  const field = fieldOf(repo, input.documentId, input.fieldId)
  if (field.cardinality !== 'many') {
    throw new ReviewerError('INVALID_INPUT', 'Il campo non è ripetuto: non ha righe.')
  }
  const value = normalizeNewItem(input.value)
  if (value === null) throw new ReviewerError('INVALID_INPUT', 'La riga nuova è vuota.')
  repo.fields.addItem(field.id, value)
}

/** Quello che il revisore scrive in una riga: correzione, ritorno alla proposta, rimozione. */
export function updateFieldItem(
  repo: Repository,
  input: { documentId: string; itemId: string; correctedValue: string | null }
): void {
  const row = itemOf(repo, input.documentId, input.itemId)
  const corrected = parseItemValue(row.corrected_value_json)
  const edit = resolveItemEdit(
    {
      origin: row.origin === 'MANUAL' ? 'MANUAL' : 'ENGINE',
      value: parseItemValue(row.value_json) ?? '',
      ...(corrected !== null ? { correctedValue: corrected } : {})
    },
    input.correctedValue
  )

  repo.transaction(() => {
    switch (edit.type) {
      case 'correct':
        repo.fields.setItemCorrectedValue(row.id, edit.value)
        if (row.removed === 1) repo.fields.setItemRemoved(row.id, false)
        break
      case 'reset':
        repo.fields.setItemCorrectedValue(row.id, null)
        if (row.removed === 1) repo.fields.setItemRemoved(row.id, false)
        break
      case 'remove':
        repo.fields.setItemRemoved(row.id, true)
        break
      case 'delete':
        repo.fields.deleteItem(row.id)
        break
      case 'none':
        break
    }
  })
}

/**
 * Toglie o rimette una riga. Una riga proposta dal motore resta a database, segnata come
 * tolta, perché il before/after deve poter dire che il motore l'aveva vista; una riga
 * aggiunta a mano non ha niente da ricordare e si cancella.
 */
export function setFieldItemRemoved(
  repo: Repository,
  input: { documentId: string; itemId: string; removed: boolean }
): void {
  const row = itemOf(repo, input.documentId, input.itemId)
  if (row.origin === 'MANUAL') {
    if (input.removed) repo.fields.deleteItem(row.id)
    return
  }
  repo.fields.setItemRemoved(row.id, input.removed)
}
