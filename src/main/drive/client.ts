import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { DriveLocation } from '@shared/types'
import type { OAuth2Client } from 'google-auth-library'
import { type drive_v3, google } from 'googleapis'
import { ReviewerError } from '../errors'

export const PDF_MIME = 'application/pdf'
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const SUPPORTED_MIMES = [PDF_MIME, DOCX_MIME] as const
export const FOLDER_MIME = 'application/vnd.google-apps.folder'
export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut'

/**
 * Cosa si vede dentro una cartella: sottocartelle, PDF, DOCX e scorciatoie, niente
 * cestino. Le scorciatoie passano tutte perché il tipo del bersaglio non si filtra in
 * query: quelle che non puntano a una cartella o a un documento cadono dopo.
 */
const LISTED_KINDS = [FOLDER_MIME, PDF_MIME, DOCX_MIME, SHORTCUT_MIME]
  .map((mime) => `mimeType='${mime}'`)
  .join(' or ')

/**
 * La query di `files.list` per una posizione, oppure `null` per la radice dei Drive
 * condivisi, che non è una cartella: i Drive si elencano con `drives.list`.
 */
export function listingQuery(location: DriveLocation): string | null {
  const scope = `(${LISTED_KINDS}) and trashed=false`
  if (location.folderId) return `'${escapeQuery(location.folderId)}' in parents and ${scope}`
  if (location.root === 'my-drive') return `'root' in parents and ${scope}`
  if (location.root === 'shared-with-me') return `sharedWithMe=true and ${scope}`
  return null
}

/** Gli id di Drive non hanno apici, ma la query è una stringa: meglio non fidarsi. */
function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime: string | null
  size: number | null
}

export interface DriveFolder {
  id: string
  name: string
  modifiedTime: string | null
}

export interface DriveFolderListing {
  folders: DriveFolder[]
  files: DriveFile[]
}

