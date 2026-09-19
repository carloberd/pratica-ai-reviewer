import {
  type CompanyIdentity,
  type DirectionChoice,
  directionOf,
  isDirectionalType
} from '@shared/document-direction'
import type { ReviewDocument } from '@shared/types'
import { cx } from '../lib/cx'
import styles from './document-review.module.css'

interface Props {
  document: ReviewDocument
  /** L'azienda di cui sono i documenti; vuota finché nessuno l'ha scritta. */
  company: CompanyIdentity
  busy: boolean
  /** `null` toglie la scelta e rimette quella calcolata. */
  onChoose: (choice: DirectionChoice | null) => void
}

const CHOICES: Array<{ id: DirectionChoice; label: string }> = [
  { id: 'EMESSO', label: 'Emesso' },
  { id: 'RICEVUTO', label: 'Ricevuto' },
  { id: 'NESSUNA', label: 'Né l’uno né l’altro' }
]

const MATCH_LABELS = {
  FISCAL_ID: 'partita IVA o codice fiscale della parte',
  NAME: 'nome della parte'
} as const

/**
 * Emesso o ricevuto, sulla scheda «Dati».
 *
 * Non è un campo estratto e non si cerca nel documento: si ricava confrontando emittente
 * e destinatario con l'azienda di cui sono i documenti. Per questo sta fuori dai campi,
 * accanto al tipo: sono le due cose che il revisore decide **sul** documento, non dentro.
 *
 * Compare solo sui tipi che una direzione ce l'hanno: su una visura la domanda non ha
 * senso, e una riga vuota in più su ogni documento sarebbe solo rumore.
 */
export default function DirectionPanel({ document, company, busy, onChoose }: Props) {
  if (!isDirectionalType(document.documentType)) return null

  const state = directionOf({
    documentType: document.documentType,
    company,
    fields: document.fields,
    choice: document.directionChoice
  })
  const hasCompany = Boolean(company.name ?? company.vatNumber ?? company.taxCode)

  return (
    <div className={styles.panelSection} data-direction={state.value ?? 'NESSUNA'}>
      <div className={styles.panelLabel}>Emesso o ricevuto</div>
      <div className={styles.directionChoices}>
        {CHOICES.map((choice) => (
          <button
            key={choice.id}
            type="button"
            aria-pressed={state.choice === choice.id}
            className={cx(
              styles.iconButton,
              styles.directionChoice,
              // Quello che vale adesso, che l'abbia deciso il revisore o il calcolo.
              (state.choice ?? state.computed?.direction) === choice.id && styles.directionActive
            )}
            disabled={busy}
            onClick={() => onChoose(state.choice === choice.id ? null : choice.id)}
          >
            {choice.label}
          </button>
        ))}
      </div>

      <div className={styles.muted}>
        {!hasCompany ? (
          <>
            Non si calcola: l’azienda di cui sono i documenti non è ancora scritta. La trovi nella
            dashboard, sotto «L’azienda di cui sono i documenti».
          </>
        ) : state.chosenBy === 'REVIEWER' ? (
          <>
            Scelto dal revisore.{' '}
            {state.computed
              ? `Dal documento risultava ${state.computed.direction.toLowerCase()}.`
              : 'Dal documento non si ricavava.'}{' '}
            <button
              type="button"
              className={styles.linkButton}
              disabled={busy}
              onClick={() => onChoose(null)}
            >
              Torna al calcolo
            </button>
          </>
        ) : state.computed ? (
          <>Dal confronto col {MATCH_LABELS[state.computed.matchedBy]}.</>
        ) : (
          <>
            Non si ricava: nessuna delle due parti è l’azienda, o la stessa partita IVA è finita su
            tutte e due. Sistema i campi e il conto si rifà da solo.
          </>
        )}
      </div>
    </div>
  )
}
