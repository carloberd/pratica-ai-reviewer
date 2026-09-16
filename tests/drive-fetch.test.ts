import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DRIVE_QUERY, type DriveClient, type DriveFile } from '../src/main/drive/client'
import { cacheUsage, evictCachedFile, fetchDriveFile } from '../src/main/drive/fetch'
import { createTestRepository } from './helpers/db'

/** Drive è mockato su fixture: i test non toccano la rete né le credenziali. */
function fakeDrive(onDownload?: (id: string, dest: string) => void): DriveClient {
  return {
    listFiles: async () => [],
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

describe('query Drive', () => {
  it('chiede solo PDF e DOCX fuori dal cestino', () => {
    expect(DRIVE_QUERY).toContain("mimeType='application/pdf'")
    expect(DRIVE_QUERY).toContain('wordprocessingml.document')
    expect(DRIVE_QUERY).toContain('trashed=false')
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
      listFiles: async () => [],
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
    repo.annotations.add({
      documentId,
      page: 1,
      bbox: { x: 1, y: 2, w: 3, h: 4 },
      kind: 'highlight'
    })

    const freed = await evictCachedFile(repo, documentId)

    expect(freed).toBeGreaterThan(0)
    expect(existsSync(cachePathFor('f1', PDF))).toBe(false)
    expect(repo.documents.get(documentId)?.cached_path).toBeNull()
    expect(repo.fields.listForDocument(documentId)).toHaveLength(1)
    expect(repo.listAnnotations(documentId)).toHaveLength(1)
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
