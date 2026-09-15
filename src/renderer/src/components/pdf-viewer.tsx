import type { Annotation, BoundingBox, EvidenceItem } from '@shared/types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cx } from '../lib/cx'
import { errorMessage } from '../lib/ipc'
import { loadPdf } from '../lib/pdf'
import styles from './document-review.module.css'

export type DrawMode = 'none' | 'highlight' | 'note'

interface Props {
  documentId: string
  read: (documentId: string) => Promise<ArrayBuffer>
  evidence: EvidenceItem[]
  annotations: Annotation[]
  /** Evidenza da raggiungere: la pagina scorre e il riquadro lampeggia. */
  focusedEvidenceId: string | null
  mode: DrawMode
  onDraw: (page: number, bbox: BoundingBox) => void
  onSelectAnnotation: (annotation: Annotation) => void
}

interface RenderedPage {
  page: number
  width: number
  height: number
  canvas: HTMLCanvasElement
}

const SCALE = 1.4

/**
 * Visualizzatore PDF con layer di overlay.
 *
 * Le evidenze e le annotazioni sono riquadri assoluti sopra il canvas: le coordinate
 * salvate sono in unità di pagina pdf.js a scala 1 con origine in alto a sinistra,
 * quindi qui basta moltiplicarle per la scala del viewport. Il PDF non viene mai
 * modificato (D3).
 */
export default function PdfViewer({
  documentId,
  read,
  evidence,
  annotations,
  focusedEvidenceId,
  mode,
  onDraw,
  onSelectAnnotation
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [pages, setPages] = useState<RenderedPage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [drawing, setDrawing] = useState<{ page: number; box: BoundingBox } | null>(null)
  const dragStart = useRef<{ page: number; x: number; y: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setPages([])

    read(documentId)
      .then(async (data) => {
        const pdf = await loadPdf(data)
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
          rendered.push({ page: number, width: canvas.width, height: canvas.height, canvas })
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
    }
  }, [documentId, read])

  const focused = evidence.find((item) => item.id === focusedEvidenceId)

  useEffect(() => {
    if (!focused || pages.length === 0) return
    const target = containerRef.current?.querySelector<HTMLElement>(`[data-page="${focused.page}"]`)
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [focused, pages.length])

  const toPageCoordinates = useCallback(
    (element: HTMLElement, clientX: number, clientY: number) => {
      const rect = element.getBoundingClientRect()
      return { x: (clientX - rect.left) / SCALE, y: (clientY - rect.top) / SCALE }
    },
    []
  )

  if (loading) return <div className={styles.spinner}>Carico il PDF…</div>
  if (error) return <div className={styles.error}>{error}</div>

  return (
    <div className={styles.pdfCanvasWrap} ref={containerRef}>
      {pages.map((rendered) => (
        <div
          key={rendered.page}
          className={styles.pdfPage}
          data-page={rendered.page}
          style={{ width: rendered.width, height: rendered.height }}
        >
          <CanvasHost canvas={rendered.canvas} />

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

            {annotations
              .filter((annotation) => annotation.page === rendered.page)
              .map((annotation) => (
                <button
                  type="button"
                  key={annotation.id}
                  className={cx(
                    styles.pdfHighlight,
                    annotation.kind === 'note' ? styles.pdfAnnotationNote : styles.pdfAnnotation
                  )}
                  title={annotation.note ?? 'Evidenziazione'}
                  style={boxStyle(annotation.bbox)}
                  onClick={() => onSelectAnnotation(annotation)}
                />
              ))}

            {drawing?.page === rendered.page && (
              <div className={styles.pdfSelection} style={boxStyle(drawing.box)} />
            )}
          </div>

          {mode !== 'none' && (
            // Superficie di disegno: creare un'annotazione è un gesto di puntatore, in
            // v1 non c'è un equivalente da tastiera.
            <div
              role="application"
              aria-label="Area di disegno delle annotazioni"
              className={styles.pdfDrawLayer}
              onMouseDown={(event) => {
                const host = event.currentTarget
                const point = toPageCoordinates(host, event.clientX, event.clientY)
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
                // Un clic senza trascinamento non è un'annotazione.
                if (current && current.box.w > 4 && current.box.h > 4) {
                  onDraw(current.page, round(current.box))
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

function round(box: BoundingBox): BoundingBox {
  const fix = (value: number) => Math.round(value * 100) / 100
  return { x: fix(box.x), y: fix(box.y), w: fix(box.w), h: fix(box.h) }
}
