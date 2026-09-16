import { randomUUID } from 'node:crypto'
import type { BoundingBox } from '@shared/types'
import type { Db } from '../index'
import type { EvidenceRow } from '../rows'

export interface EvidenceInput {
  /** Fornito quando l'estrattore deve collegare un campo a un'evidenza appena creata. */
  id?: string
  page: number
  /** Verbatim dal documento. Non normalizzare mai questo testo. */
  text: string
  bbox?: BoundingBox | null
  confidence: number
}

export function createEvidenceDao(db: Db) {
  const insert = db.prepare(`
    INSERT INTO evidence (id, document_id, page, text, bbox_json, confidence)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  return {
    /** Sostituisce in blocco le evidenze di un documento (ri-estrazione). */
    replaceForDocument(documentId: string, items: EvidenceInput[]): string[] {
      db.prepare('UPDATE fields SET evidence_id = NULL WHERE document_id = ?').run(documentId)
      // Anche gli elementi dei campi `many` puntano alle evidenze: senza questo il
      // DELETE qui sotto violerebbe la foreign key al secondo run.
      db.prepare(
        'UPDATE field_items SET evidence_id = NULL WHERE field_id IN (SELECT id FROM fields WHERE document_id = ?)'
      ).run(documentId)
      db.prepare('DELETE FROM evidence WHERE document_id = ?').run(documentId)
      const ids: string[] = []
      for (const item of items) {
        const id = item.id ?? randomUUID()
        insert.run(
          id,
          documentId,
          item.page,
          item.text,
          item.bbox ? JSON.stringify(item.bbox) : null,
          item.confidence
        )
        ids.push(id)
      }
      return ids
    },

    listForDocument(documentId: string): EvidenceRow[] {
      return db
        .prepare('SELECT * FROM evidence WHERE document_id = ? ORDER BY page, rowid')
        .all(documentId) as EvidenceRow[]
    },

    get(id: string): EvidenceRow | undefined {
      return db.prepare('SELECT * FROM evidence WHERE id = ?').get(id) as EvidenceRow | undefined
    }
  }
}

export type EvidenceDao = ReturnType<typeof createEvidenceDao>
