import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { EngineSelection } from '../src/main/config'
import { migrate } from '../src/main/db'
import { createRepository } from '../src/main/db/repository'
import type { OcrService } from '../src/main/extract/ocr'
import { createOcrEngine } from '../src/main/extract/ocr-engine'
import { extractText } from '../src/main/extract/text'
import type { ExtractedText } from '../src/main/extract/types'
import type { ExtractionRegistryV2 } from '../src/main/extract/v2/profile-loader'
import { updateFieldValue } from '../src/main/field-edits'
import {
  createDocumentProcessor,
  EXTRACTION_ENGINE_V2_VERSION,
  firstPageFingerprint,
  pagesOf
} from '../src/main/pipeline'
import { templateFingerprint } from '../src/shared/template-fingerprint'
import { createTestRepository, databaseAt } from './helpers/db'
import {
  fixture,
  TESSDATA_DIR,
  testClassifierConfigV2,
  testLegacyFieldMap,
  testRegistry,
  testRegistryV2
} from './helpers/registry'

const registry = testRegistry()

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

const V1: EngineSelection = { classifier: 'v1', extraction: 'v1' }
const V2: EngineSelection = { classifier: 'v2', extraction: 'v2' }

/** Le dipendenze v2 ci sono sempre, come nell'app: il flag decide quale motore gira. */
function processorFor(
  repo: TestRepository,
  engines: EngineSelection,
  options: { withOcr?: boolean } = {}
) {
  return createDocumentProcessor({
    repo,
    registry,
    ocr: options.withOcr === false ? undefined : ocr,
    engines,
    classifierConfigV2: testClassifierConfigV2(),
    extractionRegistryV2: testRegistryV2(),
    legacyFieldMap: testLegacyFieldMap()
  })
}

function seed(repo: TestRepository, filename: string, mime: string): string {
  return repo.documents.upsertFromDrive({
    driveFileId: `drive-${filename}`,
    filename,
    mime,
    receivedAt: '2026-09-10T08:00:00.000Z'
  }).id
}

function inputFor(id: string, filename: string, mime: string) {
  return { documentId: id, cachedPath: fixture(filename), mime, filename }
}

const PDF = 'application/pdf'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

describe('dipendenze del processore', () => {
  it('un motore v2 senza i suoi dati è un errore alla creazione, non al primo documento', () => {
    const repo = createTestRepository()
    expect(() =>
      createDocumentProcessor({ repo, registry, engines: { classifier: 'v2', extraction: 'v1' } })
    ).toThrow('CLASSIFIER_ENGINE=v2')
    expect(() =>
      createDocumentProcessor({ repo, registry, engines: { classifier: 'v1', extraction: 'v2' } })
    ).toThrow('EXTRACTION_ENGINE=v2')
    expect(() => createDocumentProcessor({ repo, registry, engines: V1 })).not.toThrow()
    repo.close()
  })
})

// ---------------------------------------------------------------------------
// v1: la scappatoia deve comportarsi esattamente come prima
// ---------------------------------------------------------------------------

describe('motore v1 — PDF con testo nativo', () => {
  it('classifica, precompila e indicizza una fattura', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'fattura-nativa.pdf', PDF)

    const outcome = await processorFor(repo, V1)(inputFor(id, 'fattura-nativa.pdf', PDF))

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

    expect(repo.events.listForDocument(id).map((e) => [e.title, e.detail])).toEqual([
      ['Tipo riconosciuto', 'accounting.fattura al 90% da «fattura» in prima pagina.'],
      ['Campi precompilati', '8 campi su 8 con evidenza verbatim.']
    ])

    // Il v1 non scrive i metadati v2 né lo storico dei run.
    expect(
      repo.fields.listForDocument(id).every((f) => f.role === null && f.review_status === null)
    ).toBe(true)
    expect(repo.extractionRuns.listForDocument(id)).toEqual([])
    repo.close()
  })
})

