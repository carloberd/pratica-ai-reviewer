import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { migrate } from '../src/main/db'
import { createRepository } from '../src/main/db/repository'
import type { OcrService } from '../src/main/extract/ocr'
import { createOcrEngine } from '../src/main/extract/ocr-engine'
import { extractText } from '../src/main/extract/text'
import type { ExtractedText } from '../src/main/extract/types'
import type { ExtractionRegistry } from '../src/main/extract/v2/profile-loader'
import { updateFieldValue } from '../src/main/field-edits'
import {
  createDocumentProcessor,
  EXTRACTION_ENGINE_V2_VERSION,
  firstPageFingerprint,
  pagesOf
} from '../src/main/pipeline'
import { templateFingerprint } from '../src/shared/template-fingerprint'
import { createTestRepository, databaseAt } from './helpers/db'
import { fixture, TESSDATA_DIR, testExtractionRegistry } from './helpers/registry'

/**
 * OCR reale, in-process: stesso motore del worker, stessi modelli `ita`+`eng`
 * versionati nel repo. Nessuna rete, nessun binario di sistema.
 */
const cachePath = mkdtempSync(join(tmpdir(), 'reviewer-tessdata-'))
const engine = createOcrEngine({ tessdataDir: TESSDATA_DIR, cachePath })
const ocr: OcrService = {
  recognize: async (pdfPath, pages) =>
    new Map((await engine.recognizePdfPages(pdfPath, pages)).map((p) => [p.page, p])),
  recognizeImage: (image) => engine.recognizeImage(image),
  dispose: () => engine.dispose()
}

afterAll(async () => {
  await engine.dispose()
  rmSync(cachePath, { recursive: true, force: true })
})

type TestRepository = ReturnType<typeof createRepository>

function processorFor(repo: TestRepository, options: { withOcr?: boolean } = {}) {
  return createDocumentProcessor({
    repo,
    ocr: options.withOcr === false ? undefined : ocr,
    extractionRegistry: testExtractionRegistry()
  })
}

/**
 * Un documento con il suo tipo già scelto: il tipo lo assegna il revisore, e senza di lui
 * non c'è una mappa di campi da cercare.
 */
function seed(
  repo: TestRepository,
  filename: string,
  mime: string,
  documentType: string | null = null
): string {
  const { id } = repo.documents.upsertFromDrive({
    driveFileId: `drive-${filename}`,
    filename,
    mime,
    receivedAt: '2026-09-10T08:00:00.000Z'
  })
  if (documentType) repo.documents.setType(id, documentType, null)
  return id
}

function inputFor(id: string, filename: string, mime: string) {
  return { documentId: id, cachedPath: fixture(filename), mime, filename }
}

const FATTURA = 'accounting.fattura'
const CONTRATTO = 'contracts_general.contratto_consulenza'
const DURC = 'payroll_contributions.durc'

const PDF = 'application/pdf'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

