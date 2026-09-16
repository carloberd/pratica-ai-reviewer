import { randomUUID } from 'node:crypto'
import type { Db } from '../index'
import type { ExtractionRunRow } from '../rows'

export type ExtractionRunStatus = 'COMPLETED' | 'SKIPPED_UNKNOWN_TYPE' | 'SKIPPED_NO_PROFILE'

export interface ExtractionRunInput {
  engineVersion: string
  schemaVersion: string
  /** Vuoto quando il tipo non è stato riconosciuto e l'estrazione non è partita. */
  documentType: string
  startedAt: string
  completedAt: string
  status: ExtractionRunStatus
  missingRequired: string[]
  conflicts: string[]
  metrics: Record<string, unknown>
}

/**
 * Un rigo per ogni esecuzione del motore v2 su un documento. Le righe si accumulano:
 * sono lo storico per misurare i profili, non lo stato corrente dei campi.
 */
export function createExtractionRunsDao(db: Db) {
  const insert = db.prepare(`
    INSERT INTO extraction_runs (id, document_id, engine_version, schema_version, document_type,
                                 started_at, completed_at, status, missing_required_json,
                                 conflicts_json, metrics_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  return {
    add(documentId: string, run: ExtractionRunInput): string {
      const id = randomUUID()
      insert.run(
        id,
        documentId,
        run.engineVersion,
        run.schemaVersion,
        run.documentType,
        run.startedAt,
        run.completedAt,
        run.status,
        JSON.stringify(run.missingRequired),
        JSON.stringify(run.conflicts),
        JSON.stringify(run.metrics)
      )
      return id
    },

    /** Dal più recente. */
    listForDocument(documentId: string): ExtractionRunRow[] {
      return db
        .prepare(
          'SELECT * FROM extraction_runs WHERE document_id = ? ORDER BY started_at DESC, rowid DESC'
        )
        .all(documentId) as ExtractionRunRow[]
    },

    /** Il documento è già passato da questa versione del motore con questi profili. */
    hasRun(documentId: string, engineVersion: string, schemaVersion: string): boolean {
      return (
        db
          .prepare(
            'SELECT 1 FROM extraction_runs WHERE document_id = ? AND engine_version = ? AND schema_version = ? LIMIT 1'
          )
          .get(documentId, engineVersion, schemaVersion) !== undefined
      )
    }
  }
}

export type ExtractionRunsDao = ReturnType<typeof createExtractionRunsDao>
