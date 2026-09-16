import type { AuthStatus } from '@shared/types'
import { useEffect, useRef, useState } from 'react'
import { cx } from '../lib/cx'
import styles from './document-review.module.css'

interface Props {
  auth: AuthStatus
  busy: boolean
  /** `true` mentre è in corso proprio la lettura dell'elenco di Drive. */
  refreshing: boolean
  onRefreshDrive: () => void
  onLogout: () => void
}

/**
 * Menu dell'account, appeso all'avatar nella navbar.
 *
 * Aggiornare l'elenco di Drive e uscire sono le due azioni legate all'account
 * collegato, non alla schermata che si sta guardando: stanno qui invece di occupare
 * spazio in cima a ogni pagina.
 */
export default function AccountMenu({ auth, busy, refreshing, onRefreshDrive, onLogout }: Props) {
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

  return (
    <div className={styles.account} ref={root}>
      <button
        type="button"
        className={styles.avatar}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account"
        title={auth.email ?? 'Account Google collegato'}
        onClick={() => setOpen((current) => !current)}
      >
        {initialOf(auth.email)}
      </button>

      {open && (
        <div className={cx(styles.card, styles.accountMenu)} role="menu">
          <div className={styles.accountMail}>{auth.email ?? 'Account Google collegato'}</div>
          <button
            type="button"
            role="menuitem"
            className={styles.accountItem}
            disabled={busy}
            onClick={() => {
              setOpen(false)
              onRefreshDrive()
            }}
          >
            {refreshing ? 'Leggo Drive…' : 'Aggiorna elenco Drive'}
          </button>
          <button
            type="button"
            role="menuitem"
            className={styles.accountItem}
            disabled={busy}
            onClick={() => {
              setOpen(false)
              onLogout()
            }}
          >
            Esci
          </button>
        </div>
      )}
    </div>
  )
}

/** L'iniziale della mail dell'account: due lettere fisse non direbbero di chi è. */
function initialOf(email: string | null): string {
  const first = email?.trim().charAt(0)
  return first ? first.toUpperCase() : '?'
}
