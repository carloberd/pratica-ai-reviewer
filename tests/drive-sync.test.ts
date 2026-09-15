import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DRIVE_QUERY, type DriveClient, type DriveFile } from '../src/main/drive/client'
import { syncDrive } from '../src/main/drive/sync'
import { createTestRepository } from './helpers/db'

/** Drive è mockato su fixture: i test non toccano la rete né le credenziali. */
function fakeDrive(
  files: DriveFile[],
  onDownload?: (id: string, dest: string) => void
): DriveClient {
  return {
    listFiles: async () => files,
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

describe('sincronizzazione', () => {
  it('crea un documento per file, lo scarica e registra la timeline', async () => {
    const repo = createTestRepository()
    const files: DriveFile[] = [
      {
        id: 'f1',
        name: 'Fattura.pdf',
        mimeType: PDF,
        modifiedTime: '2026-09-01T10:00:00.000Z',
        size: 10
      },
      {
        id: 'f2',
        name: 'Contratto.pdf',
        mimeType: PDF,
        modifiedTime: '2026-09-02T10:00:00.000Z',
        size: 20
      }
    ]

    const result = await syncDrive({ drive: fakeDrive(files), repo, cachePathFor })

    expect(result).toMatchObject({ scanned: 2, added: 2, updated: 0, skipped: 0 })
    expect(repo.listSummaries()).toHaveLength(2)

    const doc = repo.documents.getByDriveFileId('f1')!
    expect(doc.cached_path).toBe(cachePathFor('f1', PDF))
    expect(repo.events.listForDocument(doc.id)[0]?.title).toBe('Documento sincronizzato')
    repo.close()
  })

  it('salta i file già in cache e non li riscarica', async () => {
    const repo = createTestRepository()
    const files: DriveFile[] = [
      {
        id: 'f1',
        name: 'Fattura.pdf',
        mimeType: PDF,
        modifiedTime: '2026-09-01T10:00:00.000Z',
        size: 10
      }
    ]
    const download = vi.fn()

    await syncDrive({ drive: fakeDrive(files, download), repo, cachePathFor })
    const second = await syncDrive({ drive: fakeDrive(files, download), repo, cachePathFor })

    expect(download).toHaveBeenCalledTimes(1)
    expect(second).toMatchObject({ scanned: 1, added: 0, updated: 0, skipped: 1 })
    expect(repo.listSummaries()).toHaveLength(1)
    repo.close()
  })

  it('riscarica quando Drive ha una versione più recente', async () => {
    const repo = createTestRepository()
    const download = vi.fn()
    const first: DriveFile = {
      id: 'f1',
      name: 'Fattura.pdf',
      mimeType: PDF,
      modifiedTime: '2026-09-01T10:00:00.000Z',
      size: 10
    }

    await syncDrive({ drive: fakeDrive([first], download), repo, cachePathFor })
    const result = await syncDrive({
      drive: fakeDrive([{ ...first, modifiedTime: '2026-09-09T10:00:00.000Z' }], download),
      repo,
      cachePathFor
    })

    expect(download).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ added: 0, updated: 1, skipped: 0 })

    const doc = repo.documents.getByDriveFileId('f1')!
    expect(repo.events.listForDocument(doc.id).map((e) => e.title)).toEqual([
      'Documento sincronizzato',
      'Documento aggiornato'
    ])
    repo.close()
  })

  it('un file che fallisce non ferma gli altri', async () => {
    const repo = createTestRepository()
    const drive: DriveClient = {
      listFiles: async () => [
        { id: 'rotto', name: 'Rotto.pdf', mimeType: PDF, modifiedTime: null, size: null },
        { id: 'buono', name: 'Buono.pdf', mimeType: PDF, modifiedTime: null, size: null }
      ],
      download: async (fileId, destination) => {
        if (fileId === 'rotto') throw new Error('download interrotto')
        writeFileSync(destination, 'ok')
      }
    }

    const result = await syncDrive({ drive, repo, cachePathFor })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({ driveFileId: 'rotto', filename: 'Rotto.pdf' })
    expect(repo.documents.getByDriveFileId('buono')?.cached_path).toBeTruthy()
    repo.close()
  })

  it('riporta l avanzamento al chiamante', async () => {
    const repo = createTestRepository()
    const phases: string[] = []

    await syncDrive({
      drive: fakeDrive([
        { id: 'f1', name: 'A.pdf', mimeType: PDF, modifiedTime: null, size: null }
      ]),
      repo,
      cachePathFor,
      onProgress: (progress) => phases.push(progress.phase)
    })

    expect(phases).toEqual(['listing', 'downloading', 'done'])
    repo.close()
  })

  it('esegue l elaborazione solo sui documenti scaricati', async () => {
    const repo = createTestRepository()
    const processed: string[] = []

    const result = await syncDrive({
      drive: fakeDrive([
        { id: 'f1', name: 'A.pdf', mimeType: PDF, modifiedTime: null, size: null },
        { id: 'f2', name: 'B.pdf', mimeType: PDF, modifiedTime: null, size: null }
      ]),
      repo,
      cachePathFor,
      process: async ({ filename }) => {
        processed.push(filename)
      }
    })

    expect(processed).toEqual(['A.pdf', 'B.pdf'])
    expect(result.processed).toBe(2)
    repo.close()
  })
})
