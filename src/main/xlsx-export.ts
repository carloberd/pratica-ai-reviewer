import { existsSync } from 'node:fs'
import {
  buildXlsxRows,
  XLSX_DOCUMENT_COLUMNS,
  XLSX_FIELD_COLUMNS,
  type XlsxDocumentRow,
  type XlsxFieldRow,
  type XlsxRows,
  type XlsxSource
} from '@shared/dataset-xlsx'
import { templateFingerprint } from '@shared/template-fingerprint'
import ExcelJS from 'exceljs'
import type { Repository } from './db/repository'
import type { DocumentRow } from './db/rows'
import { logError } from './errors'
import { extractText } from './extract/text'

/**
 * L'export XLSX lato main: legge dal database le righe dei due fogli e le scrive col
 * foglio di calcolo. La forma delle righe sta in `@shared/dataset-xlsx`, che non sa
 * niente né di SQLite né di exceljs; qui restano solo il database, il disco e la
 * formattazione delle celle.
 */

/** Righe della prima pagina di un documento in cache: è da lì che esce l'impronta. */
export type FirstPageLines = (input: { path: string; mime: string }) => Promise<string[]>

const readFirstPageLines: FirstPageLines = async ({ path, mime }) => {
  // Niente OCR: l'impronta è del layout del testo, e far girare tesseract su tutta la
  // coda per un export costerebbe più di quanto valga. Una scansione senza text layer
  // non ha righe, e resta senza impronta.
  const extracted = await extractText({ filePath: path, mime })
  const first = extracted.pages[0]
  if (!first) return []
  if (first.lines.length > 0) return first.lines.map((line) => line.text)
  return first.text.split(/\r?\n/)
}

export interface XlsxCollectDeps {
  firstPageLines?: FirstPageLines
}

/**
 * L'impronta del documento: quella già calcolata, o una nuova dalla copia in cache.
 *
 * Il layout di un documento non cambia, quindi si calcola una volta sola e resta sulla
 * colonna `template_fingerprint`. Senza copia locale l'impronta manca e basta: per un
 * export non si riscarica niente da Drive.
 */
async function ensureFingerprint(
  repo: Repository,
  row: DocumentRow,
  firstPageLines: FirstPageLines
): Promise<string | null> {
  if (row.template_fingerprint) return row.template_fingerprint
  if (!row.cached_path || !existsSync(row.cached_path)) return null

  let lines: string[]
  try {
    lines = await firstPageLines({ path: row.cached_path, mime: row.mime })
  } catch (error) {
    // Un documento illeggibile esce senza impronta: non deve fermare l'export.
    logError('xlsx.fingerprint', error)
    return null
  }

  const fingerprint = templateFingerprint(lines)
  if (fingerprint) repo.documents.setTemplateFingerprint(row.id, fingerprint)
  return fingerprint
}

/** Raccoglie dal database i documenti chiusi dal revisore e ne fa le righe dei due fogli. */
export async function collectXlsxRows(
  repo: Repository,
  deps: XlsxCollectDeps = {}
): Promise<XlsxRows> {
  const firstPageLines = deps.firstPageLines ?? readFirstPageLines
  const sources: XlsxSource[] = []

  for (const row of repo.documents.list()) {
    if (row.status === 'NEEDS_REVIEW') continue
    const document = repo.getReviewDocument(row.id)
    if (!document) continue
    // Il run più recente è il primo della lista, ed è quello che corrisponde ai campi
    // che il documento ha adesso.
    const [run] = repo.extractionRuns.listForDocument(row.id)
    sources.push({
      document,
      metricsJson: run?.metrics_json ?? null,
      templateFingerprint: await ensureFingerprint(repo, row, firstPageLines)
    })
  }

  return buildXlsxRows(sources)
}

// ---------------------------------------------------------------------------
// Il file
// ---------------------------------------------------------------------------

/** Larghezze in caratteri: i testi lunghi (evidenze, valori) hanno colonne larghe. */
const WIDTHS: Record<string, number> = {
  document_id: 38,
  drive_file_id: 36,
  document_type_predicted: 30,
  document_type_final: 30,
  classifier_confidence: 12,
  runner_up: 30,
  margin: 10,
  template_fingerprint: 18,
  review_status: 14,
  field_name: 26,
  label: 26,
  role: 12,
  cardinality: 12,
  item_index: 10,
  value_predicted: 40,
  value_final: 40,
  origin: 10,
  confidence: 12,
  evidence_page: 12,
  evidence_text: 60,
  evidence_bbox: 26
}

/** Le colonne con tre decimali: confidence e margini sono numeri, non testo. */
const DECIMALS = new Set(['classifier_confidence', 'margin', 'confidence'])

function addSheet<T extends XlsxDocumentRow | XlsxFieldRow>(
  workbook: ExcelJS.Workbook,
  name: string,
  columns: Array<keyof T>,
  rows: T[]
): void {
  const sheet = workbook.addWorksheet(name)
  sheet.columns = columns.map((key) => ({
    header: String(key),
    key: String(key),
    width: WIDTHS[String(key)] ?? 20,
    ...(DECIMALS.has(String(key)) ? { style: { numFmt: '0.000' } } : {})
  }))
  sheet.getRow(1).font = { bold: true }
  // La riga delle intestazioni resta visibile scorrendo: senza, a metà foglio non si sa
  // più quale colonna si sta leggendo.
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
  for (const row of rows) sheet.addRow(row)
}

/**
 * Scrive il file: due fogli, `documents` e `fields`. I valori nulli restano celle vuote
 * — exceljs non scrive `null` — e i numeri restano numeri, così le colonne si filtrano
 * e si sommano senza riconvertirle.
 */
export async function writeXlsxFile(path: string, rows: XlsxRows): Promise<void> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'PraticaAI Reviewer'
  workbook.created = new Date()

  addSheet<XlsxDocumentRow>(workbook, 'documents', XLSX_DOCUMENT_COLUMNS, rows.documents)
  addSheet<XlsxFieldRow>(workbook, 'fields', XLSX_FIELD_COLUMNS, rows.fields)

  await workbook.xlsx.writeFile(path)
}
