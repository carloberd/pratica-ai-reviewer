import { type EvidenceTarget, targetOfEvidence } from '@shared/evidence-locate'
import { confirmedItems, sortedItems } from '@shared/field-edits'
import { pickOfEvidence } from '@shared/pick-cleanup'
import type { DocumentPick, EvidenceItem, ExtractedField, FieldItem } from '@shared/types'
import { useEffect, useId, useState } from 'react'
import { cx } from '../lib/cx'
import styles from './document-review.module.css'
import EvidenceLink from './evidence-link'
import ValidationNote from './validation-note'

/** Dove finisce il testo selezionato sul documento, dentro un campo ripetuto. */
export type RowTarget = { kind: 'item'; itemId: string } | { kind: 'new-item' }

interface Props {
  field: ExtractedField
  evidenceById: Map<string, EvidenceItem>
  disabled: boolean
  /** La riga (o la riga nuova) che riceve il testo selezionato sul documento. */
  activeRow: RowTarget | null
  shownEvidenceId: string | null
  onActivate: (row: RowTarget) => void
  /**
   * `null` torna alla proposta; il main decide se svuotare toglie o cancella la riga.
   * `pick` è la selezione che la riga aveva già: sistemare a mano una lettura dell'OCR non
   * deve cancellarla.
   */
  onItemCommit: (itemId: string, value: string | null, pick?: DocumentPick) => void
  onItemRemove: (itemId: string, removed: boolean) => void
  onItemAdd: (value: string) => void
  onFocusEvidence: (target: EvidenceTarget) => void
}

/**
 * Campo ripetuto (righe fattura, rate, garanzie): una voce per riga, ognuna con la sua
 * evidenza. Le righe proposte dal motore si correggono o si tolgono — tolte restano in
 * tabella, barrate, per poterle rimettere — e quelle mancanti si aggiungono in fondo,
 * scrivendole o selezionandole sul documento.
 */
export default function RepeatedFieldEditor({
  field,
  evidenceById,
  disabled,
  activeRow,
  shownEvidenceId,
  onActivate,
  onItemCommit,
  onItemRemove,
  onItemAdd,
  onFocusEvidence
}: Props) {
  const [draft, setDraft] = useState('')
  const rows = sortedItems(field.items)
  const confirmed = confirmedItems(field.items).length

  function add() {
    if (!draft.trim()) return
    onItemAdd(draft)
    setDraft('')
  }

  return (
    <div
      className={cx(styles.fieldCard, activeRow && styles.fieldCardActive)}
      data-field={field.name}
    >
      <div className={styles.fieldHead}>
        <span className={styles.fieldLabel}>
          {field.label}
          {field.required && (
            <span className={cx(styles.pill, styles.pillRequired)}>obbligatorio</span>
          )}
        </span>
        <span className={styles.confidence}>
          {confirmed === 1 ? '1 riga' : `${confirmed} righe`}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className={styles.muted}>Nessuna riga proposta: aggiungile a mano.</div>
      ) : (
        <table className={styles.itemTable}>
          <tbody>
            {rows.map((item) => {
              // La selezione del revisore, se il valore viene da lì; altrimenti la lettura del motore.
              const evidenceId = item.correctedEvidenceId ?? item.evidenceId
              const evidence = evidenceId ? evidenceById.get(evidenceId) : undefined
              return (
                <ItemRow
                  key={item.id}
                  item={item}
                  evidence={evidence}
                  disabled={disabled}
                  active={activeRow?.kind === 'item' && activeRow.itemId === item.id}
                  evidenceShown={Boolean(evidence && evidence.id === shownEvidenceId)}
                  onActivate={() => onActivate({ kind: 'item', itemId: item.id })}
                  onCommit={(value) =>
                    onItemCommit(
                      item.id,
                      value,
                      pickOfEvidence(
                        item.correctedEvidenceId
                          ? evidenceById.get(item.correctedEvidenceId)
                          : undefined
                      )
                    )
                  }
                  onRemove={(removed) => onItemRemove(item.id, removed)}
                  onFocusEvidence={onFocusEvidence}
                />
              )
            })}
          </tbody>
        </table>
      )}

      <form
        className={styles.itemAdd}
        onSubmit={(event) => {
          event.preventDefault()
          add()
        }}
      >
        <input
          className={cx(
            styles.fieldInput,
            activeRow?.kind === 'new-item' && styles.fieldInputActive
          )}
          value={draft}
          disabled={disabled}
          placeholder="Nuova riga…"
          aria-label={`Nuova riga di ${field.label}`}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={() => onActivate({ kind: 'new-item' })}
        />
        <button
          type="submit"
          className={cx(styles.button, styles.buttonSmall)}
          disabled={disabled || !draft.trim()}
        >
          Aggiungi riga
        </button>
      </form>
    </div>
  )
}

