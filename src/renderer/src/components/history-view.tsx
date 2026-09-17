import type { ActivityEntry } from '@shared/profile-history'
import type { ActivityFeed } from '@shared/profile-workspace'
import { useMemo, useState } from 'react'
import { cx } from '../lib/cx'
import { formatDateTime } from '../lib/format'
import styles from './document-review.module.css'
import { TableSkeleton } from './loading-skeleton'

/**
 * «Cronologia»: tutto quello che è stato fatto, in una lista sola.
 *
 * Le correzioni alla mappa e le annotazioni sui documenti finiscono qui insieme, perché
 * è così che si rileggono: una decisione presa martedì si capisce accanto ai documenti
 * che l'hanno motivata. Da qui si annulla una correzione — l'ultima presa su quel campo —
 * e l'annullamento diventa a sua volta una riga: la cronologia non si riscrive.
 */

interface Props {
  feed: ActivityFeed | null
  loading: boolean
  busy: boolean
  onRevert: (actionId: string) => void
  onOpenDocument: (documentId: string) => void
}

type Filter = 'all' | 'MAP' | 'DOCUMENT'

const FILTERS: Array<{ id: Filter; label: string; hint: string }> = [
  { id: 'all', label: 'Tutto', hint: 'Correzioni alla mappa e annotazioni, in ordine di tempo' },
  { id: 'MAP', label: 'Campi da estrarre', hint: 'Solo le correzioni alla mappa dei campi' },
  { id: 'DOCUMENT', label: 'Documenti', hint: 'Solo gli eventi della revisione' }
]

export default function HistoryView({ feed, loading, busy, onRevert, onOpenDocument }: Props) {
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')

  const entries = useMemo(() => {
    const all = feed?.entries ?? []
    const needle = query.trim().toLowerCase()
    return all.filter((entry) => {
      if (filter !== 'all' && entry.source !== filter) return false
      if (!needle) return true
      return `${entry.title} ${entry.detail} ${entry.documentType ?? ''} ${entry.filename ?? ''}`
        .toLowerCase()
        .includes(needle)
    })
  }, [feed, filter, query])

  if (loading && !feed) return <TableSkeleton label="Leggo la cronologia…" />

  return (
    <div className={cx(styles.card, styles.historyPanel)}>
      <div className={styles.sectionHeader}>
        <div>
          <h2>Cronologia</h2>
          <div className={styles.subtle}>
            {feed?.standingEdits === 0
              ? 'Nessuna correzione alla mappa: è ancora quella del registry.'
              : `${feed?.standingEdits ?? 0} correzioni alla mappa in piedi su questa installazione.`}
          </div>
        </div>
        <span className={styles.spacer} />
        <input
          className={styles.input}
          value={query}
          placeholder="Cerca nella cronologia…"
          aria-label="Cerca nella cronologia"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className={styles.actions} role="tablist" aria-label="Cosa mostrare">
        {FILTERS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={filter === entry.id}
            title={entry.hint}
            className={cx(
              styles.button,
              styles.buttonSmall,
              filter === entry.id && styles.buttonPrimary
            )}
            onClick={() => setFilter(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {entries.length === 0 ? (
        <div className={styles.muted}>
          Niente da mostrare qui. Le righe arrivano dalle annotazioni sui documenti e dalle
          correzioni fatte in «Campi da estrarre», dentro la revisione.
        </div>
      ) : (
        <ol className={styles.historyList}>
          {entries.map((entry) => (
            <HistoryRow
              key={`${entry.source}-${entry.id}`}
              entry={entry}
              busy={busy}
              onRevert={onRevert}
              onOpenDocument={onOpenDocument}
            />
          ))}
        </ol>
      )}
    </div>
  )
}

function HistoryRow({
  entry,
  busy,
  onRevert,
  onOpenDocument
}: {
  entry: ActivityEntry
  busy: boolean
  onRevert: (actionId: string) => void
  onOpenDocument: (documentId: string) => void
}) {
  return (
    <li
      className={cx(styles.historyRow, entry.revertedAt && styles.historyRowReverted)}
      data-source={entry.source}
      data-entry={entry.id}
    >
      <div className={styles.historyWhen}>{formatDateTime(entry.at)}</div>
      <div className={styles.historyBody}>
        <div className={styles.historyTitle}>
          <span className={styles.fileName}>{entry.title}</span>
          {entry.documentType && <span className={styles.badge}>{entry.documentType}</span>}
          {entry.revertedAt && <span className={cx(styles.badge, styles.low)}>annullata</span>}
        </div>
        <div className={styles.muted}>{entry.detail}</div>
        {entry.filename && (
          <button
            type="button"
            className={cx(styles.button, styles.buttonSmall, styles.buttonLink)}
            onClick={() => entry.documentId && onOpenDocument(entry.documentId)}
          >
            {entry.filename}
          </button>
        )}
      </div>
      {entry.revertable && (
        <button
          type="button"
          className={cx(styles.button, styles.buttonSmall)}
          disabled={busy}
          title="Rimette la mappa com'era prima di questa correzione. L'annullamento resta in cronologia."
          onClick={() => onRevert(entry.id)}
        >
          Annulla
        </button>
      )}
    </li>
  )
}
