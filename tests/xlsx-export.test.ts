import { copyFileSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { afterAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/db'
import { createRepository } from '../src/main/db/repository'
import { setFieldItemRemoved, updateFieldItem, updateFieldValue } from '../src/main/field-edits'
import { createDocumentProcessor } from '../src/main/pipeline'
import { submitReview } from '../src/main/review'
import { collectXlsxRows, writeXlsxFile } from '../src/main/xlsx-export'
import { XLSX_DOCUMENT_COLUMNS, XLSX_FIELD_COLUMNS } from '../src/shared/dataset-xlsx'
import {
  fixture,
  testClassifierConfigV2,
  testLegacyFieldMap,
  testRegistry,
  testRegistryV2
} from './helpers/registry'

/**
 * End-to-end dell'export XLSX: documenti veri elaborati dalla pipeline su un database di
 * prova, corretti come farebbe il revisore, chiusi, esportati su file — e il file
 * riletto con exceljs, che è l'unica prova che si apra davvero.
 */
const PDF = 'application/pdf'

const workdir = mkdtempSync(join(tmpdir(), 'reviewer-xlsx-'))
afterAll(() => rmSync(workdir, { recursive: true, force: true }))

function setup() {
  const registry = testRegistry()
  const db = openDatabase({ file: ':memory:' })
  const repo = createRepository(db, {
    requiredFields: (type) => registry.requiredFor(type),
    typeLabel: (type) => registry.label(type)
  })
  const v2 = createDocumentProcessor({
    repo,
    registry,
    engines: { classifier: 'v2', extraction: 'v2' },
    classifierConfigV2: testClassifierConfigV2(),
    extractionRegistryV2: testRegistryV2(),
    legacyFieldMap: testLegacyFieldMap()
  })
  // Il motore vecchio non calcola né secondo candidato né margine: serve un documento
  // che ci sia passato per provare che le due colonne restano vuote.
  const v1 = createDocumentProcessor({
    repo,
    registry,
    engines: { classifier: 'v1', extraction: 'v1' }
  })

  async function open(
    filename: string,
    options: { path?: string; driveFileId?: string; process?: typeof v2 } = {}
  ) {
    const path = options.path ?? fixture(filename)
    const { id } = repo.documents.upsertFromDrive({
      driveFileId: options.driveFileId ?? `drive-${filename}`,
      filename,
      mime: PDF,
      receivedAt: '2026-09-10T08:00:00.000Z'
    })
    repo.documents.setCachedPath(id, path)
    const input = { documentId: id, cachedPath: path, mime: PDF, filename }
    await (options.process ?? v2)(input)
    return { id, rerun: () => (options.process ?? v2)(input) }
  }

  const field = (id: string, name: string) =>
    repo.getReviewDocument(id)!.fields.find((candidate) => candidate.name === name)!

  return { db, repo, open, field, v1 }
}

/** Le righe di un foglio come oggetti `colonna -> valore`, senza l'intestazione. */
function readSheet(sheet: ExcelJS.Worksheet): Array<Record<string, unknown>> {
  const headers = (sheet.getRow(1).values as unknown[]).slice(1).map(String)
  const rows: Array<Record<string, unknown>> = []
  sheet.eachRow((row, index) => {
    if (index === 1) return
    const values = (row.values as unknown[]).slice(1)
    rows.push(Object.fromEntries(headers.map((header, i) => [header, values[i] ?? null])))
  })
  return rows
}

async function readWorkbook(path: string) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(path)
  return workbook
}

describe('export XLSX del dataset annotato', () => {
  it('scrive un file che si riapre, con i due fogli e le colonne richieste', async () => {
    const { db, repo, open, field, v1 } = setup()

    // 1. Fattura con righe ripetute: si corregge una riga, se ne toglie un'altra, e si
    // cambia un campo singolo.
    const invoice = await open('fattura-righe.pdf')
    const rows = field(invoice.id, 'line_items').items
    updateFieldItem(repo, {
      documentId: invoice.id,
      itemId: rows[1]!.id,
      correctedValue: 'Smaltimento macerie in discarica - EUR 850,00'
    })
    setFieldItemRemoved(repo, { documentId: invoice.id, itemId: rows[2]!.id, removed: true })
    updateFieldValue(repo, {
      documentId: invoice.id,
      fieldId: field(invoice.id, 'document.number').id,
      correctedValue: '27/2026/B'
    })
    submitReview(repo, {
      documentId: invoice.id,
      action: 'SAVE',
      note: 'importi verificati col cliente'
    })

    // 2. Lo stesso stampato con dati diversi non c'è fra le fixture: una seconda copia
    // dello stesso file basta a provare che l'impronta del layout coincide.
    const copy = join(workdir, 'fattura-righe-copia.pdf')
    copyFileSync(fixture('fattura-righe.pdf'), copy)
    const twin = await open('fattura-righe-copia.pdf', { path: copy, driveFileId: 'drive-copia' })
    // Un re-run più recente con un secondo candidato: è l'ultimo run a descrivere lo
    // stato attuale del documento, ed è da lì che escono runner-up e margine.
    const [firstRun] = repo.extractionRuns.listForDocument(twin.id)
    const later = new Date(Date.parse(firstRun!.started_at) + 60_000).toISOString()
    repo.extractionRuns.add(twin.id, {
      engineVersion: 'extraction-brain-v2/2.1.0-draft.1',
      schemaVersion: '2.0.0',
      documentType: 'accounting.fattura',
      startedAt: later,
      completedAt: later,
      status: 'COMPLETED',
      missingRequired: [],
      conflicts: [],
      metrics: {
        classifier: {
          engine: 'v2',
          decision: 'ASSIGN',
          runnerUp: { documentType: 'accounting.nota_credito', confidence: 0.41 },
          margin: 0.31
        }
      }
    })
    submitReview(repo, { documentId: twin.id, action: 'SAVE' })

    // 3. Documento passato dal motore v1: niente run, quindi niente runner-up né margine.
    const { id: legacyId } = await open('fattura-nativa.pdf', { process: v1 })
    submitReview(repo, { documentId: legacyId, action: 'SAVE' })

    // 4. Documento la cui copia locale non c'è più: esce senza impronta, non in errore.
    const evicted = join(workdir, 'promemoria-ignoto.pdf')
    copyFileSync(fixture('promemoria-ignoto.pdf'), evicted)
    const gone = await open('promemoria-ignoto.pdf', { path: evicted, driveFileId: 'drive-gone' })
    unlinkSync(evicted)
    // L'impronta la calcola già l'elaborazione: senza, il documento è uno elaborato prima
    // della 0010, l'unico caso in cui l'export la cerca nella copia locale che non c'è più.
    expect(repo.documents.get(gone.id)!.template_fingerprint).not.toBeNull()
    db.prepare('UPDATE documents SET template_fingerprint = NULL WHERE id = ?').run(gone.id)
    submitReview(repo, {
      documentId: gone.id,
      action: 'DISCARD',
      note: 'scansione tagliata a metà'
    })

    // 5. Ancora in coda: resta fuori da tutti e due i fogli.
    await open('in-coda.pdf', { path: fixture('fattura-nativa.pdf'), driveFileId: 'drive-coda' })

    const path = join(workdir, 'dataset.xlsx')
    const written = await collectXlsxRows(repo)
    await writeXlsxFile(path, written)

    const workbook = await readWorkbook(path)
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['documents', 'fields'])

    const documentsSheet = workbook.getWorksheet('documents')!
    const fieldsSheet = workbook.getWorksheet('fields')!
    expect((documentsSheet.getRow(1).values as unknown[]).slice(1)).toEqual(XLSX_DOCUMENT_COLUMNS)
    expect((fieldsSheet.getRow(1).values as unknown[]).slice(1)).toEqual(XLSX_FIELD_COLUMNS)
    expect(documentsSheet.getRow(1).font?.bold).toBe(true)
    expect(documentsSheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 })

    const documents = readSheet(documentsSheet)
    const fields = readSheet(fieldsSheet)
    expect(documents).toHaveLength(4)
    expect(documents).toHaveLength(written.documents.length)
    expect(fields).toHaveLength(written.fields.length)

    // Il documento ancora in coda non c'è, lo scartato sì ma senza campi.
    const byId = (id: string) => documents.find((row) => row.document_id === id)!
    expect(byId(gone.id)).toMatchObject({
      review_status: 'DISCARDED',
      template_fingerprint: null,
      // Lo scartato non ha campi: la nota è tutto quello che dice perché è fuori.
      review_note: 'scansione tagliata a metà'
    })
    expect(fields.filter((row) => row.document_id === gone.id)).toEqual([])
    expect(documents.filter((row) => row.review_status === 'REVIEWED')).toHaveLength(3)

    // Classificatore v2: confidence e margine restano numeri, non testo. Il secondo
    // candidato qui non c'è — il registry di prova ha un solo tipo che segnala.
    const invoiceRow = byId(invoice.id)
    expect(invoiceRow.document_type_final).toBe('accounting.fattura')
    expect(invoiceRow.document_type_predicted).toBe('accounting.fattura')
    expect(typeof invoiceRow.classifier_confidence).toBe('number')
    expect(typeof invoiceRow.margin).toBe('number')
    expect(invoiceRow.runner_up).toBeNull()
    expect(invoiceRow.review_note).toBe('importi verificati col cliente')
    // Chi ha chiuso il documento senza scrivere niente lascia la cella vuota.
    expect(byId(legacyId).review_note).toBeNull()

    // Il run più recente è quello che vale: runner-up e margine vengono da lì.
    expect(byId(twin.id)).toMatchObject({
      runner_up: 'accounting.nota_credito',
      margin: 0.31
    })

    // Col v1 le due colonne restano vuote: il motore vecchio non le calcola.
    expect(byId(legacyId)).toMatchObject({ runner_up: null, margin: null })

    // Stesso stampato, stessa impronta; un altro documento, un'altra.
    expect(byId(twin.id).template_fingerprint).toBe(invoiceRow.template_fingerprint)
    expect(byId(twin.id).template_fingerprint).toEqual(expect.any(String))
    expect(byId(legacyId).template_fingerprint).not.toBe(invoiceRow.template_fingerprint)

    // Il foglio dei campi: una riga per item, con l'evidenza verbatim.
    const lines = fields.filter(
      (row) => row.document_id === invoice.id && row.field_name === 'line_items'
    )
    expect(lines.map((row) => [row.item_index, row.value_final])).toEqual([
      [0, 'Demolizione tramezzi - EUR 3.200,00'],
      [1, 'Smaltimento macerie in discarica - EUR 850,00'],
      [2, null]
    ])
    expect(lines[0]).toMatchObject({ cardinality: 'many', origin: 'ENGINE', evidence_page: 1 })
    expect(lines[0]!.evidence_text).toContain('Demolizione tramezzi')
    expect(JSON.parse(String(lines[0]!.evidence_bbox))).toMatchObject({ x: expect.any(Number) })

    const number = fields.find(
      (row) => row.document_id === invoice.id && row.field_name === 'document.number'
    )!
    expect(number).toMatchObject({
      cardinality: 'one',
      item_index: null,
      value_predicted: '27/2026',
      value_final: '27/2026/B',
      origin: 'REVIEWER'
    })

    db.close()
  })

  it('l’impronta si calcola una volta sola e resta sulla colonna', async () => {
    const { db, repo, open } = setup()
    const doc = await open('fattura-righe.pdf')
    submitReview(repo, { documentId: doc.id, action: 'SAVE' })

    const first = await collectXlsxRows(repo)
    const stored = repo.documents.get(doc.id)!.template_fingerprint
    expect(stored).toBe(first.documents[0]!.template_fingerprint)
    expect(stored).toEqual(expect.any(String))

    // Al secondo export il documento non viene riletto da disco: il valore è già lì.
    const second = await collectXlsxRows(repo, {
      firstPageLines: () => {
        throw new Error('il testo non va riletto per un documento che ha già l’impronta')
      }
    })
    expect(second.documents[0]!.template_fingerprint).toBe(stored)
    db.close()
  })

  it('un re-run dell’estrazione non duplica righe né perde correzioni', async () => {
    const { db, repo, open, field } = setup()
    const invoice = await open('fattura-righe.pdf')
    updateFieldValue(repo, {
      documentId: invoice.id,
      fieldId: field(invoice.id, 'document.number').id,
      correctedValue: '27/2026/B'
    })
    submitReview(repo, { documentId: invoice.id, action: 'SAVE' })

    const before = await collectXlsxRows(repo)
    await invoice.rerun()
    const after = await collectXlsxRows(repo)

    expect(after.documents).toHaveLength(before.documents.length)
    expect(after.fields).toHaveLength(before.fields.length)
    const number = after.fields.find((row) => row.field_name === 'document.number')!
    expect(number).toMatchObject({
      value_predicted: '27/2026',
      value_final: '27/2026/B',
      origin: 'REVIEWER'
    })

    const path = join(workdir, 'rerun.xlsx')
    await writeXlsxFile(path, after)
    const workbook = await readWorkbook(path)
    expect(readSheet(workbook.getWorksheet('fields')!)).toHaveLength(after.fields.length)
    db.close()
  })
})
