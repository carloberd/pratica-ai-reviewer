import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentProcessor } from '../src/main/drive/fetch'
import { createDocumentProcessor } from '../src/main/pipeline'
import {
  assignDocumentType,
  needsV2Extraction,
  reprocessCachedDocuments
} from '../src/main/reprocess'
import { createTestRepository, seedDocument } from './helpers/db'
import {
  fixture,
  testClassifierConfigV2,
  testLegacyFieldMap,
  testRegistry,
  testRegistryV2
} from './helpers/registry'

let repo: ReturnType<typeof createTestRepository> | null = null

function makeRepo() {
  repo = createTestRepository()
  return repo
}

afterEach(() => {
  repo?.close()
  repo = null
  vi.restoreAllMocks()
})

function v2Processor(r: ReturnType<typeof createTestRepository>) {
  return createDocumentProcessor({
    repo: r,
    registry: testRegistry(),
    engines: { classifier: 'v2', extraction: 'v2' },
    classifierConfigV2: testClassifierConfigV2(),
    extractionRegistryV2: testRegistryV2(),
    legacyFieldMap: testLegacyFieldMap()
  })
}

/** Documento in coda con la copia locale in cache, come dopo il primo doppio clic. */
function cachedDocument(r: ReturnType<typeof createTestRepository>, filename: string): string {
  const id = seedDocument(r, { driveFileId: `drive-${filename}`, filename })
  r.documents.setCachedPath(id, fixture(filename))
  return id
}

