import type { EvidenceTarget } from '@shared/evidence-locate'
import { firstLine } from '@shared/evidence-locate'
import { cx } from '../lib/cx'
import styles from './document-review.module.css'

interface Props {
  target: EvidenceTarget
  /** È il punto del documento mostrato in questo momento. */
  active?: boolean
  onFocus: (target: EvidenceTarget) => void
}

/**
 * L'origine di un valore, cliccabile: pagina e riga del documento da cui il motore l'ha
 * letto. Il clic porta il documento a quel punto e lo evidenzia, senza cambiare scheda:
 * chi controlla un valore resta accanto al campo che sta controllando.
 */
export default function EvidenceLink({ target, active = false, onFocus }: Props) {
  const line = firstLine(target.text)
  return (
    <button
      type="button"
      className={cx(styles.evidenceLink, active && styles.evidenceLinkActive)}
      title={`Mostra nel documento: ${target.text}`}
      data-evidence-page={target.page}
      onClick={() => onFocus(target)}
    >
      <span className={styles.evidenceLinkPage}>pag. {target.page}</span>
      <span className={styles.evidenceLinkText}>{line}</span>
    </button>
  )
}
