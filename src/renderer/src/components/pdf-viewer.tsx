import type { BoundingBox, EvidenceItem } from '@shared/types'
import { TextLayer } from 'pdfjs-dist'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cx } from '../lib/cx'
import { api, errorMessage } from '../lib/ipc'
import { loadPdf, type PdfDocument } from '../lib/pdf'
import styles from './document-review.module.css'

interface Props {
  documentId: string
  read: (documentId: string) => Promise<ArrayBuffer>
  evidence: EvidenceItem[]
  /** Evidenza da raggiungere: la pagina scorre e il riquadro lampeggia. */
  focusedEvidenceId: string | null
  /** Etichetta del campo che sta aspettando un valore, `null` se nessuno. */
  captureTarget: string | null
  onCapture: (text: string) => void
}

interface RenderedPage {
  page: number
  width: number
  height: number
  canvas: HTMLCanvasElement
  /** Assente quando la pagina non ha un text layer, cioè nelle scansioni. */
  text: HTMLDivElement | null
}

const SCALE = 1.4
/** Il ritaglio va all'OCR: più grande della resa a schermo, o si legge male. */
const OCR_SCALE = 3

type Mode = 'text' | 'area'

/**
 * Visualizzatore PDF con layer di testo e di overlay.
 *
 * Le evidenze sono riquadri assoluti sopra il canvas: le coordinate salvate sono in
 * unità di pagina pdf.js a scala 1 con origine in alto a sinistra, quindi qui basta
 * moltiplicarle per la scala del viewport. Il PDF non viene mai modificato (D3).
 *
 * Sopra al canvas c'è il text layer di pdf.js: trasparente, ma selezionabile, ed è
 * da lì che si prende il testo per compilare un campo. Sulle scansioni quel layer è
 * vuoto — non c'è testo, solo pixel — e allora si evidenzia un'area, che viene
 * rasterizzata e passata all'OCR del main.
 */
