import type { PageLine } from '@shared/pick-locate'
import type { BoundingBox, TextSource } from '@shared/types'
import type { Db } from '../index'

export interface PageInput {
  page: number
  textSource: TextSource
  lines: PageLine[]
}

interface StoredLine {
  text?: unknown
  bbox?: unknown
}

interface PageRow {
  page: number
  text_source: TextSource
  lines_json: string
}

function toBbox(value: unknown): BoundingBox | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { x, y, w, h } = value as Record<string, unknown>
  return typeof x === 'number' &&
    typeof y === 'number' &&
    typeof w === 'number' &&
    typeof h === 'number'
    ? { x, y, w, h }
    : undefined
}

/**
 * Le righe salvate, o niente: un `lines_json` illeggibile disabilita la posizione di quella
 * pagina invece di far cadere la lettura del documento. La selezione resta senza offset, il
 * valore si salva lo stesso.
 */
function parseLines(json: string): PageLine[] {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry: StoredLine) => {
      if (typeof entry?.text !== 'string') return []
      const bbox = toBbox(entry.bbox)
      return [bbox ? { text: entry.text, bbox } : { text: entry.text }]
    })
  } catch {
    return []
  }
}

/**
 * Le righe del testo come le ha lette l'elaborazione. Sono il riferimento su cui si ritrova
 * una selezione del revisore, e si rileggono solo per quello: la ricerca full-text ha la
 * sua tabella.
 */
export function createPagesDao(db: Db) {
  const insert = db.prepare(
    'INSERT INTO document_pages (document_id, page, text_source, lines_json) VALUES (?, ?, ?, ?)'
  )

  return {
    /** Sostituisce le pagine di un documento: il testo di una nuova elaborazione vale per tutte. */
    replaceForDocument(documentId: string, pages: PageInput[]): void {
      db.prepare('DELETE FROM document_pages WHERE document_id = ?').run(documentId)
      for (const page of pages) {
        const lines = page.lines.map((line) =>
          line.bbox ? { text: line.text, bbox: line.bbox } : { text: line.text }
        )
        insert.run(documentId, page.page, page.textSource, JSON.stringify(lines))
      }
    },

    /**
     * Le righe di una pagina, vuote se la pagina non c'è: un documento elaborato prima
     * della migrazione 0010 non ne ha finché non si rielabora.
     */
    lines(documentId: string, page: number): PageLine[] {
      const row = db
        .prepare('SELECT lines_json FROM document_pages WHERE document_id = ? AND page = ?')
        .get(documentId, page) as { lines_json: string } | undefined
      if (!row) return []
      return parseLines(row.lines_json)
    },

    /**
     * Tutte le pagine di un documento, in ordine. Serve a ritrovare un valore che il
     * revisore ha digitato invece di selezionarlo (`src/main/inferred-pick.ts`): lì la
     * garanzia è che il valore compaia una volta sola nel **documento**, non nella pagina,
     * quindi vanno guardate tutte.
     */
    list(documentId: string): PageInput[] {
      const rows = db
        .prepare(
          'SELECT page, text_source, lines_json FROM document_pages WHERE document_id = ? ORDER BY page'
        )
        .all(documentId) as PageRow[]
      return rows.map((row) => ({
        page: row.page,
        textSource: row.text_source,
        lines: parseLines(row.lines_json)
      }))
    }
  }
}

export type PagesDao = ReturnType<typeof createPagesDao>
