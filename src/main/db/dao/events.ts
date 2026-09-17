import { randomUUID } from 'node:crypto'
import type { Db } from '../index'
import type { EventRow } from '../rows'

/** Un evento con il documento a cui appartiene, per la cronologia unica. */
export interface RecentEventRow extends EventRow {
  filename: string
  document_type: string | null
}

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
    },

    /**
     * Gli eventi di tutti i documenti, dal più recente, con il documento a cui
     * appartengono. È quello che serve alla cronologia unica: le correzioni alla mappa
     * si leggono accanto alle annotazioni che le hanno motivate.
     */
    listRecent(limit = 500): RecentEventRow[] {
      return db
        .prepare(
          `SELECT e.*, d.filename, d.document_type
             FROM events e
             JOIN documents d ON d.id = e.document_id
            ORDER BY e.at DESC, e.rowid DESC
            LIMIT ?`
        )
        .all(limit) as RecentEventRow[]
    }
  }
}

export type EventsDao = ReturnType<typeof createEventsDao>
