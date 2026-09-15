import { randomUUID } from 'node:crypto'
import type { BoundingBox } from '@shared/types'
import type { Db } from '../index'
import type { AnnotationRow } from '../rows'

export interface AnnotationInput {
  documentId: string
  page: number
  bbox: BoundingBox
  kind: 'highlight' | 'note'
  note?: string | undefined
}

/**
 * D3: le annotazioni vivono qui e basta. Nessuna viene incisa nel PDF di cache, che
 * resta identico byte per byte al file su Drive.
 */
export function createAnnotationsDao(db: Db) {
  return {
    add(input: AnnotationInput): AnnotationRow {
      const id = randomUUID()
      const now = new Date().toISOString()
      db.prepare(`
        INSERT INTO annotations (id, document_id, page, bbox_json, kind, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.documentId,
        input.page,
        JSON.stringify(input.bbox),
        input.kind,
        input.note ?? null,
        now,
        now
      )
      return this.get(id)!
    },

    get(id: string): AnnotationRow | undefined {
      return db.prepare('SELECT * FROM annotations WHERE id = ?').get(id) as
        | AnnotationRow
        | undefined
    },

    listForDocument(documentId: string): AnnotationRow[] {
      return db
        .prepare('SELECT * FROM annotations WHERE document_id = ? ORDER BY page, created_at')
        .all(documentId) as AnnotationRow[]
    },

    update(
      id: string,
      patch: { bbox?: BoundingBox; note?: string | null }
    ): AnnotationRow | undefined {
      const existing = this.get(id)
      if (!existing) return undefined
      db.prepare('UPDATE annotations SET bbox_json = ?, note = ?, updated_at = ? WHERE id = ?').run(
        patch.bbox ? JSON.stringify(patch.bbox) : existing.bbox_json,
        patch.note === undefined ? existing.note : patch.note,
        new Date().toISOString(),
        id
      )
      return this.get(id)
    },

    delete(id: string): boolean {
      return db.prepare('DELETE FROM annotations WHERE id = ?').run(id).changes > 0
    }
  }
}

export type AnnotationsDao = ReturnType<typeof createAnnotationsDao>
