import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/db'
import { createRepository } from '../src/main/db/repository'
import { exportAnnotatedPdf, writeAnnotatedPdf } from '../src/main/export/annotated-pdf'
import { createTestRepository, seedDocument } from './helpers/db'
import { fixture } from './helpers/registry'

let workspace: string | null = null

function dir(): string {
  workspace ??= mkdtempSync(join(tmpdir(), 'reviewer-annotations-'))
  return workspace
}

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true })
  workspace = null
})

describe('annotazioni su disco', () => {
  it('sopravvivono al riavvio dell applicazione', () => {
    const file = join(dir(), 'reviewer.db')

    // Prima sessione: crea il documento e due annotazioni.
    const first = openDatabase({ file })
    const repoA = createRepository(first)
    const { id } = repoA.documents.upsertFromDrive({
      driveFileId: 'drive-1',
      filename: 'fattura.pdf',
      mime: 'application/pdf',
      receivedAt: null
    })
    repoA.annotations.add({
      documentId: id,
      page: 1,
      bbox: { x: 56, y: 110, w: 190, h: 12 },
      kind: 'highlight'
    })
    repoA.annotations.add({
      documentId: id,
      page: 2,
      bbox: { x: 60, y: 300, w: 120, h: 40 },
      kind: 'note',
      note: 'controllare il totale con il cliente'
    })
    first.close()

    // Seconda sessione: stesso file, niente migrazioni nuove, annotazioni intatte.
    const second = openDatabase({ file })
    const repoB = createRepository(second)
    const restored = repoB.listAnnotations(id)

    expect(restored).toHaveLength(2)
    expect(restored[0]).toMatchObject({
      page: 1,
      kind: 'highlight',
      bbox: { x: 56, y: 110, w: 190, h: 12 }
    })
    expect(restored[1]?.note).toBe('controllare il totale con il cliente')
    second.close()
  })

  it('non tocca il documento: rielaborare i campi lascia le annotazioni al loro posto', () => {
    const repo = createTestRepository()
    const id = seedDocument(repo)
    repo.annotations.add({
      documentId: id,
      page: 1,
      bbox: { x: 10, y: 20, w: 30, h: 40 },
      kind: 'highlight'
    })

    repo.evidence.replaceForDocument(id, [{ page: 1, text: 'riga', confidence: 0.8 }])
    repo.fields.replaceForDocument(id, [
      { name: 'amount', label: 'Importo', value: '10.00', confidence: 0.8 }
    ])

    expect(repo.listAnnotations(id)).toHaveLength(1)
    repo.close()
  })
})

describe('export del PDF annotato', () => {
  it('produce una copia valida, con una pagina di riepilogo, senza toccare la sorgente', async () => {
    const source = fixture('fattura-nativa.pdf')
    const before = await readFile(source)

    const bytes = await exportAnnotatedPdf(
      source,
      [
        {
          id: 'a1',
          documentId: 'd1',
          page: 1,
          bbox: { x: 56, y: 110, w: 190, h: 12 },
          kind: 'highlight',
          createdAt: '2026-09-15T10:00:00.000Z',
          updatedAt: '2026-09-15T10:00:00.000Z'
        },
        {
          id: 'a2',
          documentId: 'd1',
          page: 1,
          bbox: { x: 56, y: 350, w: 180, h: 12 },
          kind: 'note',
          note: 'totale da confrontare con il preventivo firmato dal cliente',
          createdAt: '2026-09-15T10:01:00.000Z',
          updatedAt: '2026-09-15T10:01:00.000Z'
        }
      ],
      'fattura-nativa.pdf'
    )

    const destination = join(dir(), 'annotato.pdf')
    await writeAnnotatedPdf(destination, bytes)

    const written = await readFile(destination)
    expect(written.subarray(0, 5).toString()).toBe('%PDF-')
    expect(written.byteLength).toBeGreaterThan(before.byteLength)

    // D3: il file sorgente resta identico byte per byte.
    expect(await readFile(source)).toEqual(before)

    // Il PDF esportato è rileggibile e ha una pagina in più per il riepilogo.
    const { extractPdfPages } = await import('../src/main/extract/pdf')
    const pages = await extractPdfPages(destination)
    expect(pages).toHaveLength(2)
    expect(pages[1]?.text).toContain('Annotazioni')
    expect(pages[1]?.text).toContain('preventivo firmato')
  })

  it('esporta anche un documento senza annotazioni', async () => {
    const bytes = await exportAnnotatedPdf(fixture('fattura-nativa.pdf'), [], 'fattura-nativa.pdf')
    const destination = join(dir(), 'vuoto.pdf')
    await writeAnnotatedPdf(destination, bytes)

    const { extractPdfPages } = await import('../src/main/extract/pdf')
    const pages = await extractPdfPages(destination)
    expect(pages[1]?.text).toContain('Nessuna annotazione')
  })

  it('rifiuta un file che non è un PDF', async () => {
    await expect(
      exportAnnotatedPdf(fixture('contratto-consulenza.docx'), [], 'contratto.docx')
    ).rejects.toMatchObject({ code: 'EXTRACTION_FAILED' })
  })
})
