import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BUNDLE_DATASET_FILE,
  BUNDLE_XLSX_FILE,
  exportDatasetBundle
} from '../src/main/dataset-bundle'
import { collectDataset, writeDatasetFile } from '../src/main/dataset-export'
import { openDatabase } from '../src/main/db'
import { createRepository } from '../src/main/db/repository'
import { updateFieldValue } from '../src/main/field-edits'
import { createDocumentProcessor } from '../src/main/pipeline'
import { submitReview } from '../src/main/review'
import type { DatasetManifestInput } from '../src/shared/dataset'
import {
  BUNDLE_DOCUMENTS_DIR,
  BUNDLE_FILES_MANIFEST,
  type DatasetFilesManifest
} from '../src/shared/dataset-bundle'
import { fixture, testExtractionRegistry } from './helpers/registry'

/**
 * L'export completo: documenti veri elaborati dalla pipeline, chiusi dal revisore, e la
 * cartella che ne esce — dataset, foglio, copie dei file e `documenti.json`.
 *
 * Quello che questo test tiene fermo è il patto con chi riceve la cartella: il
 * `dataset.json` è lo stesso file dell'export JSON (non una seconda versione che può
 * divergere), ogni riga del dataset ha il suo file o una ragione scritta per cui non ce
 * l'ha, e una copia che non è il documento annotato si vede prima di usarla.
 */

const PDF = 'application/pdf'
const TYPE_OF: Record<string, string> = {
  'fattura-nativa.pdf': 'accounting.fattura',
  'fattura-righe.pdf': 'accounting.fattura',
  'promemoria-ignoto.pdf': 'payments_treasury.richiesta_pagamento'
}

const workdir = mkdtempSync(join(tmpdir(), 'reviewer-bundle-'))
afterAll(() => rmSync(workdir, { recursive: true, force: true }))

const MANIFEST: DatasetManifestInput = {
  exportedAt: '2026-09-25T18:00:00.000Z',
  app: { name: 'praticaai-reviewer', version: '1.10.0' },
  engines: { extractionEngineVersion: 'extraction-brain-v2/2.1.0-draft.1', schemaVersion: '2.0.0' }
}

function setup() {
  const registry = testExtractionRegistry()
  const db = openDatabase({ file: ':memory:' })
  const repo = createRepository(db, {
    requiredFields: (type) => (type ? (registry.baseProfile(type)?.required_fields ?? []) : []),
    typeLabel: (type) => (type ? (registry.baseProfile(type)?.canonical_name ?? null) : null)
  })
  const process = createDocumentProcessor({ repo, extractionRegistry: testExtractionRegistry() })

  /** Un documento come lo apre il revisore: copia in cache, tipo, elaborazione. */
  async function open(filename: string, options: { path?: string; driveFileId?: string } = {}) {
    const path = options.path ?? fixture(filename)
    const { id } = repo.documents.upsertFromDrive({
      driveFileId: options.driveFileId ?? `drive-${filename}`,
      filename,
      mime: PDF,
      receivedAt: '2026-09-10T08:00:00.000Z'
    })
    repo.documents.setCachedPath(id, path)
    if (TYPE_OF[filename]) repo.documents.setType(id, TYPE_OF[filename]!, null)
    await process({ documentId: id, cachedPath: path, mime: PDF, filename })
    return id
  }

  return { db, repo, open }
}

