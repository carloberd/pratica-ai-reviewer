import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectDataset, writeDatasetFile } from '../src/main/dataset-export'
import { openDatabase } from '../src/main/db'
import { createRepository } from '../src/main/db/repository'
import {
  addFieldItem,
  setFieldItemRemoved,
  updateFieldItem,
  updateFieldValue
} from '../src/main/field-edits'
import { createDocumentProcessor, EXTRACTION_ENGINE_V2_VERSION } from '../src/main/pipeline'
import { assignDocumentType } from '../src/main/reprocess'
import { submitReview } from '../src/main/review'
import { DATASET_FORMAT_VERSION, type DatasetManifestInput } from '../src/shared/dataset'
import {
  fixture,
  testClassifierConfigV2,
  testLegacyFieldMap,
  testRegistry,
  testRegistryV2
} from './helpers/registry'

/**
 * End-to-end dell'export: documenti veri elaborati dalla pipeline v2 su un database di
 * prova, corretti come farebbe il revisore, rielaborati, chiusi, ed esportati su file.
 * Il file deve coincidere byte per byte con `tests/fixtures/dataset-export.expected.json`.
 *
 * Il formato cambia di proposito? Rigenera il file atteso con
 * `UPDATE_DATASET_FIXTURE=1 pnpm vitest run tests/dataset-export.test.ts` e rileggi il diff.
 */
const EXPECTED = fixture('dataset-export.expected.json')
const PDF = 'application/pdf'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const workdir = mkdtempSync(join(tmpdir(), 'reviewer-dataset-'))
afterAll(() => rmSync(workdir, { recursive: true, force: true }))

// Un orologio fermo: date di run, correzioni e revisione finiscono nel file.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-16T08:00:00.000Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

const MANIFEST: DatasetManifestInput = {
  exportedAt: '2026-09-16T18:00:00.000Z',
  app: { name: 'praticaai-reviewer', version: '1.1.0' },
  engines: {
    classifier: 'v2',
    extraction: 'v2',
    classifierVersion: testClassifierConfigV2().version,
    extractionEngineVersion: EXTRACTION_ENGINE_V2_VERSION,
    schemaVersion: testRegistryV2().schemaVersion()
  }
}

function setup() {
  const registry = testRegistry()
  const db = openDatabase({ file: ':memory:' })
  const repo = createRepository(db, {
    requiredFields: (type) => registry.requiredFor(type),
    typeLabel: (type) => registry.label(type)
  })
  const processDocument = createDocumentProcessor({
    repo,
    registry,
    engines: { classifier: 'v2', extraction: 'v2' },
    classifierConfigV2: testClassifierConfigV2(),
    extractionRegistryV2: testRegistryV2(),
    legacyFieldMap: testLegacyFieldMap()
  })

  async function open(filename: string, mime: string) {
    const { id } = repo.documents.upsertFromDrive({
      driveFileId: `drive-${filename}`,
      filename,
      mime,
      receivedAt: '2026-09-10T08:00:00.000Z'
    })
    repo.documents.setCachedPath(id, fixture(filename))
    const input = { documentId: id, cachedPath: fixture(filename), mime, filename }
    await processDocument(input)
    return { id, rerun: () => processDocument(input) }
  }

  const field = (id: string, name: string) =>
    repo.getReviewDocument(id)!.fields.find((candidate) => candidate.name === name)!

  return { db, repo, processDocument, open, field }
}