describe('motore v1 — DOCX', () => {
  it('estrae il testo con mammoth e precompila i campi del tipo', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'contratto-consulenza.docx', DOCX)

    const outcome = await processorFor(repo, V1)(inputFor(id, 'contratto-consulenza.docx', DOCX))

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

describe('motore v1 — PDF scansionato', () => {
  it('passa da OCR quando manca il text layer', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'durc-scansionato.pdf', PDF)

    const outcome = await processorFor(repo, V1)(inputFor(id, 'durc-scansionato.pdf', PDF))

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
      'Pagine lette con OCR: la confidence dei campi che vengono da quelle pagine è ridotta di 0,10.'
    )
    expect(repo.events.listForDocument(id).map((e) => e.title)).toContain('OCR eseguito')
    repo.close()
  }, 180_000)

  it('riconosce quali pagine hanno bisogno di OCR', async () => {
    const nativeText = await extractText({ filePath: fixture('fattura-nativa.pdf'), mime: PDF })
    expect(nativeText.source).toBe('NATIVE_TEXT')
    expect(nativeText.ocrPages).toEqual([])
    expect(nativeText.ocrFailedPages).toEqual([])

    // Senza servizio OCR la scansione resta senza testo: l'estrazione non fallisce, ma il
    // documento non può dirsi letto dal text layer.
    const scanned = await extractText({ filePath: fixture('durc-scansionato.pdf'), mime: PDF })
    expect(scanned.source).toBe('OCR_FAILED')
    expect(scanned.ocrFailedPages).toEqual([1])
    expect(scanned.ocrError).toBe('Servizio OCR non disponibile in questo ambiente.')
    expect(scanned.pages[0]?.text).toBe('')
  })

  it('un OCR che fallisce non passa per testo nativo', async () => {
    const failing = {
      recognize: () => Promise.reject(new Error('worker OCR non avviato')),
      recognizeImage: () => Promise.reject(new Error('worker OCR non avviato')),
      dispose: () => Promise.resolve()
    }
    const scanned = await extractText({
      filePath: fixture('durc-scansionato.pdf'),
      mime: PDF,
      ocr: failing
    })
    expect(scanned.source).toBe('OCR_FAILED')
    expect(scanned.ocrPages).toEqual([])
    expect(scanned.ocrFailedPages).toEqual([1])
    expect(scanned.ocrError).toBe('worker OCR non avviato')
  })
})

describe('motore v1 — documento non classificabile', () => {
  it('lascia il tipo da assegnare e chiede solo i 4 campi universali', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'promemoria-ignoto.pdf', PDF)

    const outcome = await processorFor(repo, V1, { withOcr: false })(
      inputFor(id, 'promemoria-ignoto.pdf', PDF)
    )

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
    expect(repo.events.listForDocument(id).map((e) => [e.title, e.detail])).toContainEqual([
      'Tipo non riconosciuto',
      'Nessun alias del registry supera la soglia di 0,75: il tipo va assegnato a mano.'
    ])
    repo.close()
  })
})

describe('motore v1 — transazione per documento', () => {
  it('rielaborare un documento non duplica campi ed evidenze', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'fattura-nativa.pdf', PDF)
    const process = processorFor(repo, V1)
    const input = inputFor(id, 'fattura-nativa.pdf', PDF)

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

    const outcome = await processorFor(repo, V1)(inputFor(id, 'fattura-nativa.pdf', PDF))

    expect(outcome.documentType).toBe('accounting.nota_di_credito')
    expect(outcome.typeConfidence).toBeNull()
    expect(repo.events.listForDocument(id).map((e) => e.title)).toContain('Tipo confermato')
    repo.close()
  })
})

// ---------------------------------------------------------------------------
// v2: il percorso normale
// ---------------------------------------------------------------------------