function readManifest(directory: string): DatasetFilesManifest {
  return JSON.parse(readFileSync(join(directory, BUNDLE_FILES_MANIFEST), 'utf8'))
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('export del dataset completo, coi documenti revisionati', () => {
  it('scrive dataset, foglio e una copia di ogni documento chiuso', async () => {
    const { repo, open } = setup()

    const invoice = await open('fattura-righe.pdf')
    const number = repo
      .getReviewDocument(invoice)!
      .fields.find((field) => field.name === 'document.number')!
    updateFieldValue(repo, { documentId: invoice, fieldId: number.id, correctedValue: '27/2026/B' })
    submitReview(repo, { documentId: invoice, action: 'SAVE' })

    // Uno scartato: il file ci va come gli altri. È un documento annotato — «questo non
    // vale» è un'annotazione — e chi misura vuole vedere su cosa è stata presa.
    const discarded = await open('promemoria-ignoto.pdf')
    submitReview(repo, { documentId: discarded, action: 'DISCARD', note: 'non pertinente' })

    // Uno ancora in coda: non è nel dataset, e quindi non è nemmeno nella cartella.
    await open('fattura-nativa.pdf')

    const directory = join(workdir, 'completo')
    const result = await exportDatasetBundle({
      repo,
      dataset: collectDataset(repo, MANIFEST),
      directory
    })

    expect(result).toMatchObject({
      saved: true,
      directory,
      documents: 2,
      corrections: 1,
      copied: 2,
      missing: 0,
      mismatched: 0
    })
    expect(result.bytes).toBeGreaterThan(0)

    expect(readdirSync(directory).sort()).toEqual(
      [BUNDLE_DATASET_FILE, BUNDLE_FILES_MANIFEST, BUNDLE_DOCUMENTS_DIR, BUNDLE_XLSX_FILE].sort()
    )
    expect(readdirSync(join(directory, BUNDLE_DOCUMENTS_DIR)).sort()).toEqual([
      'fattura-righe.pdf',
      'promemoria-ignoto.pdf'
    ])

    // Il foglio si riapre davvero, ed è quello dei due export: due fogli, le righe dei
    // documenti chiusi.
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(join(directory, BUNDLE_XLSX_FILE))
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['documents', 'fields'])
    expect(workbook.getWorksheet('documents')!.rowCount).toBe(3)

    // Ogni riga del dataset ha il suo file, e la copia è identica all'originale.
    const manifest = readManifest(directory)
    const dataset = JSON.parse(readFileSync(join(directory, BUNDLE_DATASET_FILE), 'utf8'))
    expect(manifest.files.map((file) => file.driveFileId).sort()).toEqual(
      dataset.documents.map((document: { driveFileId: string }) => document.driveFileId).sort()
    )
    for (const file of manifest.files) {
      expect(file.missing).toBeNull()
      expect(file.matchesAnnotated).toBe(true)
      expect(sha256(join(directory, ...file.file!.split('/')))).toBe(file.sha256)
    }
    expect(manifest.files.find((file) => file.filename === 'promemoria-ignoto.pdf')!.status).toBe(
      'DISCARDED'
    )
  })

  it('il dataset nella cartella è lo stesso file dell’export JSON, byte per byte', async () => {
    const { repo, open } = setup()
    const id = await open('fattura-nativa.pdf')
    submitReview(repo, { documentId: id, action: 'SAVE' })

    const directory = join(workdir, 'confronto')
    await exportDatasetBundle({ repo, dataset: collectDataset(repo, MANIFEST), directory })

    const alone = join(workdir, 'solo-json.json')
    await writeDatasetFile(alone, collectDataset(repo, MANIFEST))

    expect(readFileSync(join(directory, BUNDLE_DATASET_FILE), 'utf8')).toBe(
      readFileSync(alone, 'utf8')
    )
  })

  it('un documento senza copia locale resta nel dataset, e il manifest dice che manca', async () => {
    const { repo, open } = setup()

    const kept = await open('fattura-nativa.pdf')
    submitReview(repo, { documentId: kept, action: 'SAVE' })

    // Copia tolta dalla cache dal revisore: il path resta nullo.
    const evictedPath = join(workdir, 'evicted.pdf')
    copyFileSync(fixture('fattura-righe.pdf'), evictedPath)
    const evicted = await open('fattura-righe.pdf', {
      path: evictedPath,
      driveFileId: 'drive-evicted'
    })
    submitReview(repo, { documentId: evicted, action: 'SAVE' })
    repo.documents.setCachedPath(evicted, null)

    // Path registrato ma file sparito dal disco: l'export non deve fermarsi qui.
    const gonePath = join(workdir, 'gone.pdf')
    copyFileSync(fixture('promemoria-ignoto.pdf'), gonePath)
    const gone = await open('promemoria-ignoto.pdf', { path: gonePath, driveFileId: 'drive-gone' })
    submitReview(repo, { documentId: gone, action: 'SAVE' })
    unlinkSync(gonePath)

    const directory = join(workdir, 'mancanti')
    const result = await exportDatasetBundle({
      repo,
      dataset: collectDataset(repo, MANIFEST),
      directory
    })

    expect(result).toMatchObject({ documents: 3, copied: 1, missing: 2 })
    const manifest = readManifest(directory)
    expect(manifest.files.find((file) => file.driveFileId === 'drive-evicted')).toMatchObject({
      file: null,
      bytes: null,
      missing: 'NO_LOCAL_COPY'
    })
    expect(manifest.files.find((file) => file.driveFileId === 'drive-gone')).toMatchObject({
      file: null,
      missing: 'FILE_GONE'
    })
  })

  // Il caso che l'export esiste per non lasciare passare: il file su Drive è cambiato
  // dopo la revisione, quindi la copia non è il documento su cui sono stati annotati i
  // valori. Esce lo stesso, ma dichiarato.
  it('una copia che non è più il documento annotato viene dichiarata', async () => {
    const { db, repo, open } = setup()
    const id = await open('fattura-nativa.pdf')
    submitReview(repo, { documentId: id, action: 'SAVE' })
    db.prepare('UPDATE documents SET content_sha256 = ? WHERE id = ?').run('0'.repeat(64), id)

    const directory = join(workdir, 'cambiato')
    const result = await exportDatasetBundle({
      repo,
      dataset: collectDataset(repo, MANIFEST),
      directory
    })

    expect(result).toMatchObject({ copied: 1, missing: 0, mismatched: 1 })
    expect(readManifest(directory).files[0]).toMatchObject({
      contentSha256: '0'.repeat(64),
      matchesAnnotated: false
    })
  })

  it('un documento elaborato prima dello sha non conta come copia sbagliata', async () => {
    const { db, repo, open } = setup()
    const id = await open('fattura-nativa.pdf')
    submitReview(repo, { documentId: id, action: 'SAVE' })
    db.prepare('UPDATE documents SET content_sha256 = NULL WHERE id = ?').run(id)

    const directory = join(workdir, 'senza-sha')
    const result = await exportDatasetBundle({
      repo,
      dataset: collectDataset(repo, MANIFEST),
      directory
    })

    expect(result).toMatchObject({ copied: 1, mismatched: 0 })
    expect(readManifest(directory).files[0]!.matchesAnnotated).toBeNull()
  })
})