export interface DriveClient {
  /** Il contenuto di una sola cartella: niente ricorsione, si scende un livello per volta. */
  listFolder(location: DriveLocation): Promise<DriveFolderListing>
  /** Metadati di un documento, `null` se non c'è più, è nel cestino o non è PDF/DOCX. */
  getFile(fileId: string): Promise<DriveFile | null>
  download(fileId: string, destination: string): Promise<void>
}

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,trashed'
const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS},shortcutDetails(targetId,targetMimeType))`

function isSupported(mime: string | null | undefined): boolean {
  return (SUPPORTED_MIMES as readonly (string | null | undefined)[]).includes(mime)
}

function toDriveFile(file: drive_v3.Schema$File): DriveFile | null {
  if (!file.id || !file.name || !isSupported(file.mimeType) || file.trashed) return null
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType!,
    modifiedTime: file.modifiedTime ?? null,
    size: file.size ? Number(file.size) : null
  }
}

const collator = new Intl.Collator('it', { numeric: true, sensitivity: 'base' })
const byName = (a: { name: string }, b: { name: string }) => collator.compare(a.name, b.name)

/**
 * Da una pagina grezza di `files.list` al contenuto della cartella, come lo mostra Drive:
 * cartelle in cima, poi i documenti, ciascuno in ordine di nome.
 *
 * Una scorciatoia a una cartella diventa quella cartella, col nome della scorciatoia: ci si
 * entra come nell'originale. Una scorciatoia a un documento diventa il documento stesso,
 * con i metadati del bersaglio (`targets`, già letti): la data serve a capire se la copia
 * locale è aggiornata, e quella della scorciatoia non dice niente. Un documento che compare
 * due volte — l'originale e una sua scorciatoia — si mostra una volta sola.
 */
export function buildListing(
  entries: drive_v3.Schema$File[],
  targets: ReadonlyMap<string, DriveFile> = new Map()
): DriveFolderListing {
  const folders = new Map<string, DriveFolder>()
  const files = new Map<string, DriveFile>()

  for (const entry of entries) {
    if (!entry.id || !entry.name || entry.trashed) continue

    if (entry.mimeType === FOLDER_MIME) {
      folders.set(entry.id, {
        id: entry.id,
        name: entry.name,
        modifiedTime: entry.modifiedTime ?? null
      })
      continue
    }

    if (entry.mimeType === SHORTCUT_MIME) {
      const targetId = entry.shortcutDetails?.targetId
      if (!targetId) continue
      if (entry.shortcutDetails?.targetMimeType === FOLDER_MIME) {
        if (!folders.has(targetId)) {
          folders.set(targetId, {
            id: targetId,
            name: entry.name,
            modifiedTime: entry.modifiedTime ?? null
          })
        }
        continue
      }
      const target = targets.get(targetId)
      if (target && !files.has(target.id)) files.set(target.id, target)
      continue
    }

    const file = toDriveFile(entry)
    if (file) files.set(file.id, file)
  }

  return {
    folders: [...folders.values()].sort(byName),
    files: [...files.values()].sort(byName)
  }
}

/** Gli id dei documenti a cui puntano le scorciatoie: vanno letti a parte. */
export function shortcutFileTargets(entries: drive_v3.Schema$File[]): string[] {
  const ids = new Set<string>()
  for (const entry of entries) {
    if (entry.mimeType !== SHORTCUT_MIME || entry.trashed) continue
    const { targetId, targetMimeType } = entry.shortcutDetails ?? {}
    if (targetId && isSupported(targetMimeType)) ids.add(targetId)
  }
  return [...ids]
}

function isNotFound(error: unknown): boolean {
  const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown }
  return status === 404 || code === 404 || code === '404'
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

  async function getFile(fileId: string): Promise<DriveFile | null> {
    try {
      const response = await drive.files.get({
        fileId,
        fields: FILE_FIELDS,
        supportsAllDrives: true
      })
      return toDriveFile(response.data)
    } catch (error) {
      if (isNotFound(error)) return null
      throw wrap(error)
    }
  }

  /** I Drive condivisi di cui l'account fa parte, presentati come cartelle. */
  async function listSharedDrives(): Promise<DriveFolderListing> {
    const folders: DriveFolder[] = []
    let pageToken: string | undefined
    do {
      const response = await drive.drives.list({
        pageSize: 100,
        fields: 'nextPageToken,drives(id,name)',
        ...(pageToken ? { pageToken } : {})
      })
      for (const shared of response.data.drives ?? []) {
        if (shared.id && shared.name) {
          folders.push({ id: shared.id, name: shared.name, modifiedTime: null })
        }
      }
      pageToken = response.data.nextPageToken ?? undefined
    } while (pageToken)
    return { folders: folders.sort(byName), files: [] }
  }

  return {
    /** Listing paginato completo della cartella. Drive non garantisce una pagina sola. */
    async listFolder(location: DriveLocation): Promise<DriveFolderListing> {
      const q = listingQuery(location)

      try {
        if (q === null) return await listSharedDrives()

        const entries: drive_v3.Schema$File[] = []
        let pageToken: string | undefined
        do {
          const response = await drive.files.list({
            q,
            pageSize: 1000,
            fields: LIST_FIELDS,
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
            // Una cartella può stare in un Drive condiviso, anche quando ci si arriva da
            // «Condivisi con me»: il corpus dell'utente da solo non la vedrebbe.
            ...(location.folderId ? { corpora: 'allDrives' } : {}),
            ...(pageToken ? { pageToken } : {})
          })
          entries.push(...(response.data.files ?? []))
          pageToken = response.data.nextPageToken ?? undefined
        } while (pageToken)

        // Una scorciatoia a cui non si ha più accesso sparisce, come su Drive.
        const targets = new Map<string, DriveFile>()
        const resolved = await Promise.all(
          shortcutFileTargets(entries).map((id) => getFile(id).catch(() => null))
        )
        for (const file of resolved) if (file) targets.set(file.id, file)

        return buildListing(entries, targets)
      } catch (error) {
        throw error instanceof ReviewerError ? error : wrap(error)
      }
    },

    getFile,

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
