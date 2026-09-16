import { existsSync } from 'node:fs'
import type { ReviewDocument } from '@shared/types'
import type { Repository } from './db/repository'
import type { DocumentRow } from './db/rows'
import type { DocumentProcessor } from './drive/fetch'
import { logError, ReviewerError } from './errors'
import type { ExtractionRegistryV2 } from './extract/v2/profile-loader'
import { EXTRACTION_ENGINE_V2_VERSION } from './pipeline'

/**
 * Assegnazione manuale del tipo dalla scheda di revisione.
 *
 * Il tipo cambia i campi da cercare, quindi il documento si rielabora subito se la copia
 * locale c'è: col motore v2 un documento non riconosciuto resta senza campi finché
 * qualcuno non gli dà un tipo, e questo è il momento in cui si precompila. La pipeline
 * tratta il tipo come manuale (confidence nulla) e non lo sovrascrive; le correzioni
 * già fatte restano. Togliere il tipo non rielabora: una nuova classificazione
 * automatica rimetterebbe quello che il revisore ha appena tolto.
 */
export async function assignDocumentType(input: {
  repo: Repository
  documentId: string
  documentType: string | null
  process?: DocumentProcessor | undefined
  fileExists?: (path: string) => boolean
}): Promise<ReviewDocument> {
  const { repo, documentId, documentType } = input
  const existing = repo.documents.get(documentId)
  if (!existing) throw new ReviewerError('NOT_FOUND', 'Documento non trovato.')

  repo.transaction(() => {
    // Assegnazione manuale: la confidence del tipo resta nulla, perché non viene
    // da un match del registry ma da una decisione del revisore.
    repo.documents.setType(documentId, documentType, null)
    repo.events.add(
      documentId,
      documentType ? 'Tipo assegnato a mano' : 'Tipo rimosso',
      documentType
        ? `Il revisore ha impostato il tipo «${documentType}».`
        : 'Il revisore ha rimosso il tipo assegnato.'
    )
  })

  const fileExists = input.fileExists ?? existsSync
  if (documentType && input.process && existing.cached_path && fileExists(existing.cached_path)) {
    await input.process({
      documentId,
      cachedPath: existing.cached_path,
      mime: existing.mime,
      filename: existing.filename
    })
  }

  return repo.getReviewDocument(documentId)!
}

/**
 * Un documento ancora in coda che non è mai passato da questa versione del motore v2
 * con questi profili: tipicamente, estratto dal v1 prima dell'aggiornamento. Oppure
 * elaborato prima che la classificazione venisse salvata: senza, la scheda tipo non ha
 * candidati da proporre.
 *
 * I documenti già revisionati o scartati non si toccano: il loro tipo e i loro campi
 * sono il dato consegnato, e una riclassificazione potrebbe cambiarli.
 */
export function needsV2Extraction(
  repo: Repository,
  registry: ExtractionRegistryV2
): (row: DocumentRow) => boolean {
  return (row) =>
    row.status === 'NEEDS_REVIEW' &&
    (row.classification_json === null ||
      !repo.extractionRuns.hasRun(row.id, EXTRACTION_ENGINE_V2_VERSION, registry.schemaVersion()))
}

/**
 * Rielabora in sequenza i documenti in cache che ne hanno bisogno. Un errore su un
 * documento finisce nel log e non ferma gli altri.
 */
export async function reprocessCachedDocuments(input: {
  repo: Repository
  process: DocumentProcessor
  isStale: (row: DocumentRow) => boolean
  fileExists?: (path: string) => boolean
}): Promise<{ processed: string[]; failed: string[] }> {
  const fileExists = input.fileExists ?? existsSync
  const processed: string[] = []
  const failed: string[] = []

  for (const row of input.repo.documents.list()) {
    if (!row.cached_path || !fileExists(row.cached_path) || !input.isStale(row)) continue
    try {
      await input.process({
        documentId: row.id,
        cachedPath: row.cached_path,
        mime: row.mime,
        filename: row.filename
      })
      processed.push(row.id)
    } catch (error) {
      logError('reprocess', error)
      failed.push(row.id)
    }
  }

  return { processed, failed }
}