describe('PDF con testo nativo', () => {
  it('precompila la fattura con la mappa del suo tipo', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'fattura-nativa.pdf', PDF, FATTURA)

    const outcome = await processorFor(repo)(inputFor(id, 'fattura-nativa.pdf', PDF))

    expect(outcome.documentType).toBe('accounting.fattura')
    // Il tipo lo ha scelto il revisore: non c'è una confidenza da mostrare.
    expect(outcome.typeConfidence).toBeNull()
    expect(outcome).toMatchObject({ filledFields: 10, totalFields: 20, confidence: 0.814 })

    const rows = repo.fields.listForDocument(id)
    expect(rows.map((f) => [f.name, f.role, f.review_status, f.value])).toEqual([
      // `counterparty.role` e `document.direction` non ci sono: il tipo li elenca fra i
      // derivati, e un documento non va più in revisione perché mancano dalla carta.
      ['bank.iban', 'required', 'MISSING', null],
      ['document.issue_date', 'required', 'AUTO_ACCEPTED', '2026-09-08'],
      ['document.number', 'required', 'AUTO_ACCEPTED', '114/2026'],
      ['issuer.name', 'required', 'AUTO_ACCEPTED', 'Alfa S.r.l.'],
      ['issuer.tax_code', 'required', 'MISSING', null],
      // Una partita IVA sola, e l'etichetta non dice di chi è: le due parti la leggono
      // entrambe e vanno in conflitto, invece di indovinare.
      ['issuer.vat_number', 'required', 'CONFLICT', '01234567890'],
      ['money.currency', 'required', 'AUTO_ACCEPTED', 'EUR'],
      ['money.total', 'required', 'AUTO_ACCEPTED', '86420.00'],
      ['payment.due_date', 'required', 'MISSING', null],
      ['recipient.name', 'required', 'AUTO_ACCEPTED', 'Beta Costruzioni S.p.A.'],
      ['recipient.tax_code', 'required', 'MISSING', null],
      ['recipient.vat_number', 'required', 'CONFLICT', '01234567890'],
      ['document.references', 'optional', 'MISSING', null],
      ['invoice.type_code', 'optional', 'MISSING', null],
      ['line_items', 'optional', 'MISSING', null],
      ['money.tax', 'optional', 'AUTO_ACCEPTED', '15583.93'],
      ['money.taxable', 'optional', 'AUTO_ACCEPTED', '70836.07'],
      ['procurement.cig', 'optional', 'MISSING', null],
      ['procurement.cup', 'optional', 'MISSING', null],
      ['tax.vat_summary', 'optional', 'MISSING', null]
    ])
    expect(rows.find((f) => f.name === 'line_items')?.cardinality).toBe('many')
    expect(rows.find((f) => f.name === 'money.total')?.semantic_type).toBe('money')

    const document = repo.getReviewDocument(id)!
    expect(document.fields.find((f) => f.name === 'money.total')).toMatchObject({
      label: 'Totale',
      required: true,
      semanticType: 'money'
    })
    // Evidenza verbatim con coordinate per ogni valore, nessuna per i vuoti.
    for (const field of document.fields) {
      if (!field.value) {
        expect(field.evidenceId, `${field.name} vuoto con evidenza`).toBeUndefined()
        continue
      }
      const evidence = document.evidence.find((item) => item.id === field.evidenceId)
      expect(evidence?.bbox?.w, `${field.name} senza evidenza`).toBeGreaterThan(0)
    }
    expect(document.evidence).toHaveLength(10)
    // Quattro obbligatori che questa fattura non scrive, e il documento va in revisione
    // invece di passare come completo. Il ruolo della controparte e la direzione non ci
    // sono più: nessuna fattura li scrive, e chiederli mandava in revisione tutte.
    expect(document.warnings).toEqual([
      'Campi obbligatori senza evidenza: IBAN, Codice fiscale emittente, Scadenza pagamento, Codice fiscale destinatario.'
    ])
    expect(repo.search.matchingDocumentIds('costruzioni')).toEqual([id])

    const events = repo.events.listForDocument(id)
    expect(events.map((e) => e.title)).toEqual(['Tipo confermato', 'Campi precompilati'])
    expect(events[0]?.detail).toBe('Mantenuto il tipo «accounting.fattura» assegnato dal revisore.')
    expect(events[1]?.detail).toMatch(
      /^10 campi su 20 con evidenza verbatim, mappa PRETESTED\. Obbligatori senza evidenza: .*Un conflitto fra candidati da verificare\.$/
    )

    const [run] = repo.extractionRuns.listForDocument(id)
    expect(run).toMatchObject({
      engine_version: EXTRACTION_ENGINE_V2_VERSION,
      schema_version: '3.0.0',
      document_type: 'accounting.fattura',
      status: 'COMPLETED',
      conflicts_json: '["SHARED_EVIDENCE:issuer.vat_number|recipient.vat_number"]'
    })
    expect(JSON.parse(run!.missing_required_json!)).toEqual([
      'bank.iban',
      'issuer.tax_code',
      'payment.due_date',
      'recipient.tax_code'
    ])
    repo.close()
  })
})

