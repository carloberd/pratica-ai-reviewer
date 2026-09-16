import { join } from 'node:path'
import { app } from 'electron'
import { DOCX_MIME } from './drive/client'
import { registryDirectory } from './registry'

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

/** Snapshot del registry: in `resources/` accanto all'app, nel repo in sviluppo. */
export function registryDir(): string {
  return registryDirectory(app.getAppPath(), process.resourcesPath, app.isPackaged)
}

/** Registry v2 (profili, ontologia, segnali del classificatore): sottocartella dello snapshot. */
export function registryV2Dir(): string {
  return join(registryDir(), 'v2')
}

/** Modelli tesseract `ita` e `eng`, versionati nel repo. */
export function tessdataDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'tessdata')
    : join(app.getAppPath(), 'resources', 'tessdata')
}

/** Cache dei modelli tesseract scompattati, fuori dalla cartella dell'app. */
export function tessdataCacheDir(): string {
  return join(app.getPath('userData'), 'tessdata-cache')
}

/** Il worker OCR è un secondo entry point del bundle del main. */
export function ocrWorkerPath(): string {
  return join(__dirname, 'ocr-worker.js')
}
