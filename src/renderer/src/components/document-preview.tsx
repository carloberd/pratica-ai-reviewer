import type { EvidenceItem, ReviewDocument } from '@shared/types'
import { useEffect, useState } from 'react'
import { api, errorMessage } from '../lib/ipc'
import styles from './document-review.module.css'
import PdfViewer from './pdf-viewer'

interface Props {
  document: ReviewDocument
  evidence: EvidenceItem[]
  focusedEvidenceId: string | null
}

const PDF_MIME = 'application/pdf'

/**
 * Il PDF si vede pagina per pagina; il DOCX in v1 è solo testo (D4): senza resa di
 * pagina non ci sono coordinate su cui appoggiare le evidenze.
 */
export default function DocumentPreview({ document, evidence, focusedEvidenceId }: Props) {
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
    <PdfViewer
      documentId={document.id}
      read={api.pdf.read}
      evidence={evidence}
      focusedEvidenceId={focusedEvidenceId}
    />
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

  return <div className={styles.docxText}>{text}</div>
}