export default function PdfViewer({
  documentId,
  read,
  evidence,
  focusedEvidenceId,
  captureTarget,
  onCapture
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const pdfRef = useRef<PdfDocument | null>(null)
  const [pages, setPages] = useState<RenderedPage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('text')
  const [drawing, setDrawing] = useState<{ page: number; box: BoundingBox } | null>(null)
  const [reading, setReading] = useState(false)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const dragStart = useRef<{ page: number; x: number; y: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setPages([])

    read(documentId)
      .then(async (data) => {
        const pdf = await loadPdf(data)
        // Il documento resta aperto: serve a ritagliare le aree da leggere con OCR.
        if (cancelled) {
          void pdf.destroy()
          return
        }
        pdfRef.current = pdf
        const rendered: RenderedPage[] = []
        for (let number = 1; number <= pdf.numPages; number += 1) {
          if (cancelled) break
          const page = await pdf.getPage(number)
          const viewport = page.getViewport({ scale: SCALE })
          const canvas = document.createElement('canvas')
          canvas.width = Math.ceil(viewport.width)
          canvas.height = Math.ceil(viewport.height)
          const context = canvas.getContext('2d')
          if (!context) continue
          await page.render({ canvasContext: context, canvas, viewport }).promise

          const text = document.createElement('div')
          text.className = styles.textLayer ?? ''
          text.style.setProperty('--total-scale-factor', String(SCALE))
          try {
            const layer = new TextLayer({
              textContentSource: await page.getTextContent(),
              container: text,
              viewport
            })
            await layer.render()
          } catch {
            // Senza text layer resta la selezione ad area con OCR: la pagina si vede
            // comunque, ed è il caso normale delle scansioni.
          }

          rendered.push({
            page: number,
            width: canvas.width,
            height: canvas.height,
            canvas,
            text: text.childElementCount > 0 ? text : null
          })
          page.cleanup()
        }
        if (cancelled) return
        setPages(rendered)
        setLoading(false)
      })
      .catch((caught) => {
        if (cancelled) return
        setError(errorMessage(caught))
        setLoading(false)
      })

    return () => {
      cancelled = true
      void pdfRef.current?.destroy()
      pdfRef.current = null
    }
  }, [documentId, read])

  const focused = evidence.find((item) => item.id === focusedEvidenceId)

  useEffect(() => {
    if (!focused || pages.length === 0) return
    const target = containerRef.current?.querySelector<HTMLElement>(`[data-page="${focused.page}"]`)
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [focused, pages.length])

  // Su una scansione non c'è testo da selezionare: lo strumento buono è già l'area.
  useEffect(() => {
    if (pages.length > 0) setMode(pages.some((page) => page.text) ? 'text' : 'area')
  }, [pages])

  const toPageCoordinates = useCallback(
    (element: HTMLElement, clientX: number, clientY: number) => {
      const rect = element.getBoundingClientRect()
      return { x: (clientX - rect.left) / SCALE, y: (clientY - rect.top) / SCALE }
    },
    []
  )

  /** Testo selezionato con il mouse: va nel campo attivo così com'è nel documento. */
  function captureSelection() {
    if (mode !== 'text' || !captureTarget) return
    const selection = window.getSelection()
    const text = selection?.toString() ?? ''
    if (!text.trim()) return
    selection?.removeAllRanges()
    onCapture(text)
  }

  /** Ritaglia l'area evidenziata e la manda all'OCR del main. */
  async function captureArea(pageNumber: number, box: BoundingBox) {
    const pdf = pdfRef.current
    if (!pdf || !captureTarget) return

    setReading(true)
    setCaptureError(null)
    try {
      const page = await pdf.getPage(pageNumber)
      const viewport = page.getViewport({ scale: OCR_SCALE })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(box.w * OCR_SCALE)
      canvas.height = Math.ceil(box.h * OCR_SCALE)
      const context = canvas.getContext('2d')
      if (!context) return

      // Fondo bianco: un PNG trasparente diventa nero su nero per tesseract.
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({
        canvasContext: context,
        canvas,
        viewport,
        transform: [1, 0, 0, 1, -box.x * OCR_SCALE, -box.y * OCR_SCALE]
      }).promise
      page.cleanup()

      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('Non sono riuscito a ritagliare l’area.')

      const { text } = await api.ocr.region(new Uint8Array(await blob.arrayBuffer()))
      if (!text.trim()) {
        setCaptureError('Nessun testo riconosciuto nell’area evidenziata.')
        return
      }
      onCapture(text)
    } catch (caught) {
      setCaptureError(errorMessage(caught))
    } finally {
      setReading(false)
    }
  }

  if (loading) return <div className={styles.spinner}>Carico il PDF…</div>
  if (error) return <div className={styles.error}>{error}</div>

  return (
    <>
      <div className={styles.viewerBar}>
        <span className={styles.muted}>
          {captureTarget ? (
            <>
              Compilo <strong>{captureTarget}</strong> con quello che selezioni qui.
            </>
          ) : (
            'Metti il cursore in un campo per compilarlo dal documento.'
          )}
        </span>
        <span className={styles.spacer} />
        <button
          type="button"
          className={cx(styles.button, styles.buttonSmall, mode === 'text' && styles.buttonPrimary)}
          onClick={() => setMode('text')}
        >
          Seleziona testo
        </button>
        <button
          type="button"
          className={cx(styles.button, styles.buttonSmall, mode === 'area' && styles.buttonPrimary)}
          disabled={!captureTarget || reading}
          title={
            captureTarget
              ? 'Evidenzia un’area della pagina: il testo viene letto con OCR.'
              : 'Metti prima il cursore in un campo.'
          }
          onClick={() => setMode('area')}
        >
          {reading ? 'Leggo l’area…' : 'Evidenzia area (OCR)'}
        </button>
      </div>
      {captureError && <div className={styles.error}>{captureError}</div>}

      {/* La selezione è un gesto di puntatore: la cattura avviene quando si rilascia. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: il testo si seleziona con il mouse */}
      <div className={styles.pdfCanvasWrap} ref={containerRef} onMouseUp={captureSelection}>
        {pages.map((rendered) => (
          <div
            key={rendered.page}
            className={styles.pdfPage}
            data-page={rendered.page}
            style={{ width: rendered.width, height: rendered.height }}
          >
            <CanvasHost canvas={rendered.canvas} />
            {rendered.text && <LayerHost layer={rendered.text} />}

            <div className={styles.pdfOverlay}>
              {evidence
                .filter((item) => item.page === rendered.page && item.bbox)
                .map((item) => (
                  <div
                    key={item.id}
                    className={cx(
                      styles.pdfHighlight,
                      item.id === focusedEvidenceId
                        ? styles.pdfHighlightFlash
                        : styles.pdfHighlightEvidence
                    )}
                    title={item.label}
                    style={boxStyle(item.bbox!)}
                  />
                ))}

              {drawing?.page === rendered.page && (
                <div className={styles.pdfSelection} style={boxStyle(drawing.box)} />
              )}
            </div>

            {mode === 'area' && captureTarget && (
              // Superficie di disegno: evidenziare un'area è un gesto di puntatore,
              // in v1 non c'è un equivalente da tastiera.
              <div
                role="application"
                aria-label="Area da leggere con OCR"
                className={styles.pdfDrawLayer}
                onMouseDown={(event) => {
                  const point = toPageCoordinates(event.currentTarget, event.clientX, event.clientY)
                  dragStart.current = { page: rendered.page, ...point }
                  setDrawing({ page: rendered.page, box: { ...point, w: 0, h: 0 } })
                }}
                onMouseMove={(event) => {
                  const start = dragStart.current
                  if (!start || start.page !== rendered.page) return
                  const point = toPageCoordinates(event.currentTarget, event.clientX, event.clientY)
                  setDrawing({ page: rendered.page, box: rectBetween(start, point) })
                }}
                onMouseUp={() => {
                  const current = drawing
                  dragStart.current = null
                  setDrawing(null)
                  // Un clic senza trascinamento non è un'area.
                  if (current && current.box.w > 4 && current.box.h > 4) {
                    void captureArea(current.page, current.box)
                  }
                }}
                onMouseLeave={() => {
                  dragStart.current = null
                  setDrawing(null)
                }}
              />
            )}
          </div>
        ))}
      </div>
    </>
  )
}

/** Il canvas è prodotto da pdf.js, quindi va innestato invece che ridisegnato da React. */
function CanvasHost({ canvas }: { canvas: HTMLCanvasElement }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = host.current
    if (!element) return
    element.replaceChildren(canvas)
    return () => element.replaceChildren()
  }, [canvas])

  return <div ref={host} />
}

/** Come sopra per il text layer, che pdf.js costruisce nodo per nodo. */
function LayerHost({ layer }: { layer: HTMLDivElement }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = host.current
    if (!element) return
    element.replaceChildren(layer)
    return () => element.replaceChildren()
  }, [layer])

  return <div ref={host} />
}

function boxStyle(box: BoundingBox): React.CSSProperties {
  return {
    left: box.x * SCALE,
    top: box.y * SCALE,
    width: box.w * SCALE,
    height: box.h * SCALE
  }
}

function rectBetween(start: { x: number; y: number }, end: { x: number; y: number }): BoundingBox {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    w: Math.abs(end.x - start.x),
    h: Math.abs(end.y - start.y)
  }
}