describe('motore v2 — PDF con testo nativo', () => {
  it('riconosce la fattura e precompila il profilo del tipo', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'fattura-nativa.pdf', PDF)

    const outcome = await processorFor(repo, V2)(inputFor(id, 'fattura-nativa.pdf', PDF))

    expect(outcome.documentType).toBe('accounting.fattura')
    expect(outcome.typeConfidence).toBeGreaterThanOrEqual(0.74)
    expect(outcome).toMatchObject({ filledFields: 10, totalFields: 17, confidence: 0.814 })

    const rows = repo.fields.listForDocument(id)
    expect(rows.map((f) => [f.name, f.role, f.review_status, f.value])).toEqual([
      ['document.number', 'required', 'AUTO_ACCEPTED', '114/2026'],
      ['document.issue_date', 'required', 'AUTO_ACCEPTED', '2026-09-08'],
      ['issuer.name', 'required', 'AUTO_ACCEPTED', 'Alfa S.r.l.'],
      ['recipient.name', 'required', 'AUTO_ACCEPTED', 'Beta Costruzioni S.p.A.'],
      ['money.total', 'required', 'AUTO_ACCEPTED', '86420.00'],
      // Una partita IVA sola, e l'etichetta non dice di chi è: le due parti la leggono
      // entrambe e vanno in conflitto, invece di indovinare.
      ['issuer.vat_number', 'core', 'CONFLICT', '01234567890'],
      ['issuer.tax_code', 'core', 'MISSING', null],
      ['recipient.vat_number', 'core', 'CONFLICT', '01234567890'],
      ['recipient.tax_code', 'core', 'MISSING', null],
      ['money.taxable', 'core', 'AUTO_ACCEPTED', '70836.07'],
      ['money.tax', 'core', 'AUTO_ACCEPTED', '15583.93'],
      ['money.currency', 'core', 'AUTO_ACCEPTED', 'EUR'],
      ['payment.due_date', 'core', 'MISSING', null],
      ['line_items', 'core', 'MISSING', null],
      ['bank.iban', 'conditional', 'MISSING', null],
      ['procurement.cig', 'conditional', 'MISSING', null],
      ['procurement.cup', 'conditional', 'MISSING', null]
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
    expect(document.warnings).toEqual([])
    expect(repo.search.matchingDocumentIds('costruzioni')).toEqual([id])

    const events = repo.events.listForDocument(id)
    expect(events.map((e) => e.title)).toEqual(['Tipo riconosciuto', 'Campi precompilati'])
    expect(events[0]?.detail).toMatch(
      /^accounting\.fattura al 83% col classificatore v2 da «fattura»; nessun altro candidato, margine 0,83\.$/
    )
    expect(events[1]?.detail).toBe(
      '10 campi su 17 con evidenza verbatim, profilo v2 EXTRACTION_SCHEMA_READY_FOR_FIELD_TEST. Un conflitto fra candidati da verificare.'
    )

    const [run] = repo.extractionRuns.listForDocument(id)
    expect(run).toMatchObject({
      engine_version: EXTRACTION_ENGINE_V2_VERSION,
      schema_version: '2.0.4',
      document_type: 'accounting.fattura',
      status: 'COMPLETED',
      missing_required_json: '[]',
      conflicts_json: '["SHARED_EVIDENCE:issuer.vat_number|recipient.vat_number"]'
    })
    // La proposta del classificatore resta sul documento, con la riga da cui viene.
    expect(document.classification).toMatchObject({
      engine: 'v2',
      decision: 'ASSIGN',
      reason: 'OK',
      proposedType: 'accounting.fattura',
      minimumMargin: 0.08,
      candidates: [
        {
          documentType: 'accounting.fattura',
          label: 'fattura',
          signals: [
            {
              source: 'title-zone',
              phrase: 'fattura',
              location: { page: 1, text: 'FATTURA n. 114/2026 del 08/09/2026' }
            },
            // Il nome del file (fixture «fattura-nativa.pdf») conferma, ma non ha una riga.
            { source: 'filename', phrase: 'fattura' }
          ]
        }
      ]
    })
    expect(document.classification?.candidates[0]?.signals[0]?.location?.bbox?.w).toBeGreaterThan(0)

    expect(JSON.parse(run!.metrics_json!)).toMatchObject({
      profileSource: 'V2_EXPLICIT',
      coverage: 0.59,
      filledFields: 10,
      totalFields: 17,
      textSource: 'NATIVE_TEXT',
      reviewStatus: { AUTO_ACCEPTED: 8, CONFLICT: 2, MISSING: 7 },
      classifier: {
        engine: 'v2',
        decision: 'ASSIGN',
        reason: 'OK',
        top: { documentType: 'accounting.fattura' },
        runnerUp: null
      }
    })
    repo.close()
  })
})

