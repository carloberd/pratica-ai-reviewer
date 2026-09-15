import { randomUUID } from 'node:crypto'
import type { Db } from '../index'
import type { EventRow } from '../rows'

export function createEventsDao(db: Db) {
  const insert = db.prepare(
    'INSERT INTO events (id, document_id, at, title, detail) VALUES (?, ?, ?, ?, ?)'
  )

  return {
    add(documentId: string, title: string, detail: string, at = new Date().toISOString()): void {
      insert.run(randomUUID(), documentId, at, title, detail)
    },

    listForDocument(documentId: string): EventRow[] {
      return db
        .prepare('SELECT * FROM events WHERE document_id = ? ORDER BY at, rowid')
        .all(documentId) as EventRow[]
    }
  }
}

export type EventsDao = ReturnType<typeof createEventsDao>
