import { useEffect, useRef, useState } from 'react'
import { cx } from '../lib/cx'
import styles from './document-review.module.css'

/** Quale dei due export è in corso, per l'etichetta del pulsante. */
export type ExportFormat = 'json' | 'xlsx'

interface Props {
  busy: boolean
  pending: ExportFormat | null
  onExport: (format: ExportFormat) => void
}

/**
 * Il pulsante «Esporta» della dashboard, con le due forme dello stesso dataset.
 *
 * Sono lo stesso export — gli stessi documenti chiusi dal revisore, le stesse regole sul
 * valore confermato — e cambia solo la forma del file: due pulsanti affiancati facevano
 * sembrare che fossero due cose diverse. La riga sotto ogni voce dice a cosa serve
 * quella forma, che è l'unica domanda che si fa chi sta per esportare.
 */
export default function ExportMenu({ busy, pending, onExport }: Props) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const choose = (format: ExportFormat) => {
    setOpen(false)
    onExport(format)
  }

  return (
    <div className={styles.menuAnchor} ref={root}>
      <button
        type="button"
        className={styles.button}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        title="Salva i documenti revisionati e scartati, con i valori confermati e le correzioni."
        onClick={() => setOpen((current) => !current)}
      >
        {pending ? 'Esporto…' : 'Esporta'}
      </button>

      {open && (
        <div className={cx(styles.card, styles.menu, styles.exportMenu)} role="menu">
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => choose('json')}
          >
            JSON
            <span className={styles.menuItemHint}>
              L&apos;input del benchmark: manifest, valori confermati e correzioni prima/dopo.
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => choose('xlsx')}
          >
            Excel
            <span className={styles.menuItemHint}>
              Due fogli da lavorare in tabella: una riga per documento, una per campo.
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