describe('motore v2 — un campo del profilo che l’ontologia non descrive', () => {
  /** Lo stesso registry, col profilo della fattura che chiede un campo inesistente. */
  function registryWithGhostField(): ExtractionRegistryV2 {
    const base = testRegistryV2()
    const withGhost = (documentType: string) => {
      const profile = base.profile(documentType)
      if (!profile || documentType !== 'accounting.fattura') return profile
      return { ...profile, required_fields: [...profile.required_fields, 'ghost.field'] }
    }
    return { ...base, profile: withGhost, baseProfile: withGhost }
  }

  it('resta nel run, vuoto e fra gli obbligatori mancanti', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'fattura-nativa.pdf', PDF)
    const process = createDocumentProcessor({
      repo,
      registry,
      engines: V2,
      classifierConfigV2: testClassifierConfigV2(),
      extractionRegistryV2: registryWithGhostField(),
      legacyFieldMap: testLegacyFieldMap()
    })

    await process(inputFor(id, 'fattura-nativa.pdf', PDF))

    const ghost = repo.fields.listForDocument(id).find((field) => field.name === 'ghost.field')
    expect(ghost).toMatchObject({ value: null, review_status: 'MISSING', role: 'required' })

    const [run] = repo.extractionRuns.listForDocument(id)
    expect(JSON.parse(run!.missing_required_json!)).toEqual(['ghost.field'])
    expect(JSON.parse(run!.conflicts_json!)).toEqual([
      'UNKNOWN_FIELD:ghost.field',
      'SHARED_EVIDENCE:issuer.vat_number|recipient.vat_number'
    ])
    // Prima il campo spariva dal run: copertura 1,0 su un obbligatorio mai cercato.
    expect(JSON.parse(run!.metrics_json!)).toMatchObject({ coverage: 0.56, totalFields: 18 })
    expect(repo.getReviewDocument(id)!.warnings).toContain(
      'Campo obbligatorio senza evidenza: ghost.field.'
    )
    repo.close()
  })
})

describe('motore v2 — DOCX', () => {
  it('precompila il contratto col suo profilo, senza numero richiesto', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'contratto-consulenza.docx', DOCX)

    const outcome = await processorFor(repo, V2)(inputFor(id, 'contratto-consulenza.docx', DOCX))

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
    // Profilo DRAFT: nessun campo obbligatorio, quindi nessun avviso per i vuoti.
    expect(rows.every((f) => f.role !== 'required')).toBe(true)
    expect(repo.getReviewDocument(id)!.warnings).toEqual([])
    expect(repo.getReviewDocument(id)!.evidence.every((item) => item.bbox === undefined)).toBe(true)
    repo.close()
  })
})

describe('motore v2 — PDF scansionato', () => {
  it('estrae da OCR, manda i valori in revisione e segnala gli obbligatori mancanti', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'durc-scansionato.pdf', PDF)

    const outcome = await processorFor(repo, V2)(inputFor(id, 'durc-scansionato.pdf', PDF))

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
    // Il protocollo non si duplica nel numero documento.
    expect(byName['document.number']?.value).toBeNull()

    const document = repo.getReviewDocument(id)!
    expect(document.warnings).toEqual([
      'Pagine lette con OCR: la confidence dei campi che vengono da quelle pagine è ridotta di 0,10.',
      'Campi obbligatori senza evidenza: Impresa/società, CF/P.IVA impresa, Data scadenza, Stato/esito.'
    ])
    expect(repo.events.listForDocument(id).map((e) => e.title)).toEqual([
      'OCR eseguito',
      'Tipo riconosciuto',
      'Campi precompilati'
    ])
    expect(JSON.parse(repo.extractionRuns.listForDocument(id)[0]!.missing_required_json!)).toEqual([
      'company.name',
      'company.tax_id',
      'document.expiry_date',
      'license.status'
    ])
    repo.close()
  }, 180_000)
})