describe('un campo del profilo che l’ontologia non descrive', () => {
  /** Lo stesso registry, col profilo della fattura che chiede un campo inesistente. */
  function registryWithGhostField(): ExtractionRegistry {
    const base = testExtractionRegistry()
    const withGhost = (documentType: string) => {
      const profile = base.profile(documentType)
      if (!profile || documentType !== 'accounting.fattura') return profile
      return { ...profile, required_fields: [...profile.required_fields, 'ghost.field'] }
    }
    return { ...base, profile: withGhost, baseProfile: withGhost }
  }

  it('resta nel run, vuoto e fra gli obbligatori mancanti', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'fattura-nativa.pdf', PDF, FATTURA)
    const process = createDocumentProcessor({
      repo,
      ocr,
      extractionRegistry: registryWithGhostField()
    })

    await process(inputFor(id, 'fattura-nativa.pdf', PDF))

    const ghost = repo.fields.listForDocument(id).find((field) => field.name === 'ghost.field')
    expect(ghost).toMatchObject({ value: null, review_status: 'MISSING', role: 'required' })

    const [run] = repo.extractionRuns.listForDocument(id)
    expect(JSON.parse(run!.missing_required_json!)).toContain('ghost.field')
    expect(JSON.parse(run!.conflicts_json!)).toEqual([
      'UNKNOWN_FIELD:ghost.field',
      'SHARED_EVIDENCE:issuer.vat_number|recipient.vat_number'
    ])
    // Prima il campo spariva dal run: copertura piena su un obbligatorio mai cercato.
    expect(JSON.parse(run!.metrics_json!)).toMatchObject({ coverage: 0.48, totalFields: 21 })
    expect(repo.getReviewDocument(id)!.warnings[0]).toContain('ghost.field')
    repo.close()
  })
})

describe('DOCX', () => {
  it('precompila il contratto col suo profilo, senza numero richiesto', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'contratto-consulenza.docx', DOCX, CONTRATTO)

    const outcome = await processorFor(repo)(inputFor(id, 'contratto-consulenza.docx', DOCX))

    expect(outcome.documentType).toBe('contracts_general.contratto_consulenza')
    const rows = repo.fields.listForDocument(id)
    const values = Object.fromEntries(rows.map((f) => [f.name, f.value]))
    expect(values).toMatchObject({
      'document.number': 'CC-2026-018',
      'document.issue_date': '2026-09-15',
      'issuer.name': 'Gamma Consulting S.r.l.',
      'recipient.name': 'Alfa S.r.l.',
      'contract.parties': null
    })
    // Un DOCX non ha coordinate: l'evidenza è la riga, senza riquadro.
    expect(repo.getReviewDocument(id)!.evidence.every((item) => item.bbox === undefined)).toBe(true)
    repo.close()
  })
})

describe('PDF scansionato', () => {
  it('estrae da OCR, manda i valori in revisione e segnala gli obbligatori mancanti', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'durc-scansionato.pdf', PDF, DURC)

    const outcome = await processorFor(repo)(inputFor(id, 'durc-scansionato.pdf', PDF))

    expect(outcome.textSource).toBe('OCR')
    expect(outcome.documentType).toBe('payroll_contributions.durc')

    const rows = repo.fields.listForDocument(id)
    const byName = Object.fromEntries(rows.map((f) => [f.name, f]))
    expect(byName['document.protocol_number']).toMatchObject({
      value: '2026/554321',
      review_status: 'NEEDS_REVIEW',
      confidence: 0.75
    })
    expect(byName['document.issue_date']?.value).toBe('2026-09-01')
    expect(byName['issuer.name']?.value).toContain('INPS')
    // Il protocollo non si duplica nel numero documento: la mappa del DURC non lo chiede.
    expect(byName['document.number']).toBeUndefined()

    const document = repo.getReviewDocument(id)!
    expect(document.warnings[0]).toBe(
      'Pagine lette con OCR: la confidence dei campi che vengono da quelle pagine è ridotta di 0,10.'
    )
    expect(document.warnings[1]).toContain('Campi obbligatori senza evidenza:')
    expect(repo.events.listForDocument(id).map((e) => e.title)).toEqual([
      'OCR eseguito',
      'Tipo confermato',
      'Campi precompilati'
    ])
    expect(JSON.parse(repo.extractionRuns.listForDocument(id)[0]!.missing_required_json!)).toEqual([
      'company.name',
      'company.tax_code',
      'company.vat_number',
      'document.expiry_date',
      'document.outcome'
    ])
    repo.close()
  }, 180_000)
})

