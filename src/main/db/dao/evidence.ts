import { randomUUID } from 'node:crypto'
import type { BoundingBox, PickLocation, PickMethod } from '@shared/types'
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
  /** La regola appresa che ha trovato l'etichetta, se il valore viene da lì. */
  ruleId?: string | null
}

/** La selezione del revisore: il punto del documento da cui ha preso un valore. */
export interface ReviewerEvidenceInput {
  page: number
  /** Verbatim: quello che ha selezionato, o che l'OCR ha letto nell'area. */
  text: string
  bbox?: BoundingBox | null
  method: PickMethod
  location: PickLocation | null
}

/** Una selezione è un fatto, non una stima: la confidence non ha niente da dire. */
const REVIEWER_CONFIDENCE = 1

export function createEvidenceDao(db: Db) {
  const insert = db.prepare(`
    INSERT INTO evidence (id, document_id, page, text, bbox_json, confidence, origin, method,
                          line_start, line_end, char_start, char_end, rule_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  return {
    /**
     * Sostituisce in blocco le evidenze del motore (ri-estrazione). Quelle del revisore
     * restano: sono le selezioni dietro le sue correzioni, che la ri-estrazione conserva.
     */
    replaceForDocument(documentId: string, items: EvidenceInput[]): string[] {
      db.prepare('UPDATE fields SET evidence_id = NULL WHERE document_id = ?').run(documentId)
      // Anche gli elementi dei campi `many` puntano alle evidenze: senza questo il
      // DELETE qui sotto violerebbe la foreign key al secondo run.
      db.prepare(
        'UPDATE field_items SET evidence_id = NULL WHERE field_id IN (SELECT id FROM fields WHERE document_id = ?)'
      ).run(documentId)
      db.prepare("DELETE FROM evidence WHERE document_id = ? AND origin = 'ENGINE'").run(documentId)
      const ids: string[] = []
      for (const item of items) {
        const id = item.id ?? randomUUID()
        insert.run(
          id,
          documentId,
          item.page,
          item.text,
          item.bbox ? JSON.stringify(item.bbox) : null,
          item.confidence,
          'ENGINE',
          null,
          null,
          null,
          null,
          null,
          item.ruleId ?? null
        )
        ids.push(id)
      }
      return ids
    },

    /** Registra una selezione del revisore; il campo o la riga la collegano da sé. */
    addReviewer(documentId: string, input: ReviewerEvidenceInput): string {
      const id = randomUUID()
      insert.run(
        id,
        documentId,
        input.page,
        input.text,
        input.bbox ? JSON.stringify(input.bbox) : null,
        REVIEWER_CONFIDENCE,
        'REVIEWER',
        input.method,
        input.location?.lineStart ?? null,
        input.location?.lineEnd ?? null,
        input.location?.charStart ?? null,
        input.location?.charEnd ?? null,
        null
      )
      return id
    },

    /**
     * Toglie le selezioni che nessuna correzione cita più: il revisore ha riscritto il
     * valore a mano, è tornato alla proposta, ha cancellato la riga. Chi cambia una
     * correzione chiama questo dopo, invece di inseguire la selezione vecchia.
     */
    pruneReviewer(documentId: string): void {
      db.prepare(`
        DELETE FROM evidence
         WHERE document_id = @documentId AND origin = 'REVIEWER'
           AND id NOT IN (
             SELECT corrected_evidence_id FROM fields
              WHERE document_id = @documentId AND corrected_evidence_id IS NOT NULL
           )
           AND id NOT IN (
             SELECT i.corrected_evidence_id FROM field_items i JOIN fields f ON f.id = i.field_id
              WHERE f.document_id = @documentId AND i.corrected_evidence_id IS NOT NULL
           )
      `).run({ documentId })
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
