import type {
  ConfidenceBand,
  DocumentFilters,
  QueueStatus,
  RegistryTypeOption
} from '@shared/types'
import { cx } from '../lib/cx'
import { BAND_LABELS, STATUS_LABELS } from '../lib/format'
import styles from './document-review.module.css'

interface Props {
  filters: DocumentFilters
  onChange: (filters: DocumentFilters) => void
  /** Solo i tipi presenti fra i documenti sincronizzati: il registry ne ha 511. */
  types: RegistryTypeOption[]
  total: number
  shown: number
}

const STATUSES: QueueStatus[] = ['NEEDS_REVIEW', 'APPROVED', 'REJECTED']
const BANDS: ConfidenceBand[] = ['HIGH', 'MEDIUM', 'LOW']

export default function DocumentFiltersBar({ filters, onChange, types, total, shown }: Props) {
  const set = (patch: Partial<DocumentFilters>) => {
    const next: DocumentFilters = { ...filters, ...patch }
    for (const key of Object.keys(next) as Array<keyof DocumentFilters>) {
      if (!next[key]) delete next[key]
    }
    onChange(next)
  }

  const active = Object.keys(filters).length > 0

  return (
    <div className={styles.toolbar}>
      <input
        className={cx(styles.input, styles.search)}
        type="search"
        placeholder="Cerca nel testo dei documenti…"
        value={filters.query ?? ''}
        onChange={(event) => set({ query: event.target.value })}
      />

      <select
        className={styles.select}
        value={filters.status ?? ''}
        onChange={(event) => set({ status: (event.target.value || undefined) as QueueStatus })}
      >
        <option value="">Tutti gli stati</option>
        {STATUSES.map((status) => (
          <option key={status} value={status}>
            {STATUS_LABELS[status]}
          </option>
        ))}
      </select>

      <select
        className={styles.select}
        value={filters.documentType ?? ''}
        onChange={(event) => set({ documentType: event.target.value || undefined })}
      >
        <option value="">Tutti i tipi</option>
        <option value="__none__">Da assegnare</option>
        {types.map((type) => (
          <option key={type.id} value={type.id}>
            {type.label}
          </option>
        ))}
      </select>

      <select
        className={styles.select}
        value={filters.band ?? ''}
        onChange={(event) => set({ band: (event.target.value || undefined) as ConfidenceBand })}
      >
        <option value="">Tutte le confidence</option>
        {BANDS.map((band) => (
          <option key={band} value={band}>
            Confidence {BAND_LABELS[band].toLowerCase()}
          </option>
        ))}
      </select>

      {active && (
        <button
          type="button"
          className={cx(styles.button, styles.buttonSmall)}
          onClick={() => onChange({})}
        >
          Azzera filtri
        </button>
      )}

      <span className={styles.spacer} />
      <span className={styles.muted}>
        {shown} di {total} documenti
      </span>
    </div>
  )
}