describe('pagine scansionate che l’OCR non ha letto', () => {
  it('non passa per letto: run FAILED_OCR, avviso in scheda e evento', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'durc-scansionato.pdf', PDF, DURC)

    const outcome = await processorFor(repo, { withOcr: false })(
      inputFor(id, 'durc-scansionato.pdf', PDF)
    )

    expect(outcome.textSource).toBe('OCR_FAILED')
    expect(repo.documents.get(id)!.text_source).toBe('OCR_FAILED')

    const [run] = repo.extractionRuns.listForDocument(id)
    expect(run?.status).toBe('FAILED_OCR')
    expect(JSON.parse(run!.metrics_json!)).toMatchObject({
      textSource: 'OCR_FAILED',
      ocrFailedPages: [1]
    })

    expect(repo.events.listForDocument(id).map((e) => e.title)).toContain('OCR non riuscito')
    expect(repo.getReviewDocument(id)!.warnings).toContain(
      'Pagine scansionate che l’OCR non ha letto: i campi sono incompleti. Il documento viene ripassato al prossimo avvio con l’OCR disponibile.'
    )
    // Niente impronta: una pagina vuota non è un layout da riconoscere.
    expect(repo.documents.get(id)!.template_fingerprint).toBeNull()
    repo.close()
  })
})

describe('documento senza tipo', () => {
  it('resta senza campi, senza evidenze e col motivo nella timeline', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'promemoria-ignoto.pdf', PDF)

    const outcome = await processorFor(repo)(inputFor(id, 'promemoria-ignoto.pdf', PDF))

    expect(outcome).toMatchObject({
      documentType: null,
      typeConfidence: null,
      confidence: 0,
      filledFields: 0,
      totalFields: 0
    })
    const document = repo.getReviewDocument(id)!
    expect(document.fields).toEqual([])
    expect(document.evidence).toEqual([])
    expect(document.confidenceBand).toBe('LOW')
    expect(document.warnings).toEqual([
      'Tipo da assegnare a mano: nessun alias del registry supera la soglia.'
    ])
    expect(repo.events.listForDocument(id).map((e) => [e.title, e.detail])).toEqual([
      [
        'Campi non estratti',
        'Senza tipo non c’è una mappa di campi da cercare. I campi si precompilano quando il revisore assegna il tipo.'
      ]
    ])
    expect(repo.extractionRuns.listForDocument(id)).toMatchObject([
      { status: 'SKIPPED_UNKNOWN_TYPE', document_type: '' }
    ])
    repo.close()
  })

  it('assegnato il tipo, si precompila con la mappa di quel tipo', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'promemoria-ignoto.pdf', PDF)
    const process = processorFor(repo)
    await process(inputFor(id, 'promemoria-ignoto.pdf', PDF))

    repo.documents.setType(id, 'payments_treasury.richiesta_pagamento', null)
    const outcome = await process(inputFor(id, 'promemoria-ignoto.pdf', PDF))

    expect(outcome).toMatchObject({
      documentType: 'payments_treasury.richiesta_pagamento',
      typeConfidence: null,
      filledFields: 1,
      totalFields: 13
    })
    const values = Object.fromEntries(repo.fields.listForDocument(id).map((f) => [f.name, f.value]))
    expect(values['money.amount']).toBe('1250.00')
    expect(repo.events.listForDocument(id).map((e) => e.title)).toContain('Tipo confermato')
    repo.close()
  })

  it('un tipo che il registry non elenca non fa fallire la rielaborazione', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'promemoria-ignoto.pdf', PDF)
    repo.documents.setType(id, 'promemoria_interno', null)

    const outcome = await processorFor(repo)(inputFor(id, 'promemoria-ignoto.pdf', PDF))

    expect(outcome).toMatchObject({ documentType: 'promemoria_interno', totalFields: 0 })
    expect(repo.fields.listForDocument(id)).toEqual([])
    expect(repo.events.listForDocument(id).at(-1)?.detail).toBe(
      'Il registry non dice quali campi vuole «promemoria_interno»: il tipo è fuori dalle 171 classi della mappa.'
    )
    expect(repo.extractionRuns.listForDocument(id)[0]?.status).toBe('SKIPPED_NO_PROFILE')
    repo.close()
  })
})

