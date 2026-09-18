import { parentPort, workerData } from 'node:worker_threads'
import { createOcrEngine, type OcrPageText } from './ocr-engine'

/**
 * Worker OCR (D2).
 *
 * Gira in un `worker_thread` perché fa due cose costose che non devono bloccare il
 * processo main: rasterizza le pagine del PDF e le passa a tesseract.js. La logica
 * vera sta in `ocr-engine.ts`; qui c'è solo il protocollo di messaggi.
 */
export interface OcrWorkerData {
  tessdataDir: string
  cachePath: string
}

export type OcrRequest =
  /** Pagine di un PDF senza text layer, durante la precompilazione. */
  | { id: number; kind: 'pages'; pdfPath: string; pages: number[] }
  /** Ritaglio di pagina arrivato dalla revisione, per compilare un campo. */
  | { id: number; kind: 'image'; image: Uint8Array }

export type OcrResponse =
  /** Le pagine lette, col testo e le righe: le righe portano le coordinate quando ci sono. */
  | { id: number; ok: true; kind: 'pages'; pages: OcrPageText[] }
  | { id: number; ok: true; kind: 'image'; text: string }
  | { id: number; ok: false; message: string }

const port = parentPort

if (port) {
  const engine = createOcrEngine(workerData as OcrWorkerData)

  port.on('message', async (request: OcrRequest) => {
    try {
      if (request.kind === 'image') {
        const text = await engine.recognizeImage(request.image)
        port.postMessage({ id: request.id, ok: true, kind: 'image', text } satisfies OcrResponse)
        return
      }
      const pages = await engine.recognizePdfPages(request.pdfPath, request.pages)
      port.postMessage({ id: request.id, ok: true, kind: 'pages', pages } satisfies OcrResponse)
    } catch (error) {
      port.postMessage({
        id: request.id,
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      } satisfies OcrResponse)
    }
  })

  port.on('close', () => {
    void engine.dispose()
  })
}
