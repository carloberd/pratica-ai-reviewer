import type { BoundingBox, EvidenceItem } from '@shared/types'
import { useEffect, useRef, useState } from 'react'
import { cx } from '../lib/cx'
import { errorMessage } from '../lib/ipc'
import { loadPdf } from '../lib/pdf'
import styles from './document-review.module.css'

interface Props {
  documentId: string
  read: (documentId: string) => Promise<ArrayBuffer>
  evidence: EvidenceItem[]
  /** Evidenza da raggiungere: la pagina scorre e il riquadro lampeggia. */
  focusedEvidenceId: string | null
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
 * Le evidenze sono riquadri assoluti sopra il canvas: le coordinate salvate sono in
 * unità di pagina pdf.js a scala 1 con origine in alto a sinistra, quindi qui basta
 * moltiplicarle per la scala del viewport. Il PDF non viene mai modificato (D3).
 */
export default function PdfViewer({ documentId, read, evidence, focusedEvidenceId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [pages, setPages] = useState<RenderedPage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
          </div>
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