describe('rielaborazione e correzioni', () => {
  it('rielaborare non duplica campi ed evidenze, e accumula lo storico dei run', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'fattura-nativa.pdf', PDF, FATTURA)
    const process = processorFor(repo)
    const input = inputFor(id, 'fattura-nativa.pdf', PDF)

    await process(input)
    await process(input)

    const document = repo.getReviewDocument(id)!
    expect(document.fields).toHaveLength(20)
    expect(document.evidence).toHaveLength(10)
    expect(repo.extractionRuns.listForDocument(id)).toHaveLength(2)
    repo.close()
  })

  it('una correzione sopravvive al re-run, anche su un campo che il profilo non ha più', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'fattura-nativa.pdf', PDF, FATTURA)
    const process = processorFor(repo)
    const input = inputFor(id, 'fattura-nativa.pdf', PDF)
    await process(input)

    const number = repo.fields.listForDocument(id).find((f) => f.name === 'document.number')!
    repo.fields.setCorrectedValue(number.id, '114/2026-bis')

    // Il revisore cambia tipo: la mappa della visura non ha i campi CIG/CUP, ma una
    // correzione fatta lì non deve sparire.
    const cig = repo.fields.listForDocument(id).find((f) => f.name === 'procurement.cig')!
    repo.fields.setCorrectedValue(cig.id, 'Z123456789')
    repo.documents.setType(id, 'corporate_registry.visura_camerale', null)
    await process(input)

    const rows = repo.fields.listForDocument(id)
    expect(rows.find((f) => f.name === 'document.number')).toMatchObject({
      value: '114/2026',
      corrected_value: '114/2026-bis',
      role: 'optional'
    })
    expect(rows.find((f) => f.name === 'procurement.cig')).toMatchObject({
      corrected_value: 'Z123456789'
    })
    repo.close()
  })

  it('una correzione fatta col nome v1 sopravvive a migrazione e re-run col v2', async () => {
    // Database di un'installazione esistente, fermo alla 0003, con una fattura già
    // elaborata dal v1 e corretta dal revisore.
    const db = databaseAt('0003')
    db.prepare(
      "INSERT INTO documents (id, drive_file_id, filename, mime, document_type, type_confidence, status, synced_at) VALUES ('doc', 'drive-fattura', 'fattura-nativa.pdf', 'application/pdf', 'accounting.fattura', 0.9, 'NEEDS_REVIEW', '2026-09-10')"
    ).run()
    const field = db.prepare(
      "INSERT INTO fields (id, document_id, name, label, value, corrected_value, confidence, updated_at) VALUES (?, 'doc', ?, ?, ?, ?, 0.85, ?)"
    )
    field.run('f1', 'document_number', 'Numero documento', '114/2026', '114/2026-A', '2026-09-11')
    field.run('f2', 'total_amount', 'Totale', '86420.00', '86420.50', '2026-09-11')
    field.run('f3', 'tax_code', 'Codice fiscale o partita IVA', null, '01234567890', '2026-09-11')

    migrate(db)
    const repo = createRepository(db)
    await processorFor(repo)(inputFor('doc', 'fattura-nativa.pdf', PDF))

    const rows = Object.fromEntries(repo.fields.listForDocument('doc').map((f) => [f.name, f]))
    expect(rows['document.number']).toMatchObject({
      value: '114/2026',
      corrected_value: '114/2026-A',
      updated_at: '2026-09-11'
    })
    expect(rows['money.total']).toMatchObject({ value: '86420.00', corrected_value: '86420.50' })
    // `tax_code` diventa `company.tax_code` (0004 più 0020), che la fattura non chiede:
    // resta a sé, con la correzione addosso.
    expect(rows['company.tax_code']).toMatchObject({ corrected_value: '01234567890' })
    expect(rows.document_number).toBeUndefined()
    db.close()
  })
})

