import { DOCX_MIME, PDF_MIME } from '../drive/client'
import { logError, ReviewerError } from '../errors'
import { extractDocxPages } from './docx'
import type { OcrService } from './ocr'
import { extractPdfPages } from './pdf'
import { type ExtractedPage, type ExtractedText, MIN_CHARS_PER_PAGE } from './types'

export interface ExtractOptions {
  filePath: string
  mime: string
  /** Assente in ambienti dove l'OCR non è disponibile: le pagine scansionate restano vuote. */
  ocr?: OcrService | undefined
}

/** Pagine con meno di 100 caratteri: text layer assente o inutilizzabile. */
export function pagesNeedingOcr(pages: ExtractedPage[]): number[] {
  return pages.filter((page) => page.text.trim().length < MIN_CHARS_PER_PAGE).map((p) => p.page)
}

/**
 * Testo paginato del documento.
 *
 * D2: l'OCR interviene solo dove serve davvero, cioè sulle pagine senza text layer.
 * Passare un PDF nativo da tesseract sarebbe più lento e meno accurato del testo che
 * il PDF già contiene.
 */
export async function extractText(options: ExtractOptions): Promise<ExtractedText> {
  if (options.mime === DOCX_MIME) {
    return {
      pages: await extractDocxPages(options.filePath),
      source: 'DOCX',
      ocrPages: [],
      ocrFailedPages: []
    }
  }

  if (options.mime !== PDF_MIME) {
    throw new ReviewerError('UNSUPPORTED', `Tipo di file non gestito: ${options.mime}`)
  }

  const pages = await extractPdfPages(options.filePath)
  const candidates = pagesNeedingOcr(pages)

  if (candidates.length === 0) {
    return { pages, source: 'NATIVE_TEXT', ocrPages: [], ocrFailedPages: [] }
  }

  // Pagine scansionate e nessun OCR: il testo non c'è, e dirlo `NATIVE_TEXT` farebbe
  // passare per completo un documento da cui non si è letto niente.
  if (!options.ocr) {
    return {
      pages,
      source: 'OCR_FAILED',
      ocrPages: [],
      ocrFailedPages: candidates,
      ocrError: 'Servizio OCR non disponibile in questo ambiente.'
    }
  }

  let recognized: Map<number, string>
  try {
    recognized = await options.ocr.recognize(options.filePath, candidates)
  } catch (error) {
    // Un OCR fallito non deve far perdere il testo nativo delle altre pagine, ma non può
    // nemmeno passare per un documento letto: le pagine scansionate restano da leggere.
    logError('extract.ocr', error)
    return {
      pages,
      source: 'OCR_FAILED',
      ocrPages: [],
      ocrFailedPages: candidates,
      ocrError: error instanceof Error ? error.message : String(error)
    }
  }

  const ocrPages: number[] = []
  const merged = pages.map((page) => {
    const text = recognized.get(page.page)?.trim()
    if (!text || text.length < page.text.trim().length) return page
    ocrPages.push(page.page)
    return {
      page: page.page,
      text,
      // L'OCR non restituisce coordinate utilizzabili per le evidenze: righe senza bbox.
      lines: text
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter((line) => line.length > 0)
        .map((line) => ({ text: line }))
    }
  })

  // Una pagina su cui l'OCR ha girato senza trovare testo (una pagina bianca, o solo
  // grafica vettoriale) non è un fallimento: non c'è niente da ritentare.
  const ocrFailedPages = candidates.filter((page) => !recognized.has(page))

  return {
    pages: merged,
    source: ocrPages.length > 0 ? 'OCR' : ocrFailedPages.length > 0 ? 'OCR_FAILED' : 'NATIVE_TEXT',
    ocrPages,
    ocrFailedPages
  }
}