describe('motore v2 — pagine scansionate che l’OCR non ha letto', () => {
  it('non passa per letto: run FAILED_OCR, avviso in scheda e evento', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'durc-scansionato.pdf', PDF)

    const outcome = await processorFor(repo, V2, { withOcr: false })(
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

describe('motore v2 — documento non classificabile', () => {
  it('resta UNKNOWN senza campi, senza evidenze e col motivo nella timeline', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'promemoria-ignoto.pdf', PDF)

    const outcome = await processorFor(repo, V2)(inputFor(id, 'promemoria-ignoto.pdf', PDF))

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
        'Tipo non riconosciuto',
        'Classificatore v2: nessun alias o segnale del registry compare nel testo (NO_SIGNAL). Il tipo va assegnato a mano.'
      ],
      [
        'Campi non estratti',
        'Tipo non riconosciuto: senza tipo non c’è un profilo di campi da cercare. I campi si precompilano quando il tipo viene assegnato a mano.'
      ]
    ])
    expect(repo.extractionRuns.listForDocument(id)).toMatchObject([
      { status: 'SKIPPED_UNKNOWN_TYPE', document_type: '' }
    ])
    repo.close()
  })

  it('assegnato il tipo a mano, si precompila col profilo di quel tipo', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'promemoria-ignoto.pdf', PDF)
    const process = processorFor(repo, V2)
    await process(inputFor(id, 'promemoria-ignoto.pdf', PDF))

    repo.documents.setType(id, 'payments_treasury.richiesta_pagamento', null)
    const outcome = await process(inputFor(id, 'promemoria-ignoto.pdf', PDF))

    expect(outcome).toMatchObject({
      documentType: 'payments_treasury.richiesta_pagamento',
      typeConfidence: null,
      filledFields: 1,
      totalFields: 10
    })
    const values = Object.fromEntries(repo.fields.listForDocument(id).map((f) => [f.name, f.value]))
    expect(values['money.amount']).toBe('1250.00')
    expect(repo.events.listForDocument(id).map((e) => e.title)).toContain('Tipo confermato')
    expect(JSON.parse(repo.extractionRuns.listForDocument(id)[0]!.metrics_json!)).toMatchObject({
      classifier: { manualType: true, reason: 'NO_SIGNAL' }
    })
    // Il tipo è del revisore, la proposta del motore resta quella: nessuna.
    expect(repo.getReviewDocument(id)!.classification).toMatchObject({
      decision: 'UNKNOWN',
      reason: 'NO_SIGNAL',
      proposedType: null,
      candidates: []
    })
    repo.close()
  })

  it('un tipo assegnato a mano che nessun profilo conosce non fa fallire la rielaborazione', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'promemoria-ignoto.pdf', PDF)
    repo.documents.setType(id, 'promemoria_interno', null)

    const outcome = await processorFor(repo, V2)(inputFor(id, 'promemoria-ignoto.pdf', PDF))

    expect(outcome).toMatchObject({ documentType: 'promemoria_interno', totalFields: 0 })
    expect(repo.fields.listForDocument(id)).toEqual([])
    expect(repo.events.listForDocument(id).at(-1)?.detail).toBe(
      'Nessun profilo di estrazione per «promemoria_interno»: il tipo non ha un profilo v2 né uno schema nel registry.'
    )
    expect(repo.extractionRuns.listForDocument(id)[0]?.status).toBe('SKIPPED_NO_PROFILE')
    repo.close()
  })
})

describe('motori combinati', () => {
  it('classificatore v2 con estrazione v1: senza tipo tornano i 4 universali', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'promemoria-ignoto.pdf', PDF)
    await processorFor(repo, { classifier: 'v2', extraction: 'v1' })(
      inputFor(id, 'promemoria-ignoto.pdf', PDF)
    )
    expect(repo.fields.listForDocument(id)).toHaveLength(4)
    expect(repo.extractionRuns.listForDocument(id)).toEqual([])
    repo.close()
  })

  it('classificatore v1 con estrazione v2: il profilo del tipo trovato dal v1', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'fattura-nativa.pdf', PDF)
    const outcome = await processorFor(repo, { classifier: 'v1', extraction: 'v2' })(
      inputFor(id, 'fattura-nativa.pdf', PDF)
    )
    expect(outcome).toMatchObject({ typeConfidence: 0.9, totalFields: 17 })
    expect(repo.events.listForDocument(id)[0]?.detail).toBe(
      'accounting.fattura al 90% da «fattura» in prima pagina.'
    )
    expect(
      JSON.parse(repo.extractionRuns.listForDocument(id)[0]!.metrics_json!).classifier
    ).toEqual({
      engine: 'v1',
      manualType: false,
      documentType: 'accounting.fattura',
      confidence: 0.9,
      phrase: 'fattura',
      source: 'first-page'
    })
    repo.close()
  })
})

