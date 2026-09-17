import { randomUUID } from 'node:crypto'
import type {
  ConfidenceBand,
  DocumentFilters,
  QueueStatus,
  StoredTypeClassification,
  TextSource
} from '@shared/types'
import type { Db } from '../index'
import type { DocumentRow } from '../rows'

export interface UpsertDriveFileInput {
  driveFileId: string
  filename: string
  mime: string
  /** `modifiedTime` di Drive. */
  receivedAt: string | null
}

export interface UpsertResult {
  id: string
  /** Il documento non esisteva in locale. */
  isNew: boolean
  /** Drive riporta un `modifiedTime` più recente di quello già sincronizzato. */
  isStale: boolean
}

export interface ExtractionUpdate {
  documentType: string | null
  typeConfidence: number | null
  confidence: number
  confidenceBand: ConfidenceBand
  textSource: TextSource
}

export function createDocumentsDao(db: Db) {
  const insert = db.prepare(`
    INSERT INTO documents (id, drive_file_id, filename, mime, received_at, synced_at)
    VALUES (@id, @driveFileId, @filename, @mime, @receivedAt, @syncedAt)
  `)
  const selectByDriveId = db.prepare('SELECT * FROM documents WHERE drive_file_id = ?')
  const selectById = db.prepare('SELECT * FROM documents WHERE id = ?')

  return {
    /** Dedup per `drive_file_id`: lo stesso file su Drive non genera mai due documenti. */
    upsertFromDrive(input: UpsertDriveFileInput): UpsertResult {
      const existing = selectByDriveId.get(input.driveFileId) as DocumentRow | undefined
      const syncedAt = new Date().toISOString()

      if (!existing) {
        const id = randomUUID()
        insert.run({ ...input, id, syncedAt })
        return { id, isNew: true, isStale: true }
      }

      const isStale =
        input.receivedAt !== null &&
        (existing.received_at === null || input.receivedAt > existing.received_at)

      db.prepare(
        'UPDATE documents SET filename = ?, mime = ?, received_at = ?, synced_at = ? WHERE id = ?'
      ).run(input.filename, input.mime, input.receivedAt, syncedAt, existing.id)

      return { id: existing.id, isNew: false, isStale }
    },

    get(id: string): DocumentRow | undefined {
      return selectById.get(id) as DocumentRow | undefined
    },

    getByDriveFileId(driveFileId: string): DocumentRow | undefined {
      return selectByDriveId.get(driveFileId) as DocumentRow | undefined
    },

    /** Impronta del layout per un documento elaborato prima che l'elaborazione la calcolasse. */
    setTemplateFingerprint(id: string, fingerprint: string): void {
      db.prepare('UPDATE documents SET template_fingerprint = ? WHERE id = ?').run(fingerprint, id)
    },

    /**
     * Quello che l'elaborazione sa del file: lo sha-256 dei byte e l'impronta del layout.
     * Si riscrivono a ogni elaborazione, perché la copia in cache può essere una versione
     * nuova dello stesso file di Drive.
     */
    setContentIdentity(
      id: string,
      identity: { contentSha256: string; templateFingerprint: string | null }
    ): void {
      db.prepare(
        'UPDATE documents SET content_sha256 = ?, template_fingerprint = ? WHERE id = ?'
      ).run(identity.contentSha256, identity.templateFingerprint, id)
    },

    setCachedPath(id: string, cachedPath: string | null): void {
      db.prepare('UPDATE documents SET cached_path = ? WHERE id = ?').run(cachedPath, id)
    },

    setExtraction(id: string, update: ExtractionUpdate): void {
      db.prepare(`
        UPDATE documents
           SET document_type = ?, type_confidence = ?, confidence = ?,
               confidence_band = ?, text_source = ?
         WHERE id = ?
      `).run(
        update.documentType,
        update.typeConfidence,
        update.confidence,
        update.confidenceBand,
        update.textSource,
        id
      )
    },

    /** Assegnazione manuale del tipo dalla UI: la confidence del tipo diventa nulla. */
    setType(id: string, documentType: string | null, typeConfidence: number | null): void {
      db.prepare('UPDATE documents SET document_type = ?, type_confidence = ? WHERE id = ?').run(
        documentType,
        typeConfidence,
        id
      )
    },

    setStatus(id: string, status: QueueStatus): void {
      db.prepare('UPDATE documents SET status = ? WHERE id = ?').run(status, id)
    },

    /**
     * Esito del revisore: lo stato, il momento in cui è stato deciso e la nota.
     *
     * La nota si sovrascrive a ogni decisione, anche con `null`: riaprire un documento e
     * richiuderlo senza scrivere niente vuol dire che la nota di prima non vale più.
     */
    setReviewOutcome(
      id: string,
      status: QueueStatus,
      reviewedAt: string,
      note: string | null = null
    ): void {
      db.prepare(
        'UPDATE documents SET status = ?, reviewed_at = ?, review_note = ? WHERE id = ?'
      ).run(status, reviewedAt, note, id)
    },

    /** Esito del classificatore, come JSON di `TypeClassification` senza etichette. */
    setClassification(id: string, classification: StoredTypeClassification | null): void {
      db.prepare('UPDATE documents SET classification_json = ? WHERE id = ?').run(
        classification ? JSON.stringify(classification) : null,
        id
      )
    },

    setConfidence(id: string, confidence: number, band: ConfidenceBand): void {
      db.prepare('UPDATE documents SET confidence = ?, confidence_band = ? WHERE id = ?').run(
        confidence,
        band,
        id
      )
    },

    /**
     * Elenco filtrato. `query` è una ricerca FTS5: quando c'è, restringe ai documenti
     * che hanno almeno una pagina (o il filename) che corrisponde.
     */
    list(filters: DocumentFilters = {}, ftsDocumentIds?: string[]): DocumentRow[] {
      const where: string[] = []
      const params: unknown[] = []

      if (filters.status) {
        where.push('status = ?')
        params.push(filters.status)
      }
      if (filters.documentType) {
        where.push(
          filters.documentType === '__none__' ? 'document_type IS NULL' : 'document_type = ?'
        )
        if (filters.documentType !== '__none__') params.push(filters.documentType)
      }
      if (filters.band) {
        where.push('COALESCE(confidence_band, ?) = ?')
        params.push('LOW', filters.band)
      }
      if (ftsDocumentIds) {
        if (ftsDocumentIds.length === 0) return []
        where.push(`id IN (${ftsDocumentIds.map(() => '?').join(', ')})`)
        params.push(...ftsDocumentIds)
      }

      const sql = `
        SELECT * FROM documents
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY COALESCE(received_at, synced_at) DESC, filename ASC
      `
      return db.prepare(sql).all(...params) as DocumentRow[]
    },

    counts(): {
      total: number
      needsReview: number
      lowConfidence: number
      untyped: number
    } {
      const row = db
        .prepare(`
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'NEEDS_REVIEW' THEN 1 ELSE 0 END) AS needsReview,
            SUM(CASE WHEN COALESCE(confidence_band, 'LOW') = 'LOW' THEN 1 ELSE 0 END) AS lowConfidence,
            SUM(CASE WHEN document_type IS NULL THEN 1 ELSE 0 END) AS untyped
          FROM documents
        `)
        .get() as Record<string, number | null>
      return {
        total: row.total ?? 0,
        needsReview: row.needsReview ?? 0,
        lowConfidence: row.lowConfidence ?? 0,
        untyped: row.untyped ?? 0
      }
    },

    distinctTypes(): Array<{ documentType: string; count: number }> {
      return db
        .prepare(`
          SELECT document_type AS documentType, COUNT(*) AS count
            FROM documents
           WHERE document_type IS NOT NULL
        GROUP BY document_type
        ORDER BY documentType
        `)
        .all() as Array<{ documentType: string; count: number }>
    },

    delete(id: string): void {
      db.prepare('DELETE FROM documents WHERE id = ?').run(id)
    }
  }
}

export type DocumentsDao = ReturnType<typeof createDocumentsDao>