function ItemRow({
  item,
  evidence,
  disabled,
  active,
  evidenceShown,
  onActivate,
  onCommit,
  onRemove,
  onFocusEvidence
}: {
  item: FieldItem
  evidence: EvidenceItem | undefined
  disabled: boolean
  active: boolean
  evidenceShown: boolean
  onActivate: () => void
  onCommit: (value: string | null) => void
  onRemove: (removed: boolean) => void
  onFocusEvidence: (target: EvidenceTarget) => void
}) {
  const current = item.correctedValue ?? item.value
  const [draft, setDraft] = useState(current)

  useEffect(() => {
    setDraft(current)
  }, [current])

  const corrected =
    item.origin === 'ENGINE' &&
    item.correctedValue !== undefined &&
    item.correctedValue !== item.value
  const errors = draft !== current || item.removed ? [] : (item.validationErrors ?? [])
  const noteId = useId()

  return (
    <tr className={cx(item.removed && styles.itemRemoved)} data-origin={item.origin}>
      <td className={styles.itemIndex}>{item.index + 1}</td>
      <td className={styles.itemCell}>
        <div className={styles.itemBody}>
          {item.removed ? (
            <s className={styles.itemRemovedText}>{item.value}</s>
          ) : (
            <input
              className={cx(
                styles.fieldInput,
                (draft !== current || corrected) && styles.fieldDirty,
                active && styles.fieldInputActive,
                errors.length > 0 && styles.fieldInvalid
              )}
              value={draft}
              aria-invalid={errors.length > 0 || undefined}
              aria-describedby={errors.length > 0 ? noteId : undefined}
              disabled={disabled}
              aria-label={`Riga ${item.index + 1}`}
              onChange={(event) => setDraft(event.target.value)}
              onFocus={onActivate}
              onBlur={() => {
                if (draft !== current) onCommit(draft)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
                if (event.key === 'Escape') setDraft(current)
              }}
            />
          )}
          {errors.length > 0 && <ValidationNote id={noteId} errors={errors} />}
          {corrected && !item.removed && (
            <div className={styles.beforeAfter}>
              proposta: <s>{item.value}</s>
            </div>
          )}
          <div className={styles.itemFoot}>
            {evidence && (
              <EvidenceLink
                target={targetOfEvidence(evidence)}
                active={evidenceShown}
                onFocus={onFocusEvidence}
              />
            )}
            {item.origin === 'MANUAL' && (
              <span className={cx(styles.pill, styles.pillChanged)}>aggiunta a mano</span>
            )}
            <span className={styles.spacer} />
            {item.removed ? (
              <button
                type="button"
                className={styles.iconButton}
                disabled={disabled}
                onClick={() => onRemove(false)}
              >
                rimetti
              </button>
            ) : (
              <>
                {corrected && (
                  <button
                    type="button"
                    className={styles.iconButton}
                    disabled={disabled}
                    onClick={() => onCommit(null)}
                  >
                    annulla
                  </button>
                )}
                <button
                  type="button"
                  className={styles.iconButton}
                  disabled={disabled}
                  title={
                    item.origin === 'ENGINE'
                      ? 'Toglie la riga dal dataset; la proposta resta visibile, barrata.'
                      : 'Cancella la riga aggiunta a mano.'
                  }
                  onClick={() => onRemove(true)}
                >
                  togli
                </button>
              </>
            )}
          </div>
        </div>
      </td>
    </tr>
  )
}