describe('motore v2 — rielaborazione e correzioni', () => {
  it('rielaborare non duplica campi ed evidenze, e accumula lo storico dei run', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'fattura-nativa.pdf', PDF)
    const process = processorFor(repo, V2)
    const input = inputFor(id, 'fattura-nativa.pdf', PDF)

    await process(input)
    await process(input)

    const document = repo.getReviewDocument(id)!
    expect(document.fields).toHaveLength(17)
    expect(document.evidence).toHaveLength(10)
    expect(repo.extractionRuns.listForDocument(id)).toHaveLength(2)
    repo.close()
  })

  it('una correzione sopravvive al re-run, anche su un campo che il profilo non ha più', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'fattura-nativa.pdf', PDF)
    const process = processorFor(repo, V2)
    const input = inputFor(id, 'fattura-nativa.pdf', PDF)
    await process(input)

    const number = repo.fields.listForDocument(id).find((f) => f.name === 'document.number')!
    repo.fields.setCorrectedValue(number.id, '114/2026-bis')

    // Il revisore cambia tipo: il profilo della nota di credito non ha i campi CIG/CUP,
    // ma una correzione fatta lì non deve sparire.
    const cig = repo.fields.listForDocument(id).find((f) => f.name === 'procurement.cig')!
    repo.fields.setCorrectedValue(cig.id, 'Z123456789')
    repo.documents.setType(id, 'accounting.nota_di_credito', null)
    await process(input)

    const rows = repo.fields.listForDocument(id)
    expect(rows.find((f) => f.name === 'document.number')).toMatchObject({
      value: '114/2026',
      corrected_value: '114/2026-bis',
      role: 'core'
    })
    expect(rows.find((f) => f.name === 'procurement.cig')).toMatchObject({
      corrected_value: 'Z123456789',
      review_status: 'NEEDS_REVIEW'
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
    await processorFor(repo, V2)(inputFor('doc', 'fattura-nativa.pdf', PDF))

    const rows = Object.fromEntries(repo.fields.listForDocument('doc').map((f) => [f.name, f]))
    expect(rows['document.number']).toMatchObject({
      value: '114/2026',
      corrected_value: '114/2026-A',
      updated_at: '2026-09-11'
    })
    expect(rows['money.total']).toMatchObject({ value: '86420.00', corrected_value: '86420.50' })
    // `tax_code` diventa `company.tax_id`, che la fattura v2 non chiede: resta a sé.
    expect(rows['company.tax_id']).toMatchObject({ corrected_value: '01234567890' })
    expect(rows.document_number).toBeUndefined()
    db.close()
  })

  it('tornando al v1 le correzioni fatte col v2 si ritrovano', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'fattura-nativa.pdf', PDF)
    const input = inputFor(id, 'fattura-nativa.pdf', PDF)
    await processorFor(repo, V2)(input)
    const total = repo.fields.listForDocument(id).find((f) => f.name === 'money.total')!
    repo.fields.setCorrectedValue(total.id, '86420.50')

    await processorFor(repo, V1)(input)

    const rows = repo.fields.listForDocument(id)
    expect(rows).toHaveLength(8)
    expect(rows.find((f) => f.name === 'total_amount')?.corrected_value).toBe('86420.50')
    repo.close()
  })
})

describe('il testo su cui si ritrovano le selezioni', () => {
  it('salva hash del file, righe con coordinate e impronta della prima pagina', async () => {
    const repo = createTestRepository()
    const id = seed(repo, 'fattura-nativa.pdf', PDF)
    await processorFor(repo, V2)(inputFor(id, 'fattura-nativa.pdf', PDF))

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
    const id = seed(repo, 'contratto-consulenza.docx', DOCX)
    await processorFor(repo, V2)(inputFor(id, 'contratto-consulenza.docx', DOCX))

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
    const id = seed(repo, 'fattura-nativa.pdf', PDF)
    const process = processorFor(repo, V2)
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
