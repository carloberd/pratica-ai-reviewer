import { type EvidenceTarget, targetOfEvidence } from '@shared/evidence-locate'
import type { EvidenceItem, ExtractedField } from '@shared/types'
import { useEffect, useId, useState } from 'react'
import { cx } from '../lib/cx'
import { pct } from '../lib/format'
import styles from './document-review.module.css'
import EvidenceLink from './evidence-link'
import ValidationNote from './validation-note'

interface Props {
  field: ExtractedField
  /** Da dove viene il valore: la selezione del revisore, o la lettura del motore. */
  evidence: EvidenceItem | undefined
  disabled: boolean
  /** Il campo è quello che riceve il testo selezionato sul documento. */
  active: boolean
  /** L'evidenza di questo campo è quella mostrata nel documento. */
  evidenceShown: boolean
  onActivate: () => void
  /**
   * Quello che il revisore ha scritto. `null` annulla la correzione e riporta il campo
   * al valore precompilato; il main decide se il resto è una correzione.
   */
  onCommit: (value: string | null) => void
  onFocusEvidence: (target: EvidenceTarget) => void
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
 * visibile accanto a quello corretto: il revisore vede sempre da cosa è partito, e
 * l'evidenza porta al punto del documento da cui il valore è stato letto.
 *
 * Il campo sta in una colonna stretta accanto al documento, quindi etichetta, valore
 * e provenienza si impilano invece di stare in riga.
 */
export default function FieldEditor({
  field,
  evidence,
  disabled,
  active,
  evidenceShown,
  onActivate,
  onCommit,
  onFocusEvidence
}: Props) {
  const current = field.correctedValue ?? field.value
  const [draft, setDraft] = useState(current)

  // Il documento può essere ricaricato dal main (decisione, ri-estrazione): il draft
  // deve riallinearsi, ma solo quando cambia davvero il valore che arriva.
  useEffect(() => {
    setDraft(current)
  }, [current])

  const dirty = draft !== current
  const corrected = field.correctedValue !== undefined && field.correctedValue !== field.value
  const cleared = corrected && field.correctedValue === ''
  // Gli errori sono del valore salvato: mentre si scrive non dicono niente.
  const errors = dirty ? [] : (field.validationErrors ?? [])
  const noteId = useId()

  function commit() {
    if (!dirty) return
    // Svuotare un valore proposto è una correzione: il motore aveva letto qualcosa che
    // nel documento non c'è.
    onCommit(draft)
  }

  return (
    <div className={cx(styles.fieldCard, active && styles.fieldCardActive)} data-field={field.name}>
      <div className={styles.fieldHead}>
        <span className={styles.fieldLabel}>
          {field.label}
          {field.required && (
            <span className={cx(styles.pill, styles.pillRequired)}>obbligatorio</span>
          )}
          {field.reviewStatus === 'CONFLICT' && !corrected && (
            <span
              className={cx(styles.pill, styles.pillConflict)}
              title="Due letture diverse per questo campo: controlla il documento."
            >
              conflitto
            </span>
          )}
        </span>
        <span className={styles.confidence}>{field.value ? pct(field.confidence) : '—'}</span>
      </div>

      <input
        className={cx(
          styles.fieldInput,
          (dirty || corrected) && styles.fieldDirty,
          errors.length > 0 && styles.fieldInvalid
        )}
        value={draft}
        aria-invalid={errors.length > 0 || undefined}
        aria-describedby={errors.length > 0 ? noteId : undefined}
        disabled={disabled}
        placeholder={
          cleared
            ? 'Svuotato: il valore proposto non c’è nel documento'
            : field.value
              ? PLACEHOLDER[field.semanticType]
              : 'Nessuna evidenza: compila a mano'
        }
        onChange={(event) => setDraft(event.target.value)}
        onFocus={onActivate}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') setDraft(current)
        }}
      />

      {errors.length > 0 && <ValidationNote id={noteId} errors={errors} />}

      {evidence && (
        <EvidenceLink
          target={targetOfEvidence(evidence)}
          active={evidenceShown}
          onFocus={onFocusEvidence}
        />
      )}

      {corrected && (
        <div className={styles.beforeAfter}>
          <span className={cx(styles.pill, styles.pillChanged)}>
            {field.value ? 'corretto' : 'compilato a mano'}
          </span>
          {field.value && (
            <span>
              proposto: <s>{field.value}</s>
            </span>
          )}
          <button
            type="button"
            className={styles.iconButton}
            disabled={disabled}
            onClick={() => onCommit(null)}
          >
            {field.value ? 'torna alla proposta' : 'svuota'}
          </button>
        </div>
      )}
    </div>
  )
}
