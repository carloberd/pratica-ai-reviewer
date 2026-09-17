import { findTextRange } from '@shared/evidence-locate'
import type { DocumentPick, EvidenceItem, ReviewDocument } from '@shared/types'
import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../lib/ipc'
import styles from './document-review.module.css'
import PdfViewer, { type EvidenceFocus } from './pdf-viewer'

interface Props {
  document: ReviewDocument
  evidence: EvidenceItem[]
  /** Punto del documento da raggiungere ed evidenziare. */
  focus: EvidenceFocus | null
  /** Etichetta del campo che sta aspettando un valore, `null` se nessuno. */
  captureTarget: string | null
  /** Il testo preso dal documento e, quando si sa, il punto da cui viene. */
  onCapture: (text: string, pick?: DocumentPick) => void
}

const PDF_MIME = 'application/pdf'

/**
 * Il PDF si vede pagina per pagina; il DOCX in v1 è solo testo (D4): senza resa di
 * pagina non ci sono coordinate su cui appoggiare le evidenze, e la riga si ritrova nel
 * testo.
 */
export default function DocumentPreview({
  document,
  evidence,
  focus,
  captureTarget,
  onCapture
}: Props) {
  if (document.mime !== PDF_MIME) {
    return (
      <DocxText
        documentId={document.id}
        focus={focus}
        captureTarget={captureTarget}
        onCapture={onCapture}
      />
    )
  }

  if (!document.cachedPath) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyTitle}>File non disponibile in locale</div>
        <div>Sincronizza di nuovo da Google Drive per scaricarlo nella cache.</div>
      </div>
    )
  }

  return (
    <PdfViewer
      documentId={document.id}
      read={api.pdf.read}
      evidence={evidence}
      focus={focus}
      captureTarget={captureTarget}
      onCapture={onCapture}
    />
  )
}

function DocxText({
  documentId,
  focus,
  captureTarget,
  onCapture
}: {
  documentId: string
  focus: EvidenceFocus | null
  captureTarget: string | null
  onCapture: (text: string, pick?: DocumentPick) => void
}) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mark = useRef<HTMLElement>(null)
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    api.docx
      .text(documentId)
      .then((value) => !cancelled && setText(value))
      .catch((caught) => !cancelled && setError(errorMessage(caught)))
    return () => {
      cancelled = true
    }
  }, [documentId])

  // Un DOCX è una pagina sola: la riga di evidenza si cerca nel testo e si evidenzia lì.
  const range = focus && text !== null ? findTextRange(text, focus.target.text) : null

  // biome-ignore lint/correctness/useExhaustiveDependencies: a ogni clic (seq), anche sulla stessa riga
  useEffect(() => {
    // Scorre solo il riquadro del testo: `scrollIntoView` muoverebbe anche la finestra.
    const box = container.current
    if (!mark.current || !box) return
    const top = mark.current.offsetTop - box.clientHeight / 3
    box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }, [focus?.seq, text])

  if (error) return <div className={styles.error}>{error}</div>
  if (text === null) return <div className={styles.spinner}>Estraggo il testo…</div>

  /**
   * Anche qui la selezione compila il campo attivo: il DOCX è testo, niente OCR. Una pagina
   * sola e nessuna coordinata: il main ritrova la selezione dal testo.
   */
  function capture() {
    if (!captureTarget) return
    const selection = window.getSelection()
    const selected = selection?.toString() ?? ''
    if (!selected.trim()) return
    selection?.removeAllRanges()
    onCapture(selected, { method: 'TEXT_SELECTION', page: 1, text: selected })
  }

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
      </div>
      {focus && !range && (
        <div className={styles.viewerNote}>
          La riga «{focus.target.text}» non si ritrova nel testo del documento.
        </div>
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: il testo si seleziona con il mouse */}
      <div className={styles.docxText} ref={container} onMouseUp={capture}>
        {range ? (
          <>
            {text.slice(0, range.start)}
            <mark key={focus?.seq} ref={mark} className={styles.docxMark}>
              {text.slice(range.start, range.end)}
            </mark>
            {text.slice(range.end)}
          </>
        ) : (
          text
        )}
      </div>
    </>
  )
}
