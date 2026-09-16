import { type EvidenceTarget, targetOfLocation } from '@shared/evidence-locate'
import {
  shouldSuggestCandidates,
  TYPE_MATCH_REASON_LABELS,
  TYPE_SIGNAL_SOURCE_LABELS
} from '@shared/review-workspace'
import type { ReviewDocument, TypeCandidate } from '@shared/types'
import { cx } from '../lib/cx'
import { pct } from '../lib/format'
import styles from './document-review.module.css'
import EvidenceLink from './evidence-link'

interface Props {
  document: Pick<ReviewDocument, 'documentType' | 'typeConfidence' | 'classification'>
  disabled: boolean
  onAssign: (documentType: string) => void
  onFocusEvidence: (target: EvidenceTarget) => void
}

/**
 * I candidati del classificatore nella scheda tipo, col punteggio e le frasi del
 * documento che li suggeriscono. Quando il tipo manca o il margine è basso stanno in
 * vista; altrimenti restano consultabili, chiusi. Il classificatore propone e basta:
 * il tipo lo sceglie il revisore, da qui o cercando fra tutti i tipi del registry.
 */
export default function TypeCandidates({ document, disabled, onAssign, onFocusEvidence }: Props) {
  const classification = document.classification
  if (!classification) return null

  const suggest = shouldSuggestCandidates(document)
  const { candidates, reason } = classification

  const summary =
    reason === 'OK'
      ? classification.margin !== null
        ? `Assegnato con margine ${pct(classification.margin)} sul secondo candidato.`
        : 'Assegnato dal classificatore.'
      : `Il classificatore non ha assegnato il tipo: ${TYPE_MATCH_REASON_LABELS[reason]}.`

  if (candidates.length === 0) {
    return reason === 'OK' ? null : (
      <div className={styles.muted}>{summary} Cerca il tipo fra quelli del registry.</div>
    )
  }

  const list = (
    <div className={styles.candidateList}>
      {candidates.map((candidate) => (
        <Candidate
          key={candidate.documentType}
          candidate={candidate}
          current={candidate.documentType === document.documentType}
          disabled={disabled}
          onAssign={onAssign}
          onFocusEvidence={onFocusEvidence}
        />
      ))}
    </div>
  )

  if (suggest) {
    return (
      <div className={styles.candidates} data-suggested="true">
        <div className={styles.candidatesTitle}>Candidati proposti</div>
        <div className={styles.muted}>{summary}</div>
        {list}
      </div>
    )
  }

  return (
    <details className={styles.candidates}>
      <summary className={styles.candidatesTitle}>
        Candidati del classificatore ({candidates.length})
      </summary>
      <div className={styles.muted}>{summary}</div>
      {list}
    </details>
  )
}

function Candidate({
  candidate,
  current,
  disabled,
  onAssign,
  onFocusEvidence
}: {
  candidate: TypeCandidate
  current: boolean
  disabled: boolean
  onAssign: (documentType: string) => void
  onFocusEvidence: (target: EvidenceTarget) => void
}) {
  return (
    <div
      className={cx(styles.candidate, current && styles.candidateCurrent)}
      data-type={candidate.documentType}
    >
      <div className={styles.candidateHead}>
        <div>
          <div className={styles.candidateLabel}>{candidate.label ?? candidate.documentType}</div>
          <div className={styles.comboHint}>{candidate.documentType}</div>
        </div>
        <span className={styles.candidateScore}>{pct(candidate.score)}</span>
      </div>

      {candidate.signals.length > 0 && (
        <ul className={styles.signalList}>
          {candidate.signals.map((signal) => (
            <li
              key={`${signal.source}:${signal.phrase}`}
              className={cx(signal.delta < 0 && styles.signalNegative)}
            >
              <span>
                {signal.delta < 0 ? '−' : '+'} «{signal.phrase}»{' '}
                {TYPE_SIGNAL_SOURCE_LABELS[signal.source]}
              </span>
              {signal.location && (
                <EvidenceLink
                  target={targetOfLocation(signal.location)}
                  onFocus={onFocusEvidence}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className={cx(styles.button, styles.buttonSmall, !current && styles.buttonPrimary)}
        disabled={disabled || current}
        onClick={() => onAssign(candidate.documentType)}
      >
        {current ? 'Tipo attuale' : 'Assegna questo tipo'}
      </button>
    </div>
  )
}