describe('export del dataset annotato', () => {
  it('dal database di prova al file atteso, con before/after che sopravvivono al re-run', async () => {
    const { db, repo, processDocument, open, field } = setup()

    // 1. Fattura con righe: si corregge riga per riga e qualche campo singolo.
    const invoice = await open('fattura-righe.pdf', PDF)
    const rows = field(invoice.id, 'line_items').items
    expect(rows.map((row) => row.value)).toEqual([
      'Demolizione tramezzi - EUR 3.200,00',
      'Smaltimento macerie - EUR 850,00',
      'Tinteggiatura pareti - EUR 1.450,00'
    ])
    vi.setSystemTime(new Date('2026-09-16T09:00:00.000Z'))
    updateFieldItem(repo, {
      documentId: invoice.id,
      itemId: rows[1]!.id,
      correctedValue: 'Smaltimento macerie in discarica - EUR 850,00'
    })
    setFieldItemRemoved(repo, { documentId: invoice.id, itemId: rows[2]!.id, removed: true })
    addFieldItem(repo, {
      documentId: invoice.id,
      fieldId: field(invoice.id, 'line_items').id,
      value: 'Tinteggiatura pareti e soffitti - EUR 1.450,00'
    })
    const edit = (name: string, value: string | null) =>
      updateFieldValue(repo, {
        documentId: invoice.id,
        fieldId: field(invoice.id, name).id,
        correctedValue: value
      })
    edit('document.number', '27/2026/B') // CHANGED
    edit('issuer.tax_id', '09876543210') // FILLED
    edit('money.currency', '') // CLEARED
    edit('recipient.name', 'Gamma Immobiliare S.r.l.') // uguale alla proposta: nessuna correzione

    // Il re-run dell'estrazione rigenera campi ed evidenze: il lavoro del revisore resta.
    vi.setSystemTime(new Date('2026-09-16T10:00:00.000Z'))
    await invoice.rerun()
    submitReview(repo, { documentId: invoice.id, action: 'SAVE', note: 'righe verificate' })

    // 2. Documento non riconosciuto: il revisore sceglie il tipo e compila a mano.
    vi.setSystemTime(new Date('2026-09-16T11:00:00.000Z'))
    const memo = await open('promemoria-ignoto.pdf', PDF)
    expect(repo.getReviewDocument(memo.id)!.documentType).toBeNull()
    await assignDocumentType({
      repo,
      documentId: memo.id,
      documentType: 'payments_treasury.richiesta_pagamento',
      process: processDocument
    })
    // La data la seleziona sul documento, come farebbe dal visualizzatore: il valore porta
    // con sé pagina, riquadro e posizione fra le righe, e la rielaborazione non li perde.
    updateFieldValue(repo, {
      documentId: memo.id,
      fieldId: field(memo.id, 'document.issue_date').id,
      correctedValue: '12/09/2026',
      pick: {
        method: 'TEXT_SELECTION',
        page: 1,
        text: '12/09/2026',
        bbox: { x: 87.6, y: 131, w: 52.7, h: 11 }
      }
    })
    await memo.rerun()
    submitReview(repo, { documentId: memo.id, action: 'SAVE' })

    // 3. Contratto scartato: entra col suo stato, senza valori confermati.
    vi.setSystemTime(new Date('2026-09-16T12:00:00.000Z'))
    const contract = await open('contratto-consulenza.docx', DOCX)
    updateFieldValue(repo, {
      documentId: contract.id,
      fieldId: field(contract.id, 'document.number').id,
      correctedValue: 'CC-2026-019'
    })
    submitReview(repo, { documentId: contract.id, action: 'DISCARD' })

    // 4. Ancora in coda: resta fuori.
    await open('fattura-nativa.pdf', PDF)

    const path = join(workdir, 'dataset.json')
    await writeDatasetFile(path, collectDataset(repo, MANIFEST))
    db.close()

    const written = readFileSync(path, 'utf8')
    if (process.env.UPDATE_DATASET_FIXTURE || !existsSync(EXPECTED)) {
      writeFileSync(EXPECTED, written)
    }
    expect(written).toBe(readFileSync(EXPECTED, 'utf8'))

    // Qualche verifica esplicita, per non affidare tutto al file atteso.
    const dataset = JSON.parse(written)
    expect(dataset.manifest).toMatchObject({
      formatVersion: DATASET_FORMAT_VERSION,
      counts: { documents: 3, reviewed: 2, discarded: 1, corrections: 7 }
    })
    const [contractDoc, invoiceDoc, memoDoc] = dataset.documents
    expect(contractDoc).toMatchObject({ status: 'DISCARDED', fields: [], corrections: [] })
    expect(invoiceDoc.corrections).toEqual([
      {
        field: 'document.number',
        label: 'Numero documento',
        item: null,
        kind: 'CHANGED',
        before: '27/2026',
        after: '27/2026/B',
        pick: null
      },
      {
        field: 'issuer.tax_id',
        label: 'CF/P.IVA emittente',
        item: null,
        kind: 'FILLED',
        before: null,
        after: '09876543210',
        pick: null
      },
      {
        field: 'money.currency',
        label: 'Valuta',
        item: null,
        kind: 'CLEARED',
        before: 'EUR',
        after: null,
        pick: null
      },
      {
        field: 'line_items',
        label: 'Righe documento',
        item: 1,
        kind: 'CHANGED',
        before: 'Smaltimento macerie - EUR 850,00',
        after: 'Smaltimento macerie in discarica - EUR 850,00',
        pick: null
      },
      {
        field: 'line_items',
        label: 'Righe documento',
        item: 2,
        kind: 'REMOVED',
        before: 'Tinteggiatura pareti - EUR 1.450,00',
        after: null,
        pick: null
      },
      {
        field: 'line_items',
        label: 'Righe documento',
        item: 3,
        kind: 'ADDED',
        before: null,
        after: 'Tinteggiatura pareti e soffitti - EUR 1.450,00',
        pick: null
      }
    ])
    expect(invoiceDoc.fields.find((f: { name: string }) => f.name === 'line_items').value).toEqual([
      'Demolizione tramezzi - EUR 3.200,00',
      'Smaltimento macerie in discarica - EUR 850,00',
      'Tinteggiatura pareti e soffitti - EUR 1.450,00'
    ])
    expect(memoDoc.documentType).toMatchObject({
      id: 'payments_treasury.richiesta_pagamento',
      chosenBy: 'REVIEWER',
      proposed: null,
      corrected: true
    })
    // «Data: 12/09/2026» è la quarta riga; il valore comincia dopo «Data: ».
    const pick = {
      method: 'TEXT_SELECTION',
      page: 1,
      text: '12/09/2026',
      bbox: { x: 87.6, y: 131, w: 52.7, h: 11 },
      location: { lineStart: 3, lineEnd: 3, charStart: 99, charEnd: 109 }
    }
    expect(
      memoDoc.fields.find((f: { name: string }) => f.name === 'document.issue_date')
    ).toMatchObject({ value: '12/09/2026', origin: 'REVIEWER', pick })
    expect(memoDoc.corrections).toEqual([
      expect.objectContaining({ field: 'document.issue_date', kind: 'FILLED', pick })
    ])
    expect(memoDoc.contentSha256).toMatch(/^[0-9a-f]{64}$/)
    // Un valore scritto a mano non ha una selezione dietro.
    expect(invoiceDoc.corrections.every((c: { pick: unknown }) => c.pick === null)).toBe(true)
  })
})
