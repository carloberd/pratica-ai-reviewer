import { Worker } from 'node:worker_threads'
import { ReviewerError } from '../errors'
import type { OcrRequest, OcrResponse, OcrWorkerData } from './ocr-worker'

export interface OcrService {
  /** Testo delle pagine indicate, per numero di pagina. */
  recognize(pdfPath: string, pages: number[]): Promise<Map<number, string>>
  dispose(): Promise<void>
}

export interface OcrOptions {
  /** Percorso di `ocr-worker.js` nel bundle del main. */
  workerPath: string
  /** Cartella con `ita.traineddata.gz` e `eng.traineddata.gz`. */
  tessdataDir: string
  /** Dove tesseract.js scompatta i modelli. */
  cachePath: string
  /** Oltre questo tempo una pagina viene considerata persa. */
  timeoutMs?: number
}

/**
 * Client del worker OCR. Il worker viene creato alla prima richiesta e riusato:
 * inizializzare tesseract costa qualche secondo e non ha senso pagarlo per pagina.
 */
export function createOcrService(options: OcrOptions): OcrService {
  const timeoutMs = options.timeoutMs ?? 120_000
  let worker: Worker | null = null
  let nextId = 1
  const pending = new Map<number, (response: OcrResponse) => void>()

  function ensureWorker(): Worker {
    if (worker) return worker
    const created = new Worker(options.workerPath, {
      workerData: {
        tessdataDir: options.tessdataDir,
        cachePath: options.cachePath
      } satisfies OcrWorkerData
    })
    created.on('message', (response: OcrResponse) => {
      pending.get(response.id)?.(response)
      pending.delete(response.id)
    })
    created.on('error', (error) => {
      for (const resolve of pending.values()) {
        resolve({ id: -1, ok: false, message: error.message })
      }
      pending.clear()
      worker = null
    })
    created.on('exit', () => {
      worker = null
    })
    created.unref()
    worker = created
    return created
  }

  return {
    async recognize(pdfPath, pages) {
      if (pages.length === 0) return new Map()

      const active = ensureWorker()
      const id = nextId++
      const request: OcrRequest = { id, pdfPath, pages }

      const response = await new Promise<OcrResponse>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          resolve({ id, ok: false, message: 'OCR interrotto: tempo massimo superato.' })
        }, timeoutMs)

        pending.set(id, (value) => {
          clearTimeout(timer)
          resolve(value)
        })
        active.postMessage(request)
      })

      if (!response.ok) {
        throw new ReviewerError('EXTRACTION_FAILED', `OCR non riuscito: ${response.message}`)
      }

      return new Map(response.pages.map((page) => [page.page, page.text]))
    },

    async dispose() {
      await worker?.terminate()
      worker = null
      pending.clear()
    }
  }
}
