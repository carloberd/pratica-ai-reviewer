import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildListing,
  type DriveClient,
  type DriveFile,
  listingQuery,
  shortcutFileTargets
} from '../src/main/drive/client'
import { cacheUsage, evictCachedFile, fetchDriveFile } from '../src/main/drive/fetch'
import { createTestRepository } from './helpers/db'

/** Drive è mockato su fixture: i test non toccano la rete né le credenziali. */
function fakeDrive(onDownload?: (id: string, dest: string) => void): DriveClient {
  return {
    listFolder: async () => ({ folders: [], files: [] }),
    getFile: async () => null,
    download: async (fileId, destination) => {
      writeFileSync(destination, `contenuto di ${fileId}`)
      onDownload?.(fileId, destination)
    }
  }
}

const PDF = 'application/pdf'
let cacheRoot: string | null = null

function cache(): string {
  cacheRoot ??= mkdtempSync(join(tmpdir(), 'praticaai-reviewer-test-'))
  return cacheRoot
}

const cachePathFor = (driveFileId: string, mime: string) =>
  join(cache(), `${driveFileId}.${mime === PDF ? 'pdf' : 'docx'}`)

function driveFile(overrides: Partial<DriveFile> = {}): DriveFile {
  return {
    id: 'f1',
    name: 'Fattura.pdf',
    mimeType: PDF,
    modifiedTime: '2026-09-01T10:00:00.000Z',
    size: 10,
    ...overrides
  }
}

afterEach(() => {
  if (cacheRoot) rmSync(cacheRoot, { recursive: true, force: true })
  cacheRoot = null
})

const FOLDER = 'application/vnd.google-apps.folder'
const SHORTCUT = 'application/vnd.google-apps.shortcut'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

describe('query Drive', () => {
  it('chiede cartelle, PDF, DOCX e scorciatoie fuori dal cestino', () => {
    const query = listingQuery({ root: 'my-drive', folderId: null })!
    expect(query).toContain("mimeType='application/pdf'")
    expect(query).toContain('wordprocessingml.document')
    expect(query).toContain(`mimeType='${FOLDER}'`)
    expect(query).toContain(`mimeType='${SHORTCUT}'`)
    expect(query).toContain('trashed=false')
  })

  it('la radice di «Il mio Drive» e una cartella sono i loro figli diretti', () => {
    expect(listingQuery({ root: 'my-drive', folderId: null })).toMatch(/^'root' in parents and /)
    expect(listingQuery({ root: 'shared-with-me', folderId: 'abc_1-2' })).toMatch(
      /^'abc_1-2' in parents and /
    )
  })

  it('«Condivisi con me» è un elenco, i Drive condivisi non passano da files.list', () => {
    expect(listingQuery({ root: 'shared-with-me', folderId: null })).toMatch(
      /^sharedWithMe=true and /
    )
    expect(listingQuery({ root: 'shared-drives', folderId: null })).toBeNull()
  })

  it("un apice nell'id non esce dalla stringa della query", () => {
    expect(listingQuery({ root: 'my-drive', folderId: "x' or '1'='1" })).toMatch(
      /^'x\\' or \\'1\\'=\\'1' in parents/
    )
  })
})

