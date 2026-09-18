import { type EvidenceTarget, matchSpans, unionRect } from '@shared/evidence-locate'
import type { BoundingBox, DocumentPick, EvidenceItem } from '@shared/types'
import { TextLayer } from 'pdfjs-dist'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type AreaChar, areaText } from '../lib/area-text'
import { cx } from '../lib/cx'
import { api, errorMessage } from '../lib/ipc'
import { loadPdf, type PdfDocument } from '../lib/pdf'
import { selectionBox } from '../lib/selection'
import styles from './document-review.module.css'

/**
 * Richiesta di portare il documento a un punto. `seq` cambia a ogni clic: cliccare due
 * volte la stessa evidenza deve riportarci anche se nel frattempo si è scorso altrove.
 */
export interface EvidenceFocus {
  target: EvidenceTarget
  seq: number
}

interface Props {
  documentId: string
  read: (documentId: string) => Promise<ArrayBuffer>
  evidence: EvidenceItem[]
  /** Punto da raggiungere: la pagina scorre fino alla riga e la riga si evidenzia. */
  focus: EvidenceFocus | null
  /** Etichetta del campo che sta aspettando un valore, `null` se nessuno. */
  captureTarget: string | null
  /** Il testo preso dal documento e, quando si sa, il punto da cui viene. */
  onCapture: (text: string, pick?: DocumentPick) => void
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

/** Il punto raggiunto: il rettangolo della riga, o la sola pagina quando non si trova. */
interface Located {
  page: number
  box: BoundingBox | null
  seq: number
}

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
 *
 * L'area vale anche sulle pagine che il testo ce l'hanno, ed è lo strumento che il
 * revisore usa più spesso perché è più rapido: lì il testo si legge dal text layer, non
 * dai pixel. Rileggere con l'OCR un testo che c'è già introduce uno scarto da quello su
 * cui lavora il motore — ed è quello scarto che poi fa perdere la posizione della
 * selezione, e con essa l'occasione di imparare.
 */
export default function PdfViewer({
  documentId,
  read,
  evidence,
  focus,
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
  const [located, setLocated] = useState<Located | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setPages([])
    setLocated(null)

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

  /**
   * Porta il documento al punto richiesto. Con le coordinate salvate si evidenzia il
   * rettangolo; senza, si cerca la riga nel text layer della pagina; se la pagina non ha
   * testo (una scansione letta con OCR) si arriva alla pagina e la si segnala intera.
   */
  useEffect(() => {
    const container = containerRef.current
    if (!focus || !container || pages.length === 0) return
    const { target } = focus
    const pageElement = container.querySelector<HTMLElement>(`[data-page="${target.page}"]`)
    if (!pageElement) return

    const rendered = pages.find((page) => page.page === target.page)
    const box =
      target.bbox ??
      (rendered?.text ? locateInTextLayer(rendered.text, pageElement, target.text) : null)
    setLocated({ page: target.page, box, seq: focus.seq })

    // La riga a un terzo dell'altezza: si vede anche quello che le sta sopra.
    const top = box
      ? pageElement.offsetTop + box.y * SCALE - container.clientHeight / 3
      : pageElement.offsetTop - 12
    const left = box ? pageElement.offsetLeft + box.x * SCALE - 24 : container.scrollLeft
    container.scrollTo({ top: Math.max(0, top), left: Math.max(0, left), behavior: 'smooth' })
  }, [focus, pages])

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

  /**
   * Testo selezionato con il mouse: va nel campo attivo così com'è nel documento, con la
   * pagina e il riquadro da cui viene. Il riquadro si legge prima di togliere la selezione,
   * che dopo non ha più rettangoli.
   */
  function captureSelection() {
    if (mode !== 'text' || !captureTarget) return
    const selection = window.getSelection()
    const text = selection?.toString() ?? ''
    if (!text.trim()) return
    const pick =
      selection && selection.rangeCount > 0 ? pickOf(selection.getRangeAt(0), text) : null
    selection?.removeAllRanges()
    onCapture(text, pick ?? undefined)
  }

  /**
   * Il testo del text layer dentro l'area evidenziata, `null` se la pagina non ha testo o
   * se nel riquadro non ne cade nessuno.
   */
  function areaFromTextLayer(pageNumber: number, box: BoundingBox): DocumentPick | null {
    const layer = pages.find((page) => page.page === pageNumber)?.text
    const pageElement = containerRef.current?.querySelector<HTMLElement>(
      `[data-page="${pageNumber}"]`
    )
    if (!layer || !pageElement) return null
    const picked = areaText(charsOfLayer(layer, pageElement, box), box)
    if (!picked) return null
    return { method: 'AREA_TEXT', page: pageNumber, text: picked.text, bbox: picked.bbox }
  }

  /**
   * Legge l'area evidenziata: dal text layer quando la pagina ce l'ha, altrimenti
   * ritagliando i pixel e mandandoli all'OCR del main.
   */
  async function captureArea(pageNumber: number, box: BoundingBox) {
    if (!captureTarget) return

    // Il testo nativo è esatto: niente da ripulire, offset esatti, e nemmeno il giro
    // dell'OCR. L'OCR resta per le scansioni, che testo da leggere non ne hanno.
    const fromText = areaFromTextLayer(pageNumber, box)
    if (fromText) {
      setCaptureError(null)
      onCapture(fromText.text, fromText)
      return
    }

    const pdf = pdfRef.current
    if (!pdf) return

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
      onCapture(text, { method: 'AREA_OCR', page: pageNumber, text, bbox: box })
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
              ? 'Evidenzia un’area della pagina: dove c’è testo si legge quello, sulle scansioni l’OCR.'
              : 'Metti prima il cursore in un campo.'
          }
          onClick={() => setMode('area')}
        >
          {reading ? 'Leggo l’area…' : 'Evidenzia area'}
        </button>
      </div>
      {captureError && <div className={styles.error}>{captureError}</div>}
      {located && !located.box && (
        <div className={styles.viewerNote}>
          Pagina {located.page}: la riga non ha coordinate (testo senza text layer), controlla la
          pagina evidenziata.
        </div>
      )}

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
                      item.origin === 'REVIEWER'
                        ? styles.pdfHighlightPicked
                        : styles.pdfHighlightEvidence
                    )}
                    title={item.label}
                    data-evidence-origin={item.origin}
                    style={boxStyle(item.bbox!)}
                  />
                ))}

              {/* La chiave cambia a ogni clic: l'animazione riparte anche sulla stessa riga. */}
              {located?.page === rendered.page &&
                (located.box ? (
                  <div
                    key={located.seq}
                    className={cx(styles.pdfHighlight, styles.pdfHighlightFlash)}
                    style={boxStyle(padBox(located.box))}
                  />
                ) : (
                  <div key={located.seq} className={styles.pdfPageFlash} />
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

/**
 * Pagina e riquadro di una selezione nel text layer. `null` se la selezione non comincia
 * dentro una pagina: il testo si prende lo stesso, senza provenienza.
 */
function pickOf(range: Range, text: string): DocumentPick | null {
  const start =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement
  const pageElement = start?.closest<HTMLElement>('[data-page]')
  const page = Number(pageElement?.dataset.page)
  if (!pageElement || !Number.isInteger(page) || page < 1) return null
  const bbox = selectionBox(textRects(range), pageElement.getBoundingClientRect(), SCALE)
  return { method: 'TEXT_SELECTION', page, text, ...(bbox ? { bbox } : {}) }
}

/**
 * I rettangoli del solo testo selezionato. `Range.getClientRects()` darebbe anche il
 * riquadro di ogni elemento compreso per intero nella selezione, e il text layer di pdf.js
 * ne ha uno grande quanto la pagina (`endOfContent`): basterebbe a coprire tutte le righe.
 */
function textRects(range: Range): DOMRect[] {
  const root = range.commonAncestorContainer
  if (root.nodeType === Node.TEXT_NODE) return Array.from(range.getClientRects())
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const rects: DOMRect[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue
    const part = document.createRange()
    part.selectNodeContents(node)
    if (node === range.startContainer) part.setStart(node, range.startOffset)
    if (node === range.endContainer) part.setEnd(node, range.endOffset)
    rects.push(...Array.from(part.getClientRects()))
  }
  return rects
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

/** Un filo di margine attorno alla riga: il riquadro non deve coprire le lettere. */
function padBox(box: BoundingBox): BoundingBox {
  return { x: box.x - 3, y: box.y - 2, w: box.w + 6, h: box.h + 4 }
}

/**
 * Rettangolo della riga di evidenza nel text layer di pdf.js, in unità di pagina a scala
 * 1. Serve alle evidenze senza coordinate su pagine che il testo ce l'hanno.
 */
function locateInTextLayer(
  layer: HTMLDivElement,
  pageElement: HTMLElement,
  text: string
): BoundingBox | null {
  const spans = Array.from(layer.querySelectorAll('span')).filter(
    (span) => span.childElementCount === 0
  )
  const range = matchSpans(
    spans.map((span) => span.textContent ?? ''),
    text
  )
  if (!range) return null
  const origin = pageElement.getBoundingClientRect()
  return unionRect(
    spans.slice(range[0], range[1] + 1).map((span) => {
      const rect = span.getBoundingClientRect()
      return {
        x: (rect.left - origin.left) / SCALE,
        y: (rect.top - origin.top) / SCALE,
        w: rect.width / SCALE,
        h: rect.height / SCALE
      }
    })
  )
}

/**
 * I caratteri del text layer con il loro riquadro, in unità di pagina a scala 1.
 *
 * Si misurano con un `Range` carattere per carattere: uno span di pdf.js può essere una
 * riga intera, e un'area evidenziata quasi mai coincide con i suoi bordi. Gli span che il
 * riquadro non tocca si scartano prima di misurarli — un `getBoundingClientRect` per ogni
 * carattere della pagina costerebbe troppo per un gesto del mouse.
 */
function charsOfLayer(
  layer: HTMLDivElement,
  pageElement: HTMLElement,
  box: BoundingBox
): AreaChar[] {
  const origin = pageElement.getBoundingClientRect()
  const toPage = (rect: DOMRect): BoundingBox => ({
    x: (rect.left - origin.left) / SCALE,
    y: (rect.top - origin.top) / SCALE,
    w: rect.width / SCALE,
    h: rect.height / SCALE
  })
  const touches = (rect: BoundingBox): boolean =>
    rect.x < box.x + box.w &&
    rect.x + rect.w > box.x &&
    rect.y < box.y + box.h &&
    rect.y + rect.h > box.y

  const chars: AreaChar[] = []
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? ''
    if (text.trim().length === 0) continue
    range.selectNodeContents(node)
    if (!touches(toPage(range.getBoundingClientRect()))) continue
    for (let index = 0; index < text.length; index += 1) {
      range.setStart(node, index)
      range.setEnd(node, index + 1)
      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue
      chars.push({ char: text[index]!, rect: toPage(rect) })
    }
  }
  return chars
}

function rectBetween(start: { x: number; y: number }, end: { x: number; y: number }): BoundingBox {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    w: Math.abs(end.x - start.x),
    h: Math.abs(end.y - start.y)
  }
}
