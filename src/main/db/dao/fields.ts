import { randomUUID } from 'node:crypto'
import type { Db } from '../index'
import type { FieldRow } from '../rows'

export interface FieldInput {
  name: string
  label: string
  value: string | null
  confidence: number
  evidenceId?: string | null
}

export function createFieldsDao(db: Db) {
  const insert = db.prepare(`
    INSERT INTO fields (id, document_id, name, label, value, corrected_value, confidence, evidence_id, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)
  `)

  return {
    /**
     * Sostituisce i campi di un documento. Le correzioni umane gia` salvate vengono
     * conservate per nome del campo: una ri-estrazione non deve cancellare il lavoro
     * del revisore.
     */
    replaceForDocument(documentId: string, fields: FieldInput[]): void {
      const previous = db
        .prepare('SELECT name, corrected_value, updated_at FROM fields WHERE document_id = ?')
        .all(documentId) as Array<Pick<FieldRow, 'name' | 'corrected_value' | 'updated_at'>>
      const corrections = new Map(
        previous
          .filter((row) => row.corrected_value !== null)
          .map((row) => [row.name, row] as const)
      )

      db.prepare('DELETE FROM fields WHERE document_id = ?').run(documentId)

      for (const field of fields) {
        const id = randomUUID()
        insert.run(
          id,
          documentId,
          field.name,
          field.label,
          field.value,
          field.confidence,
          field.evidenceId ?? null
        )
        const kept = corrections.get(field.name)
        if (kept) {
          db.prepare('UPDATE fields SET corrected_value = ?, updated_at = ? WHERE id = ?').run(
            kept.corrected_value,
            kept.updated_at,
            id
          )
        }
      }
    },

    listForDocument(documentId: string): FieldRow[] {
      return db
        .prepare('SELECT * FROM fields WHERE document_id = ? ORDER BY rowid')
        .all(documentId) as FieldRow[]
    },

    get(id: string): FieldRow | undefined {
      return db.prepare('SELECT * FROM fields WHERE id = ?').get(id) as FieldRow | undefined
    },

    /**
     * Registra la correzione umana. `null` annulla la correzione e riporta il campo
     * al valore precompilato: `value` non viene mai sovrascritto.
     */
    setCorrectedValue(id: string, correctedValue: string | null): void {
      db.prepare('UPDATE fields SET corrected_value = ?, updated_at = ? WHERE id = ?').run(
        correctedValue,
        correctedValue === null ? null : new Date().toISOString(),
        id
      )
    },

    corrected(documentId: string): FieldRow[] {
      return db
        .prepare('SELECT * FROM fields WHERE document_id = ? AND corrected_value IS NOT NULL')
        .all(documentId) as FieldRow[]
    }
  }
}

export type FieldsDao = ReturnType<typeof createFieldsDao>