describe('assegnazione manuale del tipo', () => {
  it('un documento non riconosciuto si precompila col profilo appena riceve un tipo', async () => {
    const r = makeRepo()
    const process = v2Processor(r)
    const id = cachedDocument(r, 'promemoria-ignoto.pdf')
    await process({
      documentId: id,
      cachedPath: fixture('promemoria-ignoto.pdf'),
      mime: 'application/pdf',
      filename: 'promemoria-ignoto.pdf'
    })
    expect(r.getReviewDocument(id)!.fields).toEqual([])

    const document = await assignDocumentType({
      repo: r,
      documentId: id,
      documentType: 'payments_treasury.richiesta_pagamento',
      process
    })

    expect(document.documentType).toBe('payments_treasury.richiesta_pagamento')
    expect(document.typeConfidence).toBeNull()
    expect(document.fields.find((f) => f.name === 'money.amount')?.value).toBe('1250.00')
    expect(document.timeline.map((item) => item.title)).toEqual([
      'Tipo non riconosciuto',
      'Campi non estratti',
      'Tipo assegnato a mano',
      'Tipo confermato',
      'Campi precompilati'
    ])
  })

  it('togliere il tipo non rielabora: la classificazione rimetterebbe quello tolto', async () => {
    const r = makeRepo()
    const id = cachedDocument(r, 'fattura-nativa.pdf')
    const process = vi.fn<DocumentProcessor>(async () => undefined)

    const document = await assignDocumentType({
      repo: r,
      documentId: id,
      documentType: null,
      process
    })

    expect(process).not.toHaveBeenCalled()
    expect(document.documentType).toBeNull()
    expect(document.timeline.at(-1)?.title).toBe('Tipo rimosso')
  })

  it('senza copia locale salva il tipo e rimanda la precompilazione al prossimo download', async () => {
    const r = makeRepo()
    const id = cachedDocument(r, 'fattura-nativa.pdf')
    const process = vi.fn<DocumentProcessor>(async () => undefined)

    const document = await assignDocumentType({
      repo: r,
      documentId: id,
      documentType: 'accounting.fattura',
      process,
      fileExists: () => false
    })

    expect(process).not.toHaveBeenCalled()
    expect(document.documentType).toBe('accounting.fattura')
  })

  it('passa alla pipeline il file in cache del documento', async () => {
    const r = makeRepo()
    const id = cachedDocument(r, 'fattura-nativa.pdf')
    const process = vi.fn<DocumentProcessor>(async () => undefined)

    await assignDocumentType({
      repo: r,
      documentId: id,
      documentType: 'accounting.fattura',
      process
    })

    expect(process).toHaveBeenCalledWith({
      documentId: id,
      cachedPath: fixture('fattura-nativa.pdf'),
      mime: 'application/pdf',
      filename: 'fattura-nativa.pdf'
    })
  })

  it('un documento inesistente è NOT_FOUND', async () => {
    const r = makeRepo()
    await expect(
      assignDocumentType({ repo: r, documentId: 'nessuno', documentType: 'accounting.fattura' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('documenti da rielaborare col motore v2', () => {
  it('in coda e mai passati da questa versione del motore con questi profili', async () => {
    const r = makeRepo()
    const isStale = needsV2Extraction(r, testRegistryV2())
    const id = cachedDocument(r, 'fattura-nativa.pdf')
    expect(isStale(r.documents.get(id)!)).toBe(true)

    await v2Processor(r)({
      documentId: id,
      cachedPath: fixture('fattura-nativa.pdf'),
      mime: 'application/pdf',
      filename: 'fattura-nativa.pdf'
    })
    expect(isStale(r.documents.get(id)!)).toBe(false)

    // Profili aggiornati: di nuovo da rielaborare.
    const newer = { ...testRegistryV2(), schemaVersion: () => '2.1.0' }
    expect(needsV2Extraction(r, newer)(r.documents.get(id)!)).toBe(true)

    // Elaborato prima che la classificazione si salvasse: senza candidati da proporre.
    r.documents.setClassification(id, null)
    expect(isStale(r.documents.get(id)!)).toBe(true)
  })

  it('un passaggio su un testo incompleto per l’OCR non conta', async () => {
    const r = makeRepo()
    const isStale = needsV2Extraction(r, testRegistryV2())
    const id = cachedDocument(r, 'durc-scansionato.pdf')

    // `v2Processor` non ha un servizio OCR: la pagina scansionata resta senza testo.
    await v2Processor(r)({
      documentId: id,
      cachedPath: fixture('durc-scansionato.pdf'),
      mime: 'application/pdf',
      filename: 'durc-scansionato.pdf'
    })

    expect(r.extractionRuns.listForDocument(id)[0]?.status).toBe('FAILED_OCR')
    expect(r.documents.get(id)!.text_source).toBe('OCR_FAILED')
    // Prima il run valeva come passaggio e il documento non veniva mai ripassato.
    expect(isStale(r.documents.get(id)!)).toBe(true)
  })

  it('i documenti revisionati o scartati non si toccano', () => {
    const r = makeRepo()
    const isStale = needsV2Extraction(r, testRegistryV2())
    const id = cachedDocument(r, 'fattura-nativa.pdf')
    r.documents.setStatus(id, 'REVIEWED')
    expect(isStale(r.documents.get(id)!)).toBe(false)
    r.documents.setStatus(id, 'DISCARDED')
    expect(isStale(r.documents.get(id)!)).toBe(false)
  })

  it('rielabora in sequenza solo quelli in cache, e un errore non ferma gli altri', async () => {
    const r = makeRepo()
    const broken = cachedDocument(r, 'rotto.pdf')
    const ok = cachedDocument(r, 'fattura-nativa.pdf')
    const done = cachedDocument(r, 'contratto-consulenza.docx')
    const evicted = seedDocument(r, { driveFileId: 'drive-evicted', filename: 'evicted.pdf' })
    r.documents.setCachedPath(evicted, '/non/esiste.pdf')
    seedDocument(r, { driveFileId: 'drive-never', filename: 'mai-aperto.pdf' })

    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const process = vi.fn<DocumentProcessor>(async ({ documentId }) => {
      if (documentId === broken) throw new Error('PDF illeggibile')
    })

    const result = await reprocessCachedDocuments({
      repo: r,
      process,
      isStale: (row) => row.id !== done,
      fileExists: (path) => path !== '/non/esiste.pdf'
    })

    expect(result).toEqual({ processed: [ok], failed: [broken] })
    expect(process).toHaveBeenCalledTimes(2)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[reprocess]'))
  })
})