describe('contenuto di una cartella', () => {
  it('cartelle in cima, poi i documenti, ciascuno in ordine di nome', () => {
    const listing = buildListing([
      {
        id: 'b',
        name: 'b.pdf',
        mimeType: PDF,
        modifiedTime: '2026-09-01T10:00:00.000Z',
        size: '12'
      },
      { id: 'f2', name: 'Fatture 10', mimeType: FOLDER },
      { id: 'a', name: 'A.docx', mimeType: DOCX },
      { id: 'f1', name: 'Fatture 9', mimeType: FOLDER },
      { id: 'x', name: 'foglio', mimeType: 'application/vnd.google-apps.spreadsheet' }
    ])

    expect(listing.folders.map((folder) => folder.name)).toEqual(['Fatture 9', 'Fatture 10'])
    expect(listing.files.map((file) => file.name)).toEqual(['A.docx', 'b.pdf'])
    expect(listing.files[1]).toEqual({
      id: 'b',
      name: 'b.pdf',
      mimeType: PDF,
      modifiedTime: '2026-09-01T10:00:00.000Z',
      size: 12
    })
  })

  it('una scorciatoia a una cartella si apre come la cartella originale', () => {
    const listing = buildListing([
      {
        id: 's1',
        name: 'Pratiche (scorciatoia)',
        mimeType: SHORTCUT,
        shortcutDetails: { targetId: 'folder-1', targetMimeType: FOLDER }
      }
    ])
    expect(listing.folders).toEqual([
      { id: 'folder-1', name: 'Pratiche (scorciatoia)', modifiedTime: null }
    ])
  })

  it('una scorciatoia a un documento porta i metadati del bersaglio, senza doppioni', () => {
    const entries = [
      {
        id: 's1',
        name: 'Fattura (scorciatoia)',
        mimeType: SHORTCUT,
        shortcutDetails: { targetId: 'f1', targetMimeType: PDF }
      },
      {
        id: 's2',
        name: 'Foglio',
        mimeType: SHORTCUT,
        shortcutDetails: {
          targetId: 'sheet',
          targetMimeType: 'application/vnd.google-apps.spreadsheet'
        }
      },
      {
        id: 's3',
        name: 'Sparito',
        mimeType: SHORTCUT,
        shortcutDetails: { targetId: 'gone', targetMimeType: PDF }
      },
      {
        id: 'f1',
        name: 'Fattura.pdf',
        mimeType: PDF,
        modifiedTime: '2026-09-01T10:00:00.000Z',
        size: '10'
      }
    ]

    expect(shortcutFileTargets(entries)).toEqual(['f1', 'gone'])

    const listing = buildListing(entries, new Map([['f1', driveFile()]]))
    expect(listing.folders).toEqual([])
    expect(listing.files).toEqual([driveFile()])
  })
})

describe('apertura di un file di Drive', () => {
  it('scarica il file, lo elabora e registra la timeline', async () => {
    const repo = createTestRepository()
    const processed: string[] = []

    const result = await fetchDriveFile({
      drive: fakeDrive(),
      repo,
      file: driveFile(),
      cachePathFor,
      process: async ({ filename }) => {
        processed.push(filename)
      }
    })

    expect(result).toMatchObject({ downloaded: true, processed: true })
    expect(processed).toEqual(['Fattura.pdf'])

    const document = repo.documents.get(result.documentId)!
    expect(document.cached_path).toBe(cachePathFor('f1', PDF))
    expect(existsSync(document.cached_path!)).toBe(true)
    expect(repo.events.listForDocument(result.documentId)[0]?.title).toBe('Documento scaricato')
    repo.close()
  })

  it('riaprendo lo stesso file non scarica e non rielabora', async () => {
    const repo = createTestRepository()
    const download = vi.fn()
    const process = vi.fn(async () => {})
    const input = { drive: fakeDrive(download), repo, file: driveFile(), cachePathFor, process }

    const first = await fetchDriveFile(input)
    const second = await fetchDriveFile(input)

    expect(download).toHaveBeenCalledTimes(1)
    expect(process).toHaveBeenCalledTimes(1)
    expect(second).toMatchObject({ documentId: first.documentId, downloaded: false })
    repo.close()
  })

  it('riscarica quando su Drive c è una versione più recente', async () => {
    const repo = createTestRepository()
    const download = vi.fn()

    await fetchDriveFile({ drive: fakeDrive(download), repo, file: driveFile(), cachePathFor })
    const result = await fetchDriveFile({
      drive: fakeDrive(download),
      repo,
      file: driveFile({ modifiedTime: '2026-09-09T10:00:00.000Z' }),
      cachePathFor
    })

    expect(download).toHaveBeenCalledTimes(2)
    expect(result.downloaded).toBe(true)
    expect(repo.events.listForDocument(result.documentId).map((e) => e.title)).toEqual([
      'Documento scaricato',
      'Documento aggiornato'
    ])
    repo.close()
  })

  it('con force riscarica anche una copia già allineata', async () => {
    const repo = createTestRepository()
    const download = vi.fn()

    await fetchDriveFile({ drive: fakeDrive(download), repo, file: driveFile(), cachePathFor })
    await fetchDriveFile({
      drive: fakeDrive(download),
      repo,
      file: driveFile(),
      cachePathFor,
      force: true
    })

    expect(download).toHaveBeenCalledTimes(2)
    repo.close()
  })

  it('riporta l avanzamento di quel singolo file', async () => {
    const repo = createTestRepository()
    const phases: string[] = []

    await fetchDriveFile({
      drive: fakeDrive(),
      repo,
      file: driveFile(),
      cachePathFor,
      process: async () => {},
      onProgress: (progress) => phases.push(progress.phase)
    })

    expect(phases).toEqual(['downloading', 'extracting', 'done'])
    repo.close()
  })

  it('se il download fallisce non resta un documento con una copia locale falsa', async () => {
    const repo = createTestRepository()
    const drive: DriveClient = {
      listFolder: async () => ({ folders: [], files: [] }),
      getFile: async () => null,
      download: async () => {
        throw new Error('download interrotto')
      }
    }

    await expect(fetchDriveFile({ drive, repo, file: driveFile(), cachePathFor })).rejects.toThrow(
      'download interrotto'
    )

    expect(repo.documents.getByDriveFileId('f1')?.cached_path).toBeNull()
    repo.close()
  })
})

