import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { OAuth2Client } from 'google-auth-library'
import { google } from 'googleapis'
import { ReviewerError } from '../errors'

export const PDF_MIME = 'application/pdf'
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const SUPPORTED_MIMES = [PDF_MIME, DOCX_MIME] as const

/** Solo PDF e DOCX, niente cestino. */
export const DRIVE_QUERY = `(mimeType='${PDF_MIME}' or mimeType='${DOCX_MIME}') and trashed=false`

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime: string | null
  size: number | null
}

export interface DriveClient {
  listFiles(): Promise<DriveFile[]>
  download(fileId: string, destination: string): Promise<void>
}

function wrap(error: unknown): ReviewerError {
  const message = error instanceof Error ? error.message : String(error)
  if (/invalid_grant|unauthorized|invalid_credentials/i.test(message)) {
    return new ReviewerError(
      'AUTH_REQUIRED',
      'La sessione Google non è più valida. Accedi di nuovo.'
    )
  }
  if (/insufficient|forbidden|403/i.test(message)) {
    return new ReviewerError(
      'DRIVE_ERROR',
      "Google Drive ha rifiutato la richiesta. Verifica che l'account abbia autorizzato l'accesso in sola lettura."
    )
  }
  return new ReviewerError('DRIVE_ERROR', `Errore di Google Drive: ${message}`)
}

export function createDriveClient(auth: OAuth2Client): DriveClient {
  const drive = google.drive({ version: 'v3', auth })

  return {
    /** Listing paginato completo. Drive non garantisce una pagina sola. */
    async listFiles(): Promise<DriveFile[]> {
      const files: DriveFile[] = []
      let pageToken: string | undefined

      try {
        do {
          const response = await drive.files.list({
            q: DRIVE_QUERY,
            orderBy: 'modifiedTime desc',
            pageSize: 200,
            fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size)',
            // I file condivisi con l'account, non solo quelli di sua proprietà.
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
            ...(pageToken ? { pageToken } : {})
          })

          for (const file of response.data.files ?? []) {
            if (!file.id || !file.name || !file.mimeType) continue
            files.push({
              id: file.id,
              name: file.name,
              mimeType: file.mimeType,
              modifiedTime: file.modifiedTime ?? null,
              size: file.size ? Number(file.size) : null
            })
          }

          pageToken = response.data.nextPageToken ?? undefined
        } while (pageToken)
      } catch (error) {
        throw wrap(error)
      }

      return files
    },

    /**
     * Scarica in un file temporaneo e poi rinomina: una sincronizzazione interrotta
     * non deve lasciare in cache un PDF troncato che poi fallisce in estrazione.
     */
    async download(fileId: string, destination: string): Promise<void> {
      await mkdir(dirname(destination), { recursive: true })
      const temporary = `${destination}.part`

      try {
        const response = await drive.files.get(
          { fileId, alt: 'media', supportsAllDrives: true },
          { responseType: 'stream' }
        )
        await pipeline(response.data, createWriteStream(temporary))
        await rename(temporary, destination)
      } catch (error) {
        await rm(temporary, { force: true })
        throw wrap(error)
      }
    }
  }
}
