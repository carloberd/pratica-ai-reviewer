import type { Db } from '../index'

export interface PageText {
  page: number
  text: string
}

export interface SearchHitRow {
  documentId: string
  filename: string
  page: number
  snippet: string
}

/**
 * Trasforma il testo digitato dall'utente in un'espressione FTS5 sicura.
 *
 * L'input grezzo non può finire dentro `MATCH`: caratteri come `"`, `*`, `-`, `NEAR`
 * hanno un significato sintattico e una query malformata solleva un errore SQLite.
 * Qui ogni token diventa una stringa quotata con prefix match, unite in AND.
 */
export function toFtsQuery(input: string): string | null {
  const tokens = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1)
  if (tokens.length === 0) return null
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' AND ')
}

export function createSearchDao(db: Db) {
  const insert = db.prepare(
    'INSERT INTO documents_fts (document_id, filename, page, page_text) VALUES (?, ?, ?, ?)'
  )

  return {
    /** Reindicizza un documento: una riga per pagina, più una riga 0 per il solo filename. */
    replaceForDocument(documentId: string, filename: string, pages: PageText[]): void {
      db.prepare('DELETE FROM documents_fts WHERE document_id = ?').run(documentId)
      insert.run(documentId, filename, '0', '')
      for (const page of pages) {
        insert.run(documentId, filename, String(page.page), page.text)
      }
    },

    deleteForDocument(documentId: string): void {
      db.prepare('DELETE FROM documents_fts WHERE document_id = ?').run(documentId)
    },

    /** Id dei documenti che corrispondono, in ordine di rilevanza. */
    matchingDocumentIds(input: string): string[] {
      const query = toFtsQuery(input)
      if (!query) return []
      const rows = db
        .prepare(`
          SELECT document_id AS documentId, MIN(rank) AS bestRank
            FROM documents_fts
           WHERE documents_fts MATCH ?
        GROUP BY document_id
        ORDER BY bestRank
        `)
        .all(query) as Array<{ documentId: string }>
      return rows.map((row) => row.documentId)
    },

    /** Risultati di ricerca con snippet evidenziato, per la ricerca full-text della UI. */
    query(input: string, limit = 50): SearchHitRow[] {
      const query = toFtsQuery(input)
      if (!query) return []
      const rows = db
        .prepare(`
          SELECT document_id AS documentId,
                 filename,
                 CAST(page AS INTEGER) AS page,
                 snippet(documents_fts, 3, '[', ']', '…', 12) AS snippet
            FROM documents_fts
           WHERE documents_fts MATCH ?
        ORDER BY rank
           LIMIT ?
        `)
        .all(query, limit) as SearchHitRow[]
      return rows
    }
  }
}

export type SearchDao = ReturnType<typeof createSearchDao>