describe('gestione della cache', () => {
  it('liberare spazio toglie il file ma non i dati estratti', async () => {
    const repo = createTestRepository()
    const { documentId } = await fetchDriveFile({
      drive: fakeDrive(),
      repo,
      file: driveFile(),
      cachePathFor
    })
    repo.fields.replaceForDocument(documentId, [
      { name: 'total_amount', label: 'Totale', value: '86420.00', confidence: 0.85 }
    ])
    const freed = await evictCachedFile(repo, documentId)

    expect(freed).toBeGreaterThan(0)
    expect(existsSync(cachePathFor('f1', PDF))).toBe(false)
    expect(repo.documents.get(documentId)?.cached_path).toBeNull()
    expect(repo.fields.listForDocument(documentId)).toHaveLength(1)
    expect(repo.events.listForDocument(documentId).at(-1)?.title).toBe('Copia locale rimossa')
    repo.close()
  })

  it('liberare spazio due volte non è un errore', async () => {
    const repo = createTestRepository()
    const { documentId } = await fetchDriveFile({
      drive: fakeDrive(),
      repo,
      file: driveFile(),
      cachePathFor
    })
    await evictCachedFile(repo, documentId)
    await expect(evictCachedFile(repo, documentId)).resolves.toBe(0)
    repo.close()
  })

  it('conta i file in locale e lo spazio che occupano', async () => {
    const repo = createTestRepository()
    await fetchDriveFile({ drive: fakeDrive(), repo, file: driveFile(), cachePathFor })
    await fetchDriveFile({
      drive: fakeDrive(),
      repo,
      file: driveFile({ id: 'f2', name: 'Contratto.pdf' }),
      cachePathFor
    })

    const usage = await cacheUsage(repo)
    expect(usage.files).toBe(2)
    expect(usage.bytes).toBeGreaterThan(0)

    const { documentId } = await fetchDriveFile({
      drive: fakeDrive(),
      repo,
      file: driveFile(),
      cachePathFor
    })
    await evictCachedFile(repo, documentId)
    expect((await cacheUsage(repo)).files).toBe(1)
    repo.close()
  })

  it('non è un errore su un documento inesistente', async () => {
    const repo = createTestRepository()
    await expect(evictCachedFile(repo, 'manca')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    repo.close()
  })
})
