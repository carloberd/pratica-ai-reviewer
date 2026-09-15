import type { ConfidenceBand, ReviewDocumentSummary } from '@shared/types'
import { cx } from '../lib/cx'
import { formatDateTime, pct, STATUS_LABELS, textSourceLabel, typeLabel } from '../lib/format'
import styles from './document-review.module.css'

export const BAND_CLASS: Record<ConfidenceBand, string | undefined> = {
  HIGH: styles.high,
  MEDIUM: styles.medium,
  LOW: styles.low
}

interface Props {
  documents: ReviewDocumentSummary[]
  onOpen: (id: string) => void
  emptyTitle: string
  emptyHint: string
}

export default function DocumentTable({ documents, onOpen, emptyTitle, emptyHint }: Props) {
  if (documents.length === 0) {
    return (
      <div className={cx(styles.card, styles.empty)}>
        <div className={styles.emptyTitle}>{emptyTitle}</div>
        <div>{emptyHint}</div>
      </div>
    )
  }

  return (
    <div className={cx(styles.card, styles.tableWrap)}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Documento</th>
            <th>Tipo</th>
            <th>Testo</th>
            <th>Confidence</th>
            <th>Stato</th>
            <th>Modificato</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((doc) => (
            <tr key={doc.id} onClick={() => onOpen(doc.id)}>
              <td>
                <div className={styles.fileName}>{doc.filename}</div>
                {doc.warnings.length > 0 && <div className={styles.subtle}>{doc.warnings[0]}</div>}
              </td>
              <td>{typeLabel(doc.documentType, doc.documentTypeLabel)}</td>
              <td>{textSourceLabel(doc.textSource)}</td>
              <td>
                <span className={cx(styles.badge, BAND_CLASS[doc.confidenceBand])}>
                  {pct(doc.confidence)}
                </span>
              </td>
              <td>
                <span className={cx(styles.badge, styles.status)}>{STATUS_LABELS[doc.status]}</span>
              </td>
              <td>{formatDateTime(doc.receivedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
