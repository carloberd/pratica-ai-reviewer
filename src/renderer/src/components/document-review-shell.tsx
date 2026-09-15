import type {
  AuthStatus,
  DashboardKpi,
  ReviewDocument,
  ReviewDocumentSummary,
  SyncProgress
} from '@shared/types'
import { useCallback, useEffect, useState } from 'react'
import { cx } from '../lib/cx'
import { api, errorMessage, needsLogin } from '../lib/ipc'
import AuthPanel from './auth-panel'
import styles from './document-review.module.css'
import DocumentTable from './document-table'
import ReviewView from './review-view'

/**
 * Shell portata dal modulo PraticaAI Document Review v5.2. La struttura (sidebar,
 * dashboard con KPI, tabella documenti, vista di revisione con campi, evidenze e
 * timeline) è quella originale; i dati non arrivano più da `mock-data` ma dal main
 * attraverso i canali IPC.
 */
type View = 'dashboard' | 'documents' | 'review'

export default function DocumentReviewShell() {
  const [view, setView] = useState<View>('dashboard')
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [kpis, setKpis] = useState<DashboardKpi[]>([])
  const [documents, setDocuments] = useState<ReviewDocumentSummary[]>([])
  const [selected, setSelected] = useState<ReviewDocument | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<SyncProgress | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [status, stats, list] = await Promise.all([
        api.auth.status(),
        api.docs.stats(),
        api.docs.list()
      ])
      setAuth(status)
      setKpis(stats.kpis)
      setDocuments(list)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [])

  useEffect(() => {
    void refresh()
    return window.reviewer.onSyncProgress((update) => {
      setProgress(update.phase === 'done' ? null : update)
    })
  }, [refresh])

  async function run(label: string, work: () => Promise<void>) {
    setPending(label)
    setError(null)
    try {
      await work()
    } catch (caught) {
      setError(errorMessage(caught))
      if (needsLogin(caught))
        setAuth((current) => (current ? { ...current, signedIn: false } : current))
    } finally {
      setPending(null)
      setProgress(null)
    }
  }

  const login = () =>
    run('login', async () => {
      setAuth(await api.auth.login())
      await refresh()
    })

  const logout = () =>
    run('logout', async () => {
      setAuth(await api.auth.logout())
    })

  const sync = () =>
    run('sync', async () => {
      const result = await api.drive.sync()
      await refresh()
      if (result.errors.length > 0) {
        setError(
          `Sincronizzazione completata con ${result.errors.length} errori. Primo: ${result.errors[0]?.message}`
        )
      }
    })

  const openDocument = (id: string) =>
    run('open', async () => {
      setSelected(await api.docs.get(id))
      setView('review')
    })

  return (
    <div className={styles.shell}>
      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles.brand}>
            <span className={styles.logo}>P</span> PraticaAI Reviewer
          </div>
          <nav className={styles.nav}>
            <NavButton active={view === 'dashboard'} onClick={() => setView('dashboard')}>
              Dashboard
            </NavButton>
            <NavButton active={view === 'documents'} onClick={() => setView('documents')}>
              Documenti
            </NavButton>
            <NavButton active={view === 'review'} onClick={() => selected && setView('review')}>
              Revisione
            </NavButton>
          </nav>
          <div className={styles.navSpacer} />
          {auth?.signedIn && (
            <div className={styles.userBox}>
              <div className={styles.userMail}>{auth.email ?? 'Account Google collegato'}</div>
              <button
                type="button"
                className={cx(styles.button, styles.buttonSmall)}
                disabled={pending !== null}
                onClick={logout}
              >
                Esci
              </button>
            </div>
          )}
          <div className={styles.sidebarFooter}>Document Brain · Review v5.2</div>
        </aside>

        <main className={styles.main}>
          <header className={styles.topbar}>
            <div className={styles.titleWrap}>
              <h1>
                {view === 'dashboard'
                  ? 'Revisione documenti'
                  : view === 'documents'
                    ? 'Documenti'
                    : 'Revisione documento'}
              </h1>
              <p>Controllo documentale con evidenze e human review</p>
            </div>
            <div className={styles.toolbar}>
              {auth?.signedIn && (
                <button
                  type="button"
                  className={cx(styles.button, styles.buttonPrimary)}
                  disabled={pending !== null}
                  onClick={sync}
                >
                  {pending === 'sync' ? 'Sincronizzo…' : 'Sincronizza da Drive'}
                </button>
              )}
              <div className={styles.avatar}>AI</div>
            </div>
          </header>

          <div className={styles.content}>
            <AuthPanel status={auth} busy={pending === 'login'} onLogin={login} />

            {progress && (
              <div className={styles.banner}>
                <span className={styles.bannerTitle}>
                  {progress.phase === 'listing'
                    ? 'Leggo i file su Drive…'
                    : progress.phase === 'downloading'
                      ? 'Scarico i documenti…'
                      : 'Estraggo il testo…'}
                </span>
                <span>
                  {progress.total > 0 && `${progress.current} di ${progress.total}`}
                  {progress.filename && ` · ${progress.filename}`}
                </span>
              </div>
            )}

            {error && <div className={styles.error}>{error}</div>}

            {view === 'dashboard' && (
              <>
                <section className={styles.kpiGrid}>
                  {kpis.map((kpi) => (
                    <article className={cx(styles.card, styles.kpi)} key={kpi.id}>
                      <div className={styles.kpiLabel}>{kpi.label}</div>
                      <div className={styles.kpiValue}>{kpi.value.toLocaleString('it-IT')}</div>
                      <div className={styles.kpiHint}>{kpi.hint}</div>
                    </article>
                  ))}
                </section>

                <div className={styles.sectionHeader}>
                  <div>
                    <h2>Coda di revisione</h2>
                    <div className={styles.muted}>Documenti che richiedono controllo umano</div>
                  </div>
                  <button
                    type="button"
                    className={styles.button}
                    onClick={() => setView('documents')}
                  >
                    Vedi tutti
                  </button>
                </div>
                <DocumentTable
                  documents={documents.filter((doc) => doc.status === 'NEEDS_REVIEW')}
                  onOpen={openDocument}
                  emptyTitle="Nessun documento da verificare"
                  emptyHint="Sincronizza da Google Drive per popolare la coda."
                />
              </>
            )}

            {view === 'documents' && (
              <>
                <div className={styles.sectionHeader}>
                  <div>
                    <h2>Documenti</h2>
                    <div className={styles.muted}>
                      Classificazione, confidence e stato di revisione
                    </div>
                  </div>
                </div>
                <DocumentTable
                  documents={documents}
                  onOpen={openDocument}
                  emptyTitle="Nessun documento sincronizzato"
                  emptyHint="Accedi con Google e avvia la sincronizzazione da Drive."
                />
              </>
            )}

            {view === 'review' &&
              (selected ? (
                <ReviewView document={selected} onBack={() => setView('documents')} />
              ) : (
                <div className={cx(styles.card, styles.empty)}>
                  <div className={styles.emptyTitle}>Nessun documento aperto</div>
                  <div>Scegli un documento dalla tabella per iniziare la revisione.</div>
                </div>
              ))}
          </div>
        </main>
      </div>
    </div>
  )
}

function NavButton({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      className={cx(styles.navButton, active && styles.navActive)}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
