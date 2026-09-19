import { type CompanyIdentity, EMPTY_COMPANY } from '@shared/document-direction'
import type { Db } from '../index'

/**
 * L'azienda di cui sono i documenti: una riga sola (migrazione 0019).
 *
 * Serve a dire se un documento è emesso o ricevuto, confrontando le parti del documento
 * con lei. Finché è vuota nessun documento ha una direzione, ed è giusto: non c'è niente
 * con cui confrontare.
 */

interface CompanyRow {
  name: string | null
  vat_number: string | null
  tax_code: string | null
  updated_at: string
}

/** Uno spazio non è un valore: un campo lasciato in bianco torna `null`. */
function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? ''
  return text.length > 0 ? text : null
}

export function createCompanyDao(db: Db) {
  return {
    get(): CompanyIdentity {
      const row = db.prepare('SELECT * FROM company_identity WHERE id = 1').get() as
        | CompanyRow
        | undefined
      if (!row) return EMPTY_COMPANY
      return { name: row.name, vatNumber: row.vat_number, taxCode: row.tax_code }
    },

    set(identity: CompanyIdentity, now = new Date().toISOString()): CompanyIdentity {
      db.prepare(
        'UPDATE company_identity SET name = ?, vat_number = ?, tax_code = ?, updated_at = ? WHERE id = 1'
      ).run(trimmed(identity.name), trimmed(identity.vatNumber), trimmed(identity.taxCode), now)
      return this.get()
    }
  }
}
