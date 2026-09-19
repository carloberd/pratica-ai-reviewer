import { validationMessage } from '@shared/validation-messages'
import styles from './document-review.module.css'

/**
 * Cosa non torna nel valore salvato di un campo o di una riga. Non blocca niente: un
 * documento può riportare davvero un codice sbagliato, e allora il valore giusto è quello.
 */
export default function ValidationNote({ id, errors }: { id: string; errors: string[] }) {
  return (
    <div id={id} className={styles.validationNote}>
      {errors.map((code) => (
        <span key={code}>{validationMessage(code)}</span>
      ))}
    </div>
  )
}
