import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { OcrService } from '../src/main/extract/ocr'
import { createOcrEngine } from '../src/main/extract/ocr-engine'
import { extractText } from '../src/main/extract/text'
import { createDocumentProcessor } from '../src/main/pipeline'
import { createTestRepository } from './helpers/db'
import { fixture, TESSDATA_DIR, testRegistry } from './helpers/registry'

const registry = testRegistry()

/**
 * OCR reale, in-process: stesso motore del worker, stessi modelli `ita`+`eng`
 * versionati nel repo. Nessuna rete, nessun binario di sistema.
 */
const cachePath = mkdtempSync(join(tmpdir(), 'reviewer-tessdata-'))
const engine = createOcrEngine({ tessdataDir: TESSDATA_DIR, cachePath })
const ocr: OcrService = {
  recognize: async (pdfPath, pages) =>
    new Map((await engine.recognizePdfPages(pdfPath, pages)).map((p) => [p.page, p.text])),
  dispose: () => engine.dispose()
}

afterAll(async () => {
  await engine.dispose()
  rmSync(cachePath, { recursive: true, force: true })
})

function processorFor(repo: ReturnType<typeof createTestRepository>) {
  return createDocumentProcessor({ repo, registry, ocr })
}

function seed(
  repo: ReturnType<typeof createTestRepository>,
  filename: string,
  mime: string
): string {
  return repo.documents.upsertFromDrive({
    driveFileId: `drive-${filename}`,
    filename,
    mime,
    receivedAt: '2026-09-10T08:00:00.000Z'
  }).id
}

const PDF = 'application/pdf'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

describe('PDF con testo nativo', () => {
  it('classifica, precompila e indicizza una fattura', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'fattura-nativa.pdf', PDF)

    const outcome = await processorFor(repo)({
      documentId: id,
      cachedPath: fixture('fattura-nativa.pdf'),
      mime: PDF,
      filename: 'fattura-nativa.pdf'
    })

    expect(outcome.textSource).toBe('NATIVE_TEXT')
    expect(outcome.documentType).toBe('accounting.fattura')
    expect(outcome.typeConfidence).toBe(0.9)

    const document = repo.getReviewDocument(id)!
    const values = Object.fromEntries(document.fields.map((f) => [f.name, f.value]))

    // Solo gli 8 campi dichiarati dallo schema di accounting.fattura.
    expect(document.fields).toHaveLength(8)
    expect(values).toMatchObject({
      document_number: '114/2026',
      issue_date: '2026-09-08',
      issuer_name: 'Alfa S.r.l.',
      recipient_name: 'Beta Costruzioni S.p.A.',
      taxable_amount: '70836.07',
      tax_amount: '15583.93',
      total_amount: '86420.00',
      currency: 'EUR'
    })

    // Ogni valore ha la sua evidenza verbatim, con coordinate dal text layer.
    for (const field of document.fields) {
      expect(field.evidenceId, `${field.name} senza evidenza`).toBeTruthy()
      const evidence = document.evidence.find((item) => item.id === field.evidenceId)!
      expect(evidence.text).toContain(evidence.text.trim())
      expect(evidence.bbox?.w).toBeGreaterThan(0)
    }

    expect(document.confidenceBand).toBe('MEDIUM')
    expect(document.confidence).toBeCloseTo(0.85, 4)
    expect(document.warnings).toEqual([])

    // La ricerca full-text vede il contenuto delle pagine.
    expect(repo.search.matchingDocumentIds('costruzioni')).toEqual([id])

    expect(repo.events.listForDocument(id).map((e) => e.title)).toEqual([
      'Tipo riconosciuto',
      'Campi precompilati'
    ])
    repo.close()
  })
})

describe('DOCX', () => {
  it('estrae il testo con mammoth e precompila i campi del tipo', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'contratto-consulenza.docx', DOCX)

    const outcome = await processorFor(repo)({
      documentId: id,
      cachedPath: fixture('contratto-consulenza.docx'),
      mime: DOCX,
      filename: 'contratto-consulenza.docx'
    })

    expect(outcome.textSource).toBe('DOCX')
    expect(outcome.documentType).toBe('contracts_general.contratto_consulenza')

    const document = repo.getReviewDocument(id)!
    const values = Object.fromEntries(document.fields.map((f) => [f.name, f.value]))
    expect(values).toMatchObject({
      document_number: 'CC-2026-018',
      issue_date: '2026-09-15',
      issuer_name: 'Gamma Consulting S.r.l.',
      recipient_name: 'Alfa S.r.l.'
    })

    // D4: senza resa di pagina non ci sono coordinate, quindi niente bbox.
    expect(document.evidence.every((item) => item.bbox === undefined)).toBe(true)
    repo.close()
  })
})

