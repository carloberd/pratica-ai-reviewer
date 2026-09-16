import { existsSync } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import type { Repository } from '../db/repository'
import { ReviewerError } from '../errors'
import type { DriveClient, DriveFile } from './client'

export interface FetchProgress {
  phase: 'downloading' | 'extracting' | 'done'
  filename: string
}

/**
 * Hook di elaborazione: classificazione e precompilazione di un documento. È anche il
 * punto dove, collegando il backend PraticaAI, il fact reader sostituirebbe le
 * euristiche locali.
 */
export type DocumentProcessor = (input: {
  documentId: string
  cachedPath: string
  mime: string
  filename: string
}) => Promise<unknown>

export interface FetchOptions {
  drive: DriveClient
  repo: Repository
  file: DriveFile
  /** Dove finisce la copia locale. Iniettato per tenere `electron` fuori da questo modulo. */
  cachePathFor: (driveFileId: string, mime: string) => string
  process?: DocumentProcessor
  onProgress?: (progress: FetchProgress) => void
  /** Riscarica ed elabora anche se la copia locale è già aggiornata. */
  force?: boolean
}

export interface FetchResult {
  documentId: string
  downloaded: boolean
  processed: boolean
}

/**
 * Porta in locale un singolo file di Drive: lo scarica in cache e lo elabora.
 *
 * Il download è deliberatamente su richiesta, un file per volta. Tirare giù l'intero
 * Drive riempirebbe il disco con documenti che nessuno aprirà: qui si paga solo per
 * quello che si revisiona davvero.
 */
export async function fetchDriveFile(options: FetchOptions): Promise<FetchResult> {
  const { drive, repo, file, onProgress } = options

  const upsert = repo.documents.upsertFromDrive({
    driveFileId: file.id,
    filename: file.name,
    mime: file.mimeType,
    receivedAt: file.modifiedTime
  })

  const cachedPath = options.cachePathFor(file.id, file.mimeType)
  const alreadyLocal = existsSync(cachedPath)
  const needsDownload = options.force || upsert.isNew || upsert.isStale || !alreadyLocal

  if (!needsDownload) {
    // Copia locale già allineata: si apre quella, senza toccare la rete.
    repo.documents.setCachedPath(upsert.id, cachedPath)
    return { documentId: upsert.id, downloaded: false, processed: false }
  }

  onProgress?.({ phase: 'downloading', filename: file.name })
  await drive.download(file.id, cachedPath)
  repo.documents.setCachedPath(upsert.id, cachedPath)

  repo.events.add(
    upsert.id,
    upsert.isNew ? 'Documento scaricato' : 'Documento aggiornato',
    upsert.isNew
      ? `«${file.name}» scaricato da Google Drive nella cache locale.`
      : `Scaricata da Google Drive la versione più recente di «${file.name}».`
  )

  let processed = false
  if (options.process) {
    onProgress?.({ phase: 'extracting', filename: file.name })
    await options.process({
      documentId: upsert.id,
      cachedPath,
      mime: file.mimeType,
      filename: file.name
    })
    processed = true
  }

  onProgress?.({ phase: 'done', filename: file.name })
  return { documentId: upsert.id, downloaded: true, processed }
}

/**
 * Toglie dalla cache la copia locale di un documento.
 *
 * Quello che è stato estratto — tipo, campi, evidenze, timeline — resta
 * nel database: si perde solo il file, che si riscarica al prossimo doppio clic.
 */
export async function evictCachedFile(repo: Repository, documentId: string): Promise<number> {
  const row = repo.documents.get(documentId)
  if (!row) throw new ReviewerError('NOT_FOUND', 'Documento non trovato.')
  if (!row.cached_path) return 0

  let freed = 0
  try {
    freed = (await stat(row.cached_path)).size
  } catch {
    // Il file può essere già sparito: conta come zero byte liberati.
  }

  await rm(row.cached_path, { force: true })
  repo.documents.setCachedPath(documentId, null)
  repo.events.add(
    documentId,
    'Copia locale rimossa',
    `Il file è stato tolto dalla cache. I dati estratti restano; il file si riscarica aprendolo di nuovo.`
  )
  return freed
}

/** Byte occupati dalle copie locali, per la riga di stato dell'elenco Drive. */
export async function cacheUsage(repo: Repository): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  for (const row of repo.documents.list()) {
    if (!row.cached_path) continue
    try {
      bytes += (await stat(row.cached_path)).size
      files += 1
    } catch {
      // Path nel database ma file sparito dal disco: non lo si conta.
    }
  }
  return { files, bytes }
}
