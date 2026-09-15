import type { ExtractedField } from '@shared/types'
import { useEffect, useState } from 'react'
import { cx } from '../lib/cx'
import { pct } from '../lib/format'
import styles from './document-review.module.css'

interface Props {
  field: ExtractedField
  disabled: boolean
  /** `null` annulla la correzione e riporta il campo al valore precompilato. */
  onCommit: (value: string | null) => void
  onFocusEvidence: (evidenceId: string) => void
}

const PLACEHOLDER: Record<ExtractedField['semanticType'], string> = {
  date: 'aaaa-mm-gg',
  money: '0.00',
  string: 'valore'
}

/**
 * Riga di campo modificabile.
 *
 * È il pezzo che mancava nel modulo v5.2, dove «Conferma con correzione» inviava una
 * decisione senza mai chiedere cosa correggere. Qui il valore precompilato resta
 * visibile accanto a quello corretto: il revisore vede sempre da cosa è partito.
 */
export default function FieldEditor({ field, disabled, onCommit, onFocusEvidence }: Props) {
  const current = field.correctedValue ?? field.value
  const [draft, setDraft] = useState(current)

  // Il documento può essere ricaricato dal main (decisione, ri-estrazione): il draft
  // deve riallinearsi, ma solo quando cambia davvero il valore che arriva.
  useEffect(() => {
    setDraft(current)
  }, [current])

  const dirty = draft !== current
  const corrected = field.correctedValue !== undefined && field.correctedValue !== field.value

  function commit() {
    if (!dirty) return
    onCommit(draft.trim() === '' ? null : draft)
  }

  return (
    <div className={cx(styles.fieldRow, styles.fieldRowEditable)}>
      <div className={styles.fieldLabel}>
        {field.label}
        {field.required && (
          <span className={cx(styles.pill, styles.pillRequired)}>obbligatorio</span>
        )}
      </div>

      <input
        className={cx(styles.fieldInput, (dirty || corrected) && styles.fieldDirty)}
        value={draft}
        disabled={disabled}
        placeholder={
          field.value ? PLACEHOLDER[field.semanticType] : 'Nessuna evidenza: compila a mano'
        }
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') setDraft(current)
        }}
      />

      <div className={styles.fieldMeta}>
        {corrected && <span className={cx(styles.pill, styles.pillChanged)}>corretto</span>}
        {field.evidenceId && (
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => field.evidenceId && onFocusEvidence(field.evidenceId)}
          >
            evidenza
          </button>
        )}
      </div>

      <div className={styles.confidence}>{field.value ? pct(field.confidence) : '—'}</div>

      {corrected && (
        <div className={styles.beforeAfter}>
          precompilato: <s>{field.value || '(vuoto)'}</s> → {field.correctedValue}
          <button
            type="button"
            className={styles.iconButton}
            style={{ marginLeft: 8 }}
            disabled={disabled}
            onClick={() => onCommit(null)}
          >
            annulla correzione
          </button>
        </div>
      )}
    </div>
  )
}
