import { readFile } from 'node:fs/promises'
import {
  compose,
  IDENTITY,
  imageToPage,
  type Matrix,
  type PixelBox,
  pageBox
} from './page-placement'
import type { TextLine } from './types'

/**
 * Motore OCR (D2), per i PDF senza text layer.
 *
 * Invece di ri-rasterizzare la pagina, prende l'immagine che la pagina già contiene:
 * un PDF scansionato è esattamente questo, una fotografia del foglio. Si evita così
 * un passaggio di rendering e si lavora alla risoluzione originale della scansione.
 * Il testo esce da tesseract.js (wasm) con i modelli `ita` e `eng` di
 * `resources/tessdata`: niente binario di sistema e niente rete.
 *
 * Di ogni pagina escono anche le **righe con le coordinate**: tesseract le dà in pixel
 * dell'immagine, e la matrice con cui la pagina la disegna le porta in unità di pagina
 * (`page-placement.ts`). Senza coordinate una selezione su una scansione non si ritrova —
 * `locatePick` non ha righe da toccare — e il learner resta cieco proprio sui documenti su
 * cui il motore va peggio. Dove la matrice non si ricostruisce la riga resta senza
 * riquadro: una posizione indovinata insegnerebbe un'etichetta sbagliata.
 *
 * Il modulo non sa nulla di worker: è il worker a usarlo. Tenerli separati rende
 * l'OCR testabile in-process, senza dover prima impacchettare il main.
 */
export interface OcrPageText {
  page: number
  text: string
  /** Le righe lette, con le coordinate quando la collocazione dell'immagine si ricostruisce. */
  lines: TextLine[]
}

export interface OcrEngine {
  recognizePdfPages(pdfPath: string, pages: number[]): Promise<OcrPageText[]>
  /** Testo di una singola immagine già pronta, es. il ritaglio di una pagina. */
  recognizeImage(image: Uint8Array): Promise<string>
  dispose(): Promise<void>
}

export interface OcrEngineOptions {
  /** Cartella con `ita.traineddata.gz` e `eng.traineddata.gz`. */
  tessdataDir: string
  /** Dove tesseract.js scompatta i modelli. Senza, scriverebbe nella cwd del processo. */
  cachePath: string
}

/** Formati immagine che pdf.js restituisce in `page.objs`. */
const KIND_GRAYSCALE_1BPP = 1
const KIND_RGB_24BPP = 2
const KIND_RGBA_32BPP = 3

interface PdfImage {
  width: number
  height: number
  kind: number
  data: Uint8Array | Uint8ClampedArray
}

/** Converte l'immagine grezza di pdf.js in RGBA, l'unico formato che accetta ImageData. */
export function toRgba(image: PdfImage): Uint8ClampedArray {
  const { width, height, kind, data } = image
  const pixels = width * height
  const rgba = new Uint8ClampedArray(pixels * 4)

  if (kind === KIND_RGBA_32BPP) {
    rgba.set(data.subarray(0, pixels * 4))
    return rgba
  }

  if (kind === KIND_RGB_24BPP) {
    for (let pixel = 0, source = 0; pixel < pixels; pixel += 1, source += 3) {
      const target = pixel * 4
      rgba[target] = data[source] ?? 0
      rgba[target + 1] = data[source + 1] ?? 0
      rgba[target + 2] = data[source + 2] ?? 0
      rgba[target + 3] = 255
    }
    return rgba
  }

  if (kind === KIND_GRAYSCALE_1BPP) {
    // Un bit per pixel, righe allineate al byte; 0 = nero.
    const rowBytes = (width + 7) >> 3
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const byte = data[y * rowBytes + (x >> 3)] ?? 0
        const on = (byte >> (7 - (x & 7))) & 1
        const value = on ? 255 : 0
        const target = (y * width + x) * 4
        rgba[target] = value
        rgba[target + 1] = value
        rgba[target + 2] = value
        rgba[target + 3] = 255
      }
    }
    return rgba
  }

  throw new Error(`Formato immagine PDF non gestito (kind ${kind}).`)
}

