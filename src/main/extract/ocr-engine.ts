import { readFile } from 'node:fs/promises'

/**
 * Motore OCR (D2), per i PDF senza text layer.
 *
 * Invece di ri-rasterizzare la pagina, prende l'immagine che la pagina già contiene:
 * un PDF scansionato è esattamente questo, una fotografia del foglio. Si evita così
 * un passaggio di rendering e si lavora alla risoluzione originale della scansione.
 * Il testo esce da tesseract.js (wasm) con i modelli `ita` e `eng` di
 * `resources/tessdata`: niente binario di sistema e niente rete.
 *
 * Il modulo non sa nulla di worker: è il worker a usarlo. Tenerli separati rende
 * l'OCR testabile in-process, senza dover prima impacchettare il main.
 */
export interface OcrEngine {
  recognizePdfPages(
    pdfPath: string,
    pages: number[]
  ): Promise<Array<{ page: number; text: string }>>
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

  /** PNG delle immagini contenute nelle pagine indicate. */
  async function pageImages(
    pdfPath: string,
    pages: number[]
  ): Promise<Array<{ page: number; pngs: Buffer[] }>> {
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

    const results: Array<{ page: number; pngs: Buffer[] }> = []
    try {
      for (const pageNumber of pages) {
        const page = await document.getPage(pageNumber)
        const operators = await page.getOperatorList()
        const pngs: Buffer[] = []

        for (let index = 0; index < operators.fnArray.length; index += 1) {
          if (operators.fnArray[index] !== pdfjs.OPS.paintImageXObject) continue
          const name = operators.argsArray[index]?.[0]
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
          pngs.push(canvas.toBuffer('image/png'))
        }

        results.push({ page: pageNumber, pngs })
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
      const images = await pageImages(pdfPath, pages)
      const withImages = images.filter((entry) => entry.pngs.length > 0)
      if (withImages.length === 0) return []

      tesseract ??= await startTesseract()

      const results: Array<{ page: number; text: string }> = []
      for (const entry of withImages) {
        const parts: string[] = []
        for (const png of entry.pngs) {
          const { data } = await tesseract.recognize(png)
          if (data.text) parts.push(data.text.trim())
        }
        results.push({ page: entry.page, text: parts.join('\n') })
      }
      return results
    },

    async dispose() {
      await tesseract?.terminate()
      tesseract = null
    }
  }
}
