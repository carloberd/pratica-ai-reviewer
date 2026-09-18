import type { BoundingBox, TextSource } from '@shared/types'

export interface TextLine {
  text: string
  /**
   * Riquadro della riga in unità di pagina pdf.js a scala 1, con origine in alto a
   * sinistra. Il visualizzatore moltiplica per la scala corrente del viewport.
   * Assente quando il testo viene da OCR o da DOCX.
   */
  bbox?: BoundingBox
}

export interface ExtractedPage {
  /** 1-based, come in pdf.js e come lo mostra la UI. */
  page: number
  text: string
  lines: TextLine[]
}

export interface ExtractedText {
  pages: ExtractedPage[]
  source: TextSource
  /** Pagine il cui testo è arrivato da OCR invece che dal text layer. */
  ocrPages: number[]
  /**
   * Pagine senza text layer che l'OCR non ha letto: servizio assente o richiesta
   * fallita. Restano vuote, e il documento va ripassato quando l'OCR torna. Una pagina
   * che l'OCR ha letto trovandoci nulla non è qui: lì non c'è niente da ritentare.
   */
  ocrFailedPages: number[]
  /** Perché l'OCR non ha letto quelle pagine, quando c'è un motivo da riportare. */
  ocrError?: string
}

/** Sotto questa soglia una pagina PDF è considerata senza text layer utile. */
export const MIN_CHARS_PER_PAGE = 100
