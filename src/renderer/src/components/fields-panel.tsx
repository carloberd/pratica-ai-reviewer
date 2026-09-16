import type { EvidenceTarget } from '@shared/evidence-locate'
import { groupFieldsForReview } from '@shared/review-workspace'
import type { EvidenceItem, ExtractedField } from '@shared/types'
import { useMemo } from 'react'
import { cx } from '../lib/cx'
import styles from './document-review.module.css'
import FieldEditor from './field-editor'
import RepeatedFieldEditor, { type RowTarget } from './repeated-field-editor'

/** Il punto della scheda che riceve il testo selezionato sul documento. */
export type ActiveTarget =
  | { kind: 'field'; fieldId: string }
  | { kind: 'item'; fieldId: string; itemId: string }
  | { kind: 'new-item'; fieldId: string }

export interface FieldHandlers {
  onActivate: (target: ActiveTarget) => void
  onFieldCommit: (fieldId: string, value: string | null) => void
  onItemCommit: (itemId: string, value: string | null) => void
  onItemRemove: (itemId: string, removed: boolean) => void
  onItemAdd: (fieldId: string, value: string) => void
  onFocusEvidence: (target: EvidenceTarget) => void
}

interface Props extends FieldHandlers {
  fields: ExtractedField[]
  evidence: EvidenceItem[]
  disabled: boolean
  active: ActiveTarget | null
  /** Evidenza mostrata in questo momento nel documento. */
  shownEvidenceId: string | null
}

/**
 * I campi del documento in due gruppi: in cima quelli dove il motore non ha proposto
 * niente, da riempire a mano, col contatore di quanti restano vuoti; sotto quelli da
 * controllare. Tutti restano visibili e modificabili.
 */
export default function FieldsPanel({
  fields,
  evidence,
  disabled,
  active,
  shownEvidenceId,
  ...handlers
}: Props) {
  const groups = useMemo(() => groupFieldsForReview(fields), [fields])
  const evidenceById = useMemo(() => new Map(evidence.map((item) => [item.id, item])), [evidence])

  const render = (field: ExtractedField) => {
    if (field.cardinality === 'many') {
      const activeRow: RowTarget | null =
        active?.fieldId !== field.id
          ? null
          : active.kind === 'item'
            ? { kind: 'item', itemId: active.itemId }
            : active.kind === 'new-item'
              ? { kind: 'new-item' }
              : null
      return (
        <RepeatedFieldEditor
          key={field.id}
          field={field}
          evidenceById={evidenceById}
          disabled={disabled}
          activeRow={activeRow}
          shownEvidenceId={shownEvidenceId}
          onActivate={(row) =>
            handlers.onActivate(
              row.kind === 'item'
                ? { kind: 'item', fieldId: field.id, itemId: row.itemId }
                : { kind: 'new-item', fieldId: field.id }
            )
          }
          onItemCommit={handlers.onItemCommit}
          onItemRemove={handlers.onItemRemove}
          onItemAdd={(value) => handlers.onItemAdd(field.id, value)}
          onFocusEvidence={handlers.onFocusEvidence}
        />
      )
    }
    const fieldEvidence = field.evidenceId ? evidenceById.get(field.evidenceId) : undefined
    return (
      <FieldEditor
        key={field.id}
        field={field}
        evidence={fieldEvidence}
        disabled={disabled}
        active={active?.kind === 'field' && active.fieldId === field.id}
        evidenceShown={Boolean(fieldEvidence && fieldEvidence.id === shownEvidenceId)}
        onActivate={() => handlers.onActivate({ kind: 'field', fieldId: field.id })}
        onCommit={(value) => handlers.onFieldCommit(field.id, value)}
        onFocusEvidence={handlers.onFocusEvidence}
      />
    )
  }

  return (
    <>
      {groups.toFill.length > 0 && (
        <section className={styles.fieldGroup} data-group="to-fill">
          <div className={styles.panelLabel}>
            Da compilare a mano
            <span
              className={cx(styles.badge, groups.stillEmpty > 0 ? styles.medium : styles.high)}
              data-count={groups.stillEmpty}
            >
              {groups.stillEmpty === 0
                ? 'tutti compilati'
                : `${groups.stillEmpty} vuoti su ${groups.toFill.length}`}
            </span>
          </div>
          <div className={styles.muted}>
            Il motore non ha trovato un valore: scrivilo, o metti il cursore nel campo e selezionalo
            sul documento.
          </div>
          <div className={styles.fieldList}>{groups.toFill.map(render)}</div>
        </section>
      )}

      {groups.proposed.length > 0 && (
        <section className={styles.fieldGroup} data-group="proposed">
          <div className={styles.panelLabel}>
            Proposti dal motore
            <span className={styles.tabCount}>{groups.proposed.length}</span>
          </div>
          <div className={styles.fieldList}>{groups.proposed.map(render)}</div>
        </section>
      )}
    </>
  )
}
