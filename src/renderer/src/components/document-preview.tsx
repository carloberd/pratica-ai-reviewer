import type { Annotation, BoundingBox, EvidenceItem, ReviewDocument } from '@shared/types'
import { useEffect, useState } from 'react'
import { api, errorMessage } from '../lib/ipc'
import AnnotationsPanel from './annotations-panel'
import styles from './document-review.module.css'
import PdfViewer, { type DrawMode } from './pdf-viewer'

interface Props {
  document: ReviewDocument
  evidence: EvidenceItem[]
  annotations: Annotation[]
  focusedEvidenceId: string | null
  busy: boolean
  onCreateAnnotation: (page: number, bbox: BoundingBox, kind: 'highlight' | 'note') => void
  onUpdateNote: (id: string, note: string) => void
  onDeleteAnnotation: (id: string) => void
  onExport: () => void
}

const PDF_MIME = 'application/pdf'

/**
 * Il PDF si vede e si annota; il DOCX in v1 è solo testo (D4): senza resa di pagina
 * non ci sono coordinate su cui appoggiare un'evidenziazione.
 */
export default function DocumentPreview({
  document,
  evidence,
  annotations,
  focusedEvidenceId,
  busy,
  onCreateAnnotation,
  onUpdateNote,
  onDeleteAnnotation,
  onExport
}: Props) {
  const [mode, setMode] = useState<DrawMode>('none')
  const [selectedAnnotation, setSelectedAnnotation] = useState<string | null>(null)

  if (document.mime !== PDF_MIME) {
    return <DocxText documentId={document.id} />
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
    <div className={styles.pdfPane}>
      <AnnotationsPanel
        annotations={annotations}
        mode={mode}
        busy={busy}
        selectedId={selectedAnnotation}
        onModeChange={setMode}
        onSelect={setSelectedAnnotation}
        onUpdateNote={onUpdateNote}
        onDelete={(id) => {
          setSelectedAnnotation(null)
          onDeleteAnnotation(id)
        }}
        onExport={onExport}
      />
      <PdfViewer
        documentId={document.id}
        read={api.pdf.read}
        evidence={evidence}
        annotations={annotations}
        focusedEvidenceId={focusedEvidenceId}
        mode={mode}
        onDraw={(page, bbox) => {
          onCreateAnnotation(page, bbox, mode === 'note' ? 'note' : 'highlight')
          setMode('none')
        }}
        onSelectAnnotation={(annotation) => setSelectedAnnotation(annotation.id)}
      />
    </div>
  )
}

function DocxText({ documentId }: { documentId: string }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  if (error) return <div className={styles.error}>{error}</div>
  if (text === null) return <div className={styles.spinner}>Estraggo il testo…</div>

  return (
    <div className={styles.pdfPane}>
      <div className={styles.muted}>
        Per i DOCX la v1 mostra solo il testo estratto: senza resa di pagina non ci sono coordinate,
        quindi non si possono creare annotazioni.
      </div>
      <div className={styles.docxText}>{text}</div>
    </div>
  )
}
