import { existsSync } from 'node:fs'
import type { SyncResult } from '@shared/types'
import type { Repository } from '../db/repository'
import { logError } from '../errors'
import type { DriveClient } from './client'

export interface SyncProgress {
  phase: 'listing' | 'downloading' | 'extracting' | 'done'
  current: number
  total: number
  filename?: string
}

/**
 * Hook di elaborazione: in F2 è vuoto, in F3 diventa classificazione e
 * precompilazione. È anche il punto dove, collegando il backend PraticaAI, il fact
 * reader sostituirebbe le euristiche locali.
 */
export type DocumentProcessor = (input: {
  documentId: string
  cachedPath: string
  mime: string
  filename: string
}) => Promise<void>

export interface SyncOptions {
  drive: DriveClient
  repo: Repository
  /** Dove finisce la copia locale. Iniettato per tenere `electron` fuori da questo modulo. */
  cachePathFor: (driveFileId: string, mime: string) => string
  process?: DocumentProcessor
  onProgress?: (progress: SyncProgress) => void
}

export async function syncDrive(options: SyncOptions): Promise<SyncResult> {
  const { drive, repo, onProgress } = options
  const result: SyncResult = {
    scanned: 0,
    added: 0,
    updated: 0,
    skipped: 0,
    processed: 0,
    errors: []
  }

  onProgress?.({ phase: 'listing', current: 0, total: 0 })
  const files = await drive.listFiles()
  result.scanned = files.length

  let index = 0
  for (const file of files) {
    index += 1
    onProgress?.({
      phase: 'downloading',
      current: index,
      total: files.length,
      filename: file.name
    })

    try {
      const upsert = repo.documents.upsertFromDrive({
        driveFileId: file.id,
        filename: file.name,
        mime: file.mimeType,
        receivedAt: file.modifiedTime
      })

      const cachedPath = options.cachePathFor(file.id, file.mimeType)
      const needsDownload = upsert.isNew || upsert.isStale || !existsSync(cachedPath)

      if (upsert.isNew) {
        result.added += 1
        repo.events.add(
          upsert.id,
          'Documento sincronizzato',
          `«${file.name}» scaricato da Google Drive nella cache locale.`
        )
      } else if (needsDownload) {
        result.updated += 1
        repo.events.add(
          upsert.id,
          'Documento aggiornato',
          `Su Google Drive è disponibile una versione più recente di «${file.name}».`
        )
      } else {
        result.skipped += 1
        continue
      }

      await drive.download(file.id, cachedPath)
      repo.documents.setCachedPath(upsert.id, cachedPath)

      if (options.process) {
        onProgress?.({
          phase: 'extracting',
          current: index,
          total: files.length,
          filename: file.name
        })
        await options.process({
          documentId: upsert.id,
          cachedPath,
          mime: file.mimeType,
          filename: file.name
        })
        result.processed += 1
      }
    } catch (error) {
      // Un documento che fallisce non deve fermare la sincronizzazione degli altri.
      logError('drive.sync', error)
      result.errors.push({
        driveFileId: file.id,
        filename: file.name,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  onProgress?.({ phase: 'done', current: files.length, total: files.length })
  return result
}
