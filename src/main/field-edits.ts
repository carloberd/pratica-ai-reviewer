import { normalizeNewItem, resolveFieldEdit, resolveItemEdit } from '@shared/field-edits'
import { locatePick, pickValue } from '@shared/pick-locate'
import type { DocumentPick } from '@shared/types'
import type { Repository } from './db/repository'
import { parseItemValue } from './db/rows'
import { ReviewerError } from './errors'

/**
 * Le modifiche del revisore ai campi, con le regole di `@shared/field-edits`. Nessuna
 * dipendenza da Electron: i canali IPC le chiamano e basta. Ogni funzione verifica che
 * campo e riga appartengano al documento indicato, perché gli id arrivano dal renderer.
 *
 * Un valore preso dal documento arriva con la sua selezione (`pick`), che diventa
 * un'evidenza del revisore collegata alla correzione. Senza `pick` il valore è scritto a
 * mano, e una selezione precedente smette di valere.
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

/**
 * Registra la selezione dietro un valore e ne ritorna l'id, o `null` se il valore non
 * viene da una selezione.
 *
 * La selezione vale solo se è proprio il valore salvato: il renderer ripiega gli spazi del
 * testo selezionato e lo manda insieme, quindi uno scarto vuol dire che il valore è stato
 * cambiato dopo, e la selezione non ne è più l'origine. Un valore vuoto non ha origine.
 */
function recordPick(
  repo: Repository,
  documentId: string,
  value: string | null,
  pick: DocumentPick | undefined
): string | null {
  if (!pick || !value || pickValue(pick.text) !== value) return null
  return repo.evidence.addReviewer(documentId, {
    page: pick.page,
    text: pick.text,
    bbox: pick.bbox ?? null,
    method: pick.method,
    location: locatePick(repo.pages.lines(documentId, pick.page), pick)
  })
}

/** Correzione di un campo singolo. `null` la annulla, la stringa vuota svuota la proposta. */
export function updateFieldValue(
  repo: Repository,
  input: {
    documentId: string
    fieldId: string
    correctedValue: string | null
    pick?: DocumentPick | undefined
  }
): void {
  const field = fieldOf(repo, input.documentId, input.fieldId)
  if (field.cardinality === 'many') {
    throw new ReviewerError('INVALID_INPUT', 'Il campo è ripetuto: si modifica riga per riga.')
  }
  const corrected = resolveFieldEdit(field.value, input.correctedValue)
  repo.transaction(() => {
    const evidenceId = recordPick(repo, input.documentId, corrected, input.pick)
    repo.fields.setCorrectedValue(field.id, corrected, evidenceId)
    repo.evidence.pruneReviewer(input.documentId)
  })
}

/** Riga aggiunta dal revisore a un campo ripetuto, in coda alle altre. */
export function addFieldItem(
  repo: Repository,
  input: { documentId: string; fieldId: string; value: string; pick?: DocumentPick | undefined }
): void {
  const field = fieldOf(repo, input.documentId, input.fieldId)
  if (field.cardinality !== 'many') {
    throw new ReviewerError('INVALID_INPUT', 'Il campo non è ripetuto: non ha righe.')
  }
  const value = normalizeNewItem(input.value)
  if (value === null) throw new ReviewerError('INVALID_INPUT', 'La riga nuova è vuota.')
  repo.transaction(() => {
    const evidenceId = recordPick(repo, input.documentId, value, input.pick)
    repo.fields.addItem(field.id, value, evidenceId)
  })
}

/** Quello che il revisore scrive in una riga: correzione, ritorno alla proposta, rimozione. */
export function updateFieldItem(
  repo: Repository,
  input: {
    documentId: string
    itemId: string
    correctedValue: string | null
    pick?: DocumentPick | undefined
  }
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
        repo.fields.setItemCorrectedValue(
          row.id,
          edit.value,
          recordPick(repo, input.documentId, edit.value, input.pick)
        )
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
    repo.evidence.pruneReviewer(input.documentId)
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
    if (!input.removed) return
    repo.transaction(() => {
      repo.fields.deleteItem(row.id)
      repo.evidence.pruneReviewer(input.documentId)
    })
    return
  }
  repo.fields.setItemRemoved(row.id, input.removed)
}
