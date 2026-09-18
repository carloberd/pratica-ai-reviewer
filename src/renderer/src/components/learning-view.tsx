import {
  LEARNING_ACTION_TITLES,
  LEARNING_MODE_HINTS,
  LEARNING_STATUS_LABELS,
  type LearningOverview,
  type LearningRuleView,
  MANUAL_ACTION_LABELS,
  type ManualRuleStatus
} from '@shared/learning-workspace'
import {
  LEARNING_MODE_LABELS,
  LEARNING_MODES,
  type LearningMode,
  type LearningRuleStatus
} from '@shared/local-learning'
import { useMemo, useState } from 'react'
import { cx } from '../lib/cx'
import { formatDateTime, pct } from '../lib/format'
import styles from './document-review.module.css'
import { TableSkeleton } from './loading-skeleton'

/**
 * «Apprendimento»: quanto il motore ha imparato dalle revisioni, e chi lo governa.
 *
 * In cima la modalità, perché decide tutto il resto: se le revisioni insegnano e se le
 * regole valgono. Sotto le regole, prima quelle che stanno cambiando la precompilazione, e
 * per ognuna i numeri che l'hanno fatta valere. Una regola si sospende, si riattiva o si
 * scarta da qui, e ogni decisione resta in cronologia accanto a quelle del learner —
 * compresa quella di annullarne una.
 */

interface Props {
  overview: LearningOverview | null
  loading: boolean
  busy: boolean
  exporting: boolean
  replaying: boolean
  onSetMode: (mode: LearningMode) => void
  onSetRuleStatus: (ruleId: string, status: ManualRuleStatus) => void
  onReplay: () => void
  onRollbackRule: (ruleId: string) => void
  onExport: () => void
}

type Filter = 'all' | LearningRuleStatus

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'Tutte' },
  { id: 'ACTIVE', label: 'Attive' },
  { id: 'SUSPENDED', label: 'Sospese' },
  { id: 'CANDIDATE', label: 'Candidate' },
  { id: 'REJECTED', label: 'Scartate' }
]

const STATUS_CLASS: Record<LearningRuleStatus, string | undefined> = {
  ACTIVE: styles.high,
  SUSPENDED: styles.medium,
  CANDIDATE: styles.status,
  REJECTED: styles.low
}

const ACTION_HINTS: Record<ManualRuleStatus, string> = {
  SUSPENDED:
    'La regola smette di valere sui documenti elaborati da adesso. Il learner non la riattiva da solo.',
  ACTIVE:
    'La regola torna a valere. Si giudica di nuovo solo sulle revisioni che arrivano da adesso.',
  REJECTED:
    'La regola non vale più. Resta in cronologia, e finché il learner non la tocca lo scarto si può annullare.'
}