describe('il testo su cui si ritrovano le selezioni', () => {
  it('salva hash del file, righe con coordinate e impronta della prima pagina', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'fattura-nativa.pdf', PDF, FATTURA)
    await processorFor(repo)(inputFor(id, 'fattura-nativa.pdf', PDF))

    const extracted = await extractText({ filePath: fixture('fattura-nativa.pdf'), mime: PDF })
    const lines = repo.pages.lines(id, 1)
    expect(lines).toEqual(extracted.pages[0]!.lines)
    expect(lines[2]).toEqual({
      text: 'FATTURA n. 114/2026 del 08/09/2026',
      bbox: { x: 56, y: 111, w: 187.71, h: 11 }
    })

    const row = repo.documents.get(id)!
    expect(row.content_sha256).toBe(
      createHash('sha256')
        .update(readFileSync(fixture('fattura-nativa.pdf')))
        .digest('hex')
    )
    // La stessa impronta che l'export ricaverebbe dalle stesse righe.
    expect(row.template_fingerprint).toBe(templateFingerprint(lines.map((line) => line.text)))
    expect(repo.getReviewDocument(id)!.contentSha256).toBe(row.content_sha256)
    repo.close()
  })

  it('un DOCX ha una pagina sola, di righe senza coordinate', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'contratto-consulenza.docx', DOCX, CONTRATTO)
    await processorFor(repo)(inputFor(id, 'contratto-consulenza.docx', DOCX))

    const lines = repo.pages.lines(id, 1)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((line) => line.bbox === undefined)).toBe(true)
    expect(repo.pages.lines(id, 2)).toEqual([])
    expect(repo.documents.get(id)!.template_fingerprint).not.toBeNull()
    repo.close()
  })

  it('ogni pagina dice da dove viene il suo testo', () => {
    const lines = [{ text: 'riga' }]
    expect(
      pagesOf({
        source: 'OCR',
        ocrPages: [2],
        ocrFailedPages: [3],
        pages: [
          { page: 1, text: 'riga', lines },
          { page: 2, text: 'riga', lines },
          { page: 3, text: '', lines: [] }
        ]
      }).map((page) => [page.page, page.textSource])
    ).toEqual([
      [1, 'NATIVE_TEXT'],
      [2, 'OCR'],
      [3, 'OCR_FAILED']
    ])
    expect(
      pagesOf({
        source: 'DOCX',
        ocrPages: [],
        ocrFailedPages: [],
        pages: [{ page: 1, text: 'riga', lines }]
      })[0]?.textSource
    ).toBe('DOCX')
  })

  it('una prima pagina letta con OCR resta senza impronta: la ricava l’export', () => {
    const page = { page: 1, text: 'DURC', lines: [{ text: 'DURC' }] }
    const of = (extra: Partial<ExtractedText>): ExtractedText => ({
      source: 'NATIVE_TEXT',
      ocrPages: [],
      ocrFailedPages: [],
      pages: [page],
      ...extra
    })
    expect(firstPageFingerprint(of({ source: 'OCR', ocrPages: [1] }))).toBeNull()
    // Nemmeno una prima pagina che l'OCR non ha letto: non è un layout, è una pagina vuota.
    expect(firstPageFingerprint(of({ source: 'OCR_FAILED', ocrFailedPages: [1] }))).toBeNull()
    expect(firstPageFingerprint(of({}))).toBe(templateFingerprint(['DURC']))
    expect(firstPageFingerprint(of({ pages: [] }))).toBeNull()
  })

  it('una selezione resta alla rielaborazione, con la sua posizione', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'fattura-nativa.pdf', PDF, FATTURA)
    const process = processorFor(repo)
    const input = inputFor(id, 'fattura-nativa.pdf', PDF)
    await process(input)

    // «70.836,07» compare due volte: sulla riga della fornitura e su quella del totale
    // imponibile. Il revisore seleziona il secondo, e il riquadro lo distingue.
    const field = repo.getReviewDocument(id)!.fields.find((f) => f.name === 'money.taxable')!
    expect(field.value).toBe('70836.07')
    updateFieldValue(repo, {
      documentId: id,
      fieldId: field.id,
      correctedValue: '70.836,07',
      pick: {
        method: 'TEXT_SELECTION',
        page: 1,
        text: '70.836,07',
        bbox: { x: 172.7, y: 311, w: 47.7, h: 11 }
      }
    })
    await process(input)

    const document = repo.getReviewDocument(id)!
    const after = document.fields.find((f) => f.name === 'money.taxable')!
    expect(after.correctedValue).toBe('70.836,07')
    expect(document.evidence.find((e) => e.id === after.correctedEvidenceId)).toMatchObject({
      origin: 'REVIEWER',
      location: { lineStart: 9, lineEnd: 9, charStart: 254, charEnd: 263 }
    })
    // Le evidenze del motore non si moltiplicano, quella del revisore resta una.
    expect(document.evidence.filter((e) => e.origin === 'REVIEWER')).toHaveLength(1)
    expect(document.evidence.filter((e) => e.origin === 'ENGINE')).toHaveLength(10)
    repo.close()
  })
})