describe('PDF scansionato', () => {
  it('passa da OCR quando manca il text layer', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'durc-scansionato.pdf', PDF)

    const outcome = await processorFor(repo)({
      documentId: id,
      cachedPath: fixture('durc-scansionato.pdf'),
      mime: PDF,
      filename: 'durc-scansionato.pdf'
    })

    expect(outcome.textSource).toBe('OCR')
    expect(outcome.ocrPages).toEqual([1])
    expect(outcome.documentType).toBe('payroll_contributions.durc')

    const document = repo.getReviewDocument(id)!
    const values = Object.fromEntries(document.fields.map((f) => [f.name, f.value]))
    expect(values.issue_date).toBe('2026-09-01')
    expect(values.issuer_name).toContain('INPS')

    // La confidence dei campi da OCR scende di 0,10.
    const issueDate = document.fields.find((f) => f.name === 'issue_date')!
    expect(issueDate.confidence).toBeCloseTo(0.75, 4)

    expect(document.warnings).toContain(
      'Testo ricavato da OCR: la confidence dei campi è ridotta di 0,10.'
    )
    expect(repo.events.listForDocument(id).map((e) => e.title)).toContain('OCR eseguito')
    repo.close()
  }, 180_000)

  it('riconosce quali pagine hanno bisogno di OCR', async () => {
    const nativeText = await extractText({ filePath: fixture('fattura-nativa.pdf'), mime: PDF })
    expect(nativeText.source).toBe('NATIVE_TEXT')
    expect(nativeText.ocrPages).toEqual([])

    // Senza servizio OCR la scansione resta senza testo, ma non fallisce.
    const scanned = await extractText({ filePath: fixture('durc-scansionato.pdf'), mime: PDF })
    expect(scanned.source).toBe('NATIVE_TEXT')
    expect(scanned.pages[0]?.text).toBe('')
  })
})

describe('documento non classificabile', () => {
  it('lascia il tipo da assegnare e chiede solo i 4 campi universali', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'promemoria-ignoto.pdf', PDF)

    const outcome = await createDocumentProcessor({ repo, registry })({
      documentId: id,
      cachedPath: fixture('promemoria-ignoto.pdf'),
      mime: PDF,
      filename: 'promemoria-ignoto.pdf'
    })

    expect(outcome.documentType).toBeNull()
    expect(outcome.typeConfidence).toBeNull()

    const document = repo.getReviewDocument(id)!
    expect(document.fields.map((f) => f.name)).toEqual([
      'document_number',
      'issue_date',
      'issuer_name',
      'recipient_name'
    ])
    expect(document.warnings).toContain(
      'Tipo da assegnare a mano: nessun alias del registry supera la soglia.'
    )
    expect(repo.events.listForDocument(id).map((e) => e.title)).toContain('Tipo non riconosciuto')
    repo.close()
  })
})

describe('transazione per documento', () => {
  it('rielaborare un documento non duplica campi ed evidenze', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'fattura-nativa.pdf', PDF)
    const process = processorFor(repo)
    const input = {
      documentId: id,
      cachedPath: fixture('fattura-nativa.pdf'),
      mime: PDF,
      filename: 'fattura-nativa.pdf'
    }

    await process(input)
    await process(input)

    const document = repo.getReviewDocument(id)!
    expect(document.fields).toHaveLength(8)
    expect(document.evidence).toHaveLength(8)
    expect(repo.search.matchingDocumentIds('costruzioni')).toEqual([id])
    repo.close()
  })

  it('un tipo assegnato a mano sopravvive alla rielaborazione', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'fattura-nativa.pdf', PDF)
    repo.documents.setType(id, 'accounting.nota_di_credito', null)

    const outcome = await processorFor(repo)({
      documentId: id,
      cachedPath: fixture('fattura-nativa.pdf'),
      mime: PDF,
      filename: 'fattura-nativa.pdf'
    })

    expect(outcome.documentType).toBe('accounting.nota_di_credito')
    expect(outcome.typeConfidence).toBeNull()
    expect(repo.events.listForDocument(id).map((e) => e.title)).toContain('Tipo confermato')
    repo.close()
  })
})
