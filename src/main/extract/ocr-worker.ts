import { parentPort, workerData } from 'node:worker_threads'
import { createOcrEngine } from './ocr-engine'

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

export interface OcrRequest {
  id: number
  pdfPath: string
  pages: number[]
}

export type OcrResponse =
  | { id: number; ok: true; pages: Array<{ page: number; text: string }> }
  | { id: number; ok: false; message: string }

const port = parentPort

if (port) {
  const engine = createOcrEngine(workerData as OcrWorkerData)

  port.on('message', async (request: OcrRequest) => {
    try {
      const pages = await engine.recognizePdfPages(request.pdfPath, request.pages)
      port.postMessage({ id: request.id, ok: true, pages } satisfies OcrResponse)
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
