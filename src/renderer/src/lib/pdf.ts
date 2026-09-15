import * as pdfjs from 'pdfjs-dist'
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'

/**
 * pdf.js nel renderer.
 *
 * Il worker viene creato da un blob invece che da un file servito: in produzione la
 * pagina è caricata da `file://`, dove un worker su URL relativo verrebbe bloccato.
 * Il blob resta comunque locale — la CSP consente `worker-src 'self' blob:` e nessuna
 * risorsa remota — e il PDF arriva dalla cache su disco via IPC, mai dalla rete.
 */
let workerUrl: string | null = null

function ensureWorker(): void {
  if (workerUrl) return
  workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
}

export type PdfDocument = Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>

export async function loadPdf(data: ArrayBuffer): Promise<PdfDocument> {
  ensureWorker()
  return pdfjs.getDocument({
    data: new Uint8Array(data),
    // Nessun font di sistema e nessuna risorsa esterna.
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0
  }).promise
}