export default function LearningView({
  overview,
  loading,
  busy,
  exporting,
  replaying,
  onSetMode,
  onSetRuleStatus,
  onReplay,
  onRollbackRule,
  onExport
}: Props) {
  const [filter, setFilter] = useState<Filter>('all')

  const rules = useMemo(
    () => (overview?.rules ?? []).filter((rule) => filter === 'all' || rule.status === filter),
    [overview, filter]
  )

  if (loading && !overview) return <TableSkeleton label="Leggo quello che il motore ha imparato…" />
  if (!overview) return null

  const { counts, mode } = overview

  return (
    <div className={styles.learningView}>
      <section className={cx(styles.card, styles.historyPanel)} data-section="mode">
        <div className={styles.sectionHeader}>
          <div>
            <h2>Apprendimento</h2>
            <div className={styles.subtle}>
              {counts.events === 1
                ? '1 decisione registrata'
                : `${counts.events.toLocaleString('it-IT')} decisioni registrate`}{' '}
              · {counts.rules.ACTIVE} attive · {counts.rules.SUSPENDED} sospese ·{' '}
              {counts.rules.CANDIDATE} candidate
            </div>
          </div>
          <span className={styles.spacer} />
          <button
            type="button"
            className={styles.button}
            disabled={busy || mode !== 'LEARNING'}
            title={
              mode === 'LEARNING'
                ? 'Ripassa le revisioni già chiuse: quelle di prima che il learner fosse acceso non le ha mai viste. Si può rilanciare, non conta due volte.'
                : 'Il ripasso registra decisioni: serve la modalità LEARNING.'
            }
            onClick={onReplay}
          >
            {replaying ? 'Ripasso…' : 'Ripassa le revisioni'}
          </button>
          <button
            type="button"
            className={styles.button}
            disabled={busy}
            title="Regole, decisioni del revisore e cronologia in un file JSON, senza valori dei documenti."
            onClick={onExport}
          >
            {exporting ? 'Esporto…' : 'Esporta le regole'}
          </button>
        </div>

        <fieldset className={styles.learningModes} aria-label="Modalità">
          {LEARNING_MODES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={mode === option}
              data-mode={option}
              disabled={busy}
              className={cx(styles.learningMode, mode === option && styles.learningModeActive)}
              onClick={() => mode !== option && onSetMode(option)}
            >
              <span className={styles.learningModeLabel}>{LEARNING_MODE_LABELS[option]}</span>
              <span className={styles.muted}>{LEARNING_MODE_HINTS[option]}</span>
            </button>
          ))}
        </fieldset>
        <div className={styles.muted}>
          Cambiare modalità vale dai documenti elaborati da adesso: quelli già precompilati restano
          come sono.
        </div>
      </section>

      <section className={cx(styles.card, styles.historyPanel)} data-section="rules">
        <div className={styles.sectionHeader}>
          <div>
            <h2>Regole</h2>
            <div className={styles.subtle}>
              Etichette imparate dai valori selezionati sul documento, e tipi dei moduli che
              ritornano.
            </div>
          </div>
        </div>
        <div className={styles.actions} role="tablist" aria-label="Quali regole">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={filter === entry.id}
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

        {rules.length === 0 ? (
          <div className={styles.muted}>
            {overview.rules.length === 0
              ? 'Nessuna regola ancora. Nascono quando si salva una revisione con un valore selezionato sul documento, o con il tipo di un modulo.'
              : 'Nessuna regola in questo stato.'}
          </div>
        ) : (
          <ol className={styles.historyList}>
            {rules.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                busy={busy}
                onSetStatus={onSetRuleStatus}
                onRollback={onRollbackRule}
              />
            ))}
          </ol>
        )}
      </section>

      <section className={cx(styles.card, styles.historyPanel)} data-section="actions">
        <div className={styles.sectionHeader}>
          <div>
            <h2>Cronologia del learner</h2>
            <div className={styles.subtle}>
              Modalità cambiate e regole attivate, sospese, riattivate o scartate, dal learner o a
              mano.
            </div>
          </div>
        </div>
        {overview.actions.length === 0 ? (
          <div className={styles.muted}>Niente da mostrare qui.</div>
        ) : (
          <ol className={styles.historyList}>
            {overview.actions.map((action) => (
              <li key={action.id} className={styles.historyRow} data-action={action.kind}>
                <div className={styles.historyWhen}>{formatDateTime(action.at)}</div>
                <div className={styles.historyBody}>
                  <div className={styles.historyTitle}>
                    <span className={styles.fileName}>{LEARNING_ACTION_TITLES[action.kind]}</span>
                  </div>
                  <div className={styles.muted}>{action.detail}</div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

function RuleRow({
  rule,
  busy,
  onSetStatus,
  onRollback
}: {
  rule: LearningRuleView
  busy: boolean
  onSetStatus: (ruleId: string, status: ManualRuleStatus) => void
  onRollback: (ruleId: string) => void
}) {
  // Scartare porta via anche le prove: chiede un secondo clic lo stesso, perché annullare
  // è comunque un giro in più e la cronologia si porta dietro tutti e due i clic.
  const [confirming, setConfirming] = useState(false)
  const numbers = [
    rule.positiveCount === 1 ? '1 conferma' : `${rule.positiveCount} conferme`,
    rule.negativeCount === 1 ? '1 smentita' : `${rule.negativeCount} smentite`,
    rule.precision === null ? null : `precisione ${pct(rule.precision)}`
  ].filter((part) => part !== null)
  const lastProof = [rule.lastPositiveAt, rule.lastNegativeAt]
    .filter((at): at is string => at !== null)
    .sort()
    .pop()

  return (
    <li
      className={cx(styles.historyRow, rule.status === 'REJECTED' && styles.historyRowReverted)}
      data-rule={rule.id}
      data-status={rule.status}
    >
      <div className={styles.historyBody}>
        <div className={styles.historyTitle}>
          <span className={styles.fileName}>{rule.title}</span>
          <span className={cx(styles.badge, STATUS_CLASS[rule.status])}>
            {LEARNING_STATUS_LABELS[rule.status]}
          </span>
          <span className={cx(styles.badge, styles.status)}>
            {rule.kind === 'TEMPLATE_TYPE'
              ? 'tipo del modulo'
              : rule.scope === 'TEMPLATE'
                ? 'etichetta del modulo'
                : 'etichetta del tipo'}
          </span>
        </div>
        <div className={styles.muted}>
          {rule.documentTypeLabel ?? rule.documentType} · {numbers.join(' · ')}
          {lastProof ? ` · ultima prova ${formatDateTime(lastProof)}` : ''}
        </div>
      </div>
      <div className={styles.learningRuleActions}>
        {rule.canRollback ? (
          <button
            type="button"
            className={cx(styles.button, styles.buttonSmall)}
            disabled={busy}
            title="Rimette lo stato che la regola aveva prima dell’ultima modifica. Restano in cronologia sia quella modifica sia l’annullamento."
            onClick={() => onRollback(rule.id)}
          >
            Annulla ultima modifica
          </button>
        ) : null}
        {rule.manual.map((status) =>
          status === 'REJECTED' && !confirming ? (
            <button
              key={status}
              type="button"
              className={cx(styles.button, styles.buttonSmall)}
              disabled={busy}
              title={ACTION_HINTS[status]}
              onClick={() => setConfirming(true)}
            >
              {MANUAL_ACTION_LABELS[status]}
            </button>
          ) : (
            <button
              key={status}
              type="button"
              className={cx(
                styles.button,
                styles.buttonSmall,
                status === 'REJECTED' && styles.buttonDanger
              )}
              disabled={busy}
              title={ACTION_HINTS[status]}
              onClick={() => {
                setConfirming(false)
                onSetStatus(rule.id, status)
              }}
            >
              {status === 'REJECTED' ? 'Conferma lo scarto' : MANUAL_ACTION_LABELS[status]}
            </button>
          )
        )}
      </div>
    </li>
  )
}
