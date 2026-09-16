import type { DriveFileSummary } from '@shared/types'
import { cx } from '../lib/cx'
import { formatBytes, formatDateTime, mimeLabel, STATUS_LABELS } from '../lib/format'
import styles from './document-review.module.css'
import { TableSkeleton } from './loading-skeleton'

interface Props {
  files: DriveFileSummary[]
  /** Id Drive del file che si sta scaricando in questo momento. */
  fetchingId: string | null
  busy: boolean
  /** `files.list` è in corso: l'elenco non è ancora né pieno né vuoto. */
  loading?: boolean
  onOpen: (file: DriveFileSummary) => void
  emptyHint: string
}

/**
 * Elenco dei file su Drive: solo metadati.
 *
 * Niente viene scaricato per mostrare questa tabella. Il contenuto arriva al doppio
 * clic su una riga, un file per volta: tirare giù l'intero Drive riempirebbe il disco
 * di documenti che nessuno aprirà.
 */
export default function DriveFiles({
  files,
  fetchingId,
  busy,
  loading = false,
  onOpen,
  emptyHint
}: Props) {
  // L'elenco già letto resta a schermo durante un aggiornamento: sparire e ricomparire
  // è peggio di una riga stantia per il tempo di una `files.list`.
  if (loading && files.length === 0) {
    return <TableSkeleton label="Leggo l'elenco dei file su Drive…" rows={6} />
  }

  if (files.length === 0) {
    return (
      <div className={cx(styles.card, styles.empty)}>
        <div className={styles.emptyTitle}>Nessun file su Drive</div>
        <div>{emptyHint}</div>
      </div>
    )
  }

  return (
    <div className={cx(styles.card, styles.tableWrap)}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>File</th>
            <th>Tipo</th>
            <th>Dimensione</th>
            <th>Stato locale</th>
            <th>Revisione</th>
            <th>Modificato</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => (
            <tr
              key={file.id}
              title="Doppio clic per scaricarlo e aprirlo"
              onDoubleClick={() => !busy && onOpen(file)}
            >
              <td>
                <div className={styles.fileName}>{file.name}</div>
                {fetchingId === file.id && <div className={styles.subtle}>Scarico e analizzo…</div>}
              </td>
              <td>{mimeLabel(file.mimeType)}</td>
              <td>{formatBytes(file.size)}</td>
              <td>
                <LocalState file={file} />
              </td>
              <td>
                {file.status ? (
                  <span className={cx(styles.badge, styles.status)}>
                    {STATUS_LABELS[file.status]}
                  </span>
                ) : (
                  <span className={styles.subtle}>—</span>
                )}
              </td>
              <td>{formatDateTime(file.modifiedTime)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function LocalState({ file }: { file: DriveFileSummary }) {
  if (file.stale) {
    return <span className={cx(styles.badge, styles.medium)}>Da aggiornare</span>
  }
  if (file.cached) {
    return <span className={cx(styles.badge, styles.high)}>In locale</span>
  }
  if (file.documentId) {
    return <span className={cx(styles.badge, styles.status)}>Analizzato, file rimosso</span>
  }
  return <span className={styles.subtle}>Non scaricato</span>
}
