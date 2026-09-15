import { join } from 'node:path'
import { app } from 'electron'
import { DOCX_MIME } from './drive/client'

export function databaseFile(): string {
  return join(app.getPath('userData'), 'praticaai-reviewer.db')
}

export function cacheDir(): string {
  return join(app.getPath('userData'), 'cache')
}

/** I file scaricati restano su disco: nel database finiscono solo i path. */
export function cachePathFor(driveFileId: string, mime: string): string {
  const extension = mime === DOCX_MIME ? 'docx' : 'pdf'
  // L'id di Drive è già URL-safe, ma un file id non deve poter uscire dalla cartella.
  const safeId = driveFileId.replace(/[^\w-]/g, '_')
  return join(cacheDir(), `${safeId}.${extension}`)
}
