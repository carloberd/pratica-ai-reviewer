import type { AuthStatus } from '@shared/types'
import { cx } from '../lib/cx'
import styles from './document-review.module.css'

interface Props {
  status: AuthStatus | null
  busy: boolean
  onLogin: () => void
}

/**
 * Senza credenziali l'app non deve piantarsi: mostra cosa manca e come rimediare.
 */
export default function AuthPanel({ status, busy, onLogin }: Props) {
  if (!status) return null

  if (!status.configured) {
    return (
      <div className={cx(styles.banner, styles.bannerWarn)}>
        <span className={styles.bannerTitle}>Configurazione incompleta.</span>
        <span>{status.setupHint}</span>
      </div>
    )
  }

  if (!status.signedIn) {
    return (
      <div className={styles.banner}>
        <span className={styles.bannerTitle}>Nessun account collegato.</span>
        <span>
          {busy
            ? "Completa l'accesso nella finestra del browser che si è aperta, poi torna qui."
            : "Accedi con l'account Google che contiene i documenti. Il consenso si apre nel browser di sistema e l'app chiede il solo permesso di lettura su Drive."}
        </span>
        <span className={styles.spacer} />
        <button
          type="button"
          className={cx(styles.button, styles.buttonPrimary)}
          disabled={busy}
          onClick={onLogin}
        >
          {busy ? 'In attesa dal browser…' : 'Accedi con Google'}
        </button>
      </div>
    )
  }

  return null
}
