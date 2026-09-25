import { useEffect, useRef, useState } from 'react'
import { cx } from '../lib/cx'
import styles from './document-review.module.css'

/** Quale export è in corso, per l'etichetta del pulsante. */
export type ExportFormat = 'json' | 'xlsx' | 'bundle' | 'map'

interface Props {
  busy: boolean
  pending: ExportFormat | null
  onExport: (format: ExportFormat) => void
}

/**
 * Il pulsante «Esporta» della dashboard.
 *
 * Le prime due voci sono lo stesso dataset in due forme — gli stessi documenti chiusi dal
 * revisore, le stesse regole sul valore confermato — e cambia solo la forma del file. La
 * terza è una cartella con dentro tutte e due più una copia dei documenti revisionati: è
 * quella da mandare a chi il dataset lo userà, perché le evidenze rimandano a file che
 * altrimenti restano su questa macchina.
 *
 * L'ultima è un'altra cosa e sta sotto una riga di separazione: non i documenti annotati,
 * ma la mappa «tipo ↔ dati da estrarre» come l'ha corretta il revisore. È l'unico modo in
 * cui quelle correzioni diventano file: durante il lavoro restano nel database.
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
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => choose('bundle')}
          >
            Dataset completo con i documenti
            <span className={styles.menuItemHint}>
              Una cartella con JSON, Excel e una copia dei file revisionati: da mandare a chi userà
              il dataset.
            </span>
          </button>
          <div className={styles.menuSeparator} />
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => choose('map')}
          >
            Mappa dei campi da estrarre
            <span className={styles.menuItemHint}>
              I file per pratica-ai: profili e hint corretti, gli schemi JSON e il changelog di
              tutte le decisioni.
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