export function createOcrEngine(options: OcrEngineOptions): OcrEngine {
  type TesseractWorker = Awaited<ReturnType<typeof startTesseract>>
  let tesseract: TesseractWorker | null = null

  async function startTesseract() {
    const { createWorker } = await import('tesseract.js')
    return createWorker(['ita', 'eng'], undefined, {
      langPath: options.tessdataDir,
      cachePath: options.cachePath,
      gzip: true,
      // Nessun log verso stdout: il main non deve riempirsi di righe di tesseract.
      logger: () => {}
    })
  }

  /**
   * PNG delle immagini contenute nelle pagine indicate, ognuna con la matrice che porta i
   * suoi pixel in unità di pagina.
   *
   * La matrice si segue sulla lista degli operatori: `save`/`restore` sono la pila,
   * `transform` la moltiplica, e un form XObject apre una parentesi con la sua. Quando
   * l'immagine viene disegnata, la matrice corrente è quella che manda il quadrato unitario
   * dove la pagina la mostra.
   */
  async function pageImages(
    pdfPath: string,
    pages: number[]
  ): Promise<Array<{ page: number; images: Array<{ png: Buffer; matrix: Matrix | null }> }>> {
    const [{ createCanvas, ImageData }, pdfjs] = await Promise.all([
      import('@napi-rs/canvas'),
      import('pdfjs-dist/legacy/build/pdf.mjs')
    ])

    const document = await pdfjs.getDocument({
      data: new Uint8Array(await readFile(pdfPath)),
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0
    }).promise

    const results: Array<{ page: number; images: Array<{ png: Buffer; matrix: Matrix | null }> }> =
      []
    try {
      for (const pageNumber of pages) {
        const page = await document.getPage(pageNumber)
        const operators = await page.getOperatorList()
        const viewport = page.getViewport({ scale: 1 }).transform as Matrix
        const images: Array<{ png: Buffer; matrix: Matrix | null }> = []

        let ctm: Matrix = IDENTITY
        const stack: Matrix[] = []
        for (let index = 0; index < operators.fnArray.length; index += 1) {
          const operator = operators.fnArray[index]
          const args = operators.argsArray[index]

          if (operator === pdfjs.OPS.save) {
            stack.push(ctm)
            continue
          }
          if (operator === pdfjs.OPS.restore) {
            ctm = stack.pop() ?? IDENTITY
            continue
          }
          if (operator === pdfjs.OPS.transform) {
            ctm = compose(ctm, args as Matrix)
            continue
          }
          if (operator === pdfjs.OPS.paintFormXObjectBegin) {
            stack.push(ctm)
            ctm = compose(ctm, args?.[0] as Matrix)
            continue
          }
          if (operator === pdfjs.OPS.paintFormXObjectEnd) {
            ctm = stack.pop() ?? IDENTITY
            continue
          }
          if (operator !== pdfjs.OPS.paintImageXObject) continue

          const name = args?.[0]
          if (typeof name !== 'string') continue

          const image = await new Promise<PdfImage | null>((resolve) => {
            try {
              page.objs.get(name, (value: unknown) => resolve((value as PdfImage) ?? null))
            } catch {
              resolve(null)
            }
          })
          if (!image?.data || !image.width || !image.height) continue

          const canvas = createCanvas(image.width, image.height)
          canvas
            .getContext('2d')
            .putImageData(new ImageData(toRgba(image), image.width, image.height), 0, 0)
          images.push({
            png: canvas.toBuffer('image/png'),
            matrix: imageToPage(ctm, viewport, image.width, image.height)
          })
        }

        results.push({ page: pageNumber, images })
        page.cleanup()
      }
    } finally {
      await document.destroy()
    }

    return results
  }

  return {
    async recognizePdfPages(pdfPath, pages) {
      if (pages.length === 0) return []
      const scanned = await pageImages(pdfPath, pages)
      const withImages = scanned.filter((entry) => entry.images.length > 0)
      if (withImages.length === 0) return []

      tesseract ??= await startTesseract()

      const results: OcrPageText[] = []
      for (const entry of withImages) {
        const parts: string[] = []
        const lines: TextLine[] = []
        for (const image of entry.images) {
          // `blocks` porta la struttura — blocchi, paragrafi, righe, parole — con i
          // riquadri in pixel. Senza, tesseract restituisce solo il testo.
          const { data } = await tesseract.recognize(image.png, {}, { text: true, blocks: true })
          if (data.text) parts.push(data.text.trim())
          lines.push(...linesOf(data.blocks, image.matrix))
        }
        results.push({ page: entry.page, text: parts.join('\n'), lines })
      }
      return results
    },

    async recognizeImage(image) {
      tesseract ??= await startTesseract()
      const { data } = await tesseract.recognize(Buffer.from(image))
      return data.text?.trim() ?? ''
    },

    async dispose() {
      await tesseract?.terminate()
      tesseract = null
    }
  }
}

/**
 * Le righe lette da tesseract, ripiegate come le righe dell'estrazione: testo su una riga
 * sola, spazi in uno. Il riquadro c'è quando la collocazione dell'immagine si conosce;
 * altrimenti la riga resta senza, come prima di questa versione.
 */
function linesOf(blocks: TesseractBlocks, matrix: Matrix | null): TextLine[] {
  const lines: TextLine[] = []
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const text = (line.text ?? '').replace(/\s+/g, ' ').trim()
        if (text.length === 0) continue
        const box = matrix && line.bbox ? pageBox(matrix, line.bbox) : null
        lines.push({ text, ...(box ? { bbox: box } : {}) })
      }
    }
  }
  return lines
}

/** Quello che serve qui della struttura di tesseract: righe con testo e riquadro. */
type TesseractBlocks =
  | Array<{
      paragraphs?: Array<{ lines?: Array<{ text?: string; bbox?: PixelBox }> }>
    }>
  | null
  | undefined
