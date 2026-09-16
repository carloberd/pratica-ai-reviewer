import type {
  AuthStatus,
  CacheUsage,
  DashboardKpi,
  DriveFileSummary,
  FetchProgress,
  RegistryTypeOption,
  ReviewDecision,
  ReviewDocument,
  ReviewDocumentSummary
} from '@shared/types'
import { useCallback, useEffect, useState } from 'react'
import { cx } from '../lib/cx'
import { formatBytes } from '../lib/format'
import { api, errorMessage, needsLogin } from '../lib/ipc'
import AccountMenu from './account-menu'
import AuthPanel from './auth-panel'
import styles from './document-review.module.css'
import DocumentTable from './document-table'
import DriveFiles from './drive-files'
import ReviewView from './review-view'

/**
 * Shell dell'applicazione: navbar orizzontale e area di contenuto.
 *
 * I menu stanno in cima perché la revisione ha bisogno di tutta l'altezza della
 * finestra per il documento: una colonna laterale se ne mangerebbe una parte senza
 * dare niente in cambio. Restano due voci — la dashboard e i documenti su Drive —
 * mentre la revisione si apre da una riga e non è una destinazione a sé.
 */
type View = 'dashboard' | 'documents' | 'review'

export default function DocumentReviewShell() {
  const [view, setView] = useState<View>('dashboard')
  /** Dove torna il pulsante «indietro» della revisione. */
  const [origin, setOrigin] = useState<Exclude<View, 'review'>>('dashboard')
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [kpis, setKpis] = useState<DashboardKpi[]>([])
  const [documents, setDocuments] = useState<ReviewDocumentSummary[]>([])
  const [types, setTypes] = useState<RegistryTypeOption[]>([])
  const [selected, setSelected] = useState<ReviewDocument | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [progress, setProgress] = useState<FetchProgress | null>(null)
  const [driveFiles, setDriveFiles] = useState<DriveFileSummary[]>([])
  const [driveLoaded, setDriveLoaded] = useState(false)
  const [fetchingId, setFetchingId] = useState<string | null>(null)
  const [cache, setCache] = useState<CacheUsage | null>(null)

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
  }, [refresh])

  useEffect(() => {
    api.docs
      .types()
      .then(setTypes)
      .catch(() => setTypes([]))
    return window.reviewer.onFetchProgress((update) => {
      setProgress(update.phase === 'done' ? null : update)
    })
  }, [])

  async function run(label: string, work: () => Promise<void>) {
    setPending(label)
    setError(null)
    setMessage(null)
    try {
      await work()
    } catch (caught) {
      setError(errorMessage(caught))
      if (needsLogin(caught)) {
        setAuth((current) => (current ? { ...current, signedIn: false } : current))
      }
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
      setDriveFiles([])
      setDriveLoaded(false)
    })

  /** Solo metadati: aggiornare l'elenco non scarica nessun file. */
  const loadDriveFiles = () =>
    run('drive', async () => {
      const [files, usage] = await Promise.all([api.drive.list(), api.drive.cacheUsage()])
      setDriveFiles(files)
      setCache(usage)
      setDriveLoaded(true)
    })

  const showDocuments = () => {
    setView('documents')
    if (!driveLoaded && auth?.signedIn && !pending) void loadDriveFiles()
  }

  /** Doppio clic su un file: lo scarica, lo analizza e apre la revisione. */
  const openDriveFile = (file: DriveFileSummary) =>
    run('fetch', async () => {
      setFetchingId(file.id)
      try {
        const { documentId } = await api.drive.fetch(file.id)
        const [document, files, usage] = await Promise.all([
          api.docs.get(documentId),
          api.drive.list(),
          api.drive.cacheUsage()
        ])
        setSelected(document)
        setDriveFiles(files)
        setCache(usage)
        setOrigin('documents')
        setView('review')
        await refresh()
      } finally {
        setFetchingId(null)
      }
    })

  const evictDocument = (documentId: string) =>
    run('evict', async () => {
      const { freedBytes } = await api.docs.evict(documentId)
      const [document, files, usage] = await Promise.all([
        api.docs.get(documentId),
        driveLoaded ? api.drive.list() : Promise.resolve(driveFiles),
        api.drive.cacheUsage()
      ])
      setSelected(document)
      setDriveFiles(files)
      setCache(usage)
      setMessage(
        `Copia locale rimossa: ${formatBytes(freedBytes)} liberati. I dati estratti restano.`
      )
    })

  const openDocument = (id: string, from: Exclude<View, 'review'>) =>
    run('open', async () => {
      setSelected(await api.docs.get(id))
      setOrigin(from)
      setView('review')
    })

  const commitField = (fieldId: string, value: string | null) => {
    if (!selected) return
    const documentId = selected.id
    void run('field', async () => {
      setSelected(await api.fields.update(documentId, fieldId, value))
    })
  }

  const decide = (decision: ReviewDecision, note?: string) => {
    if (!selected) return
    const documentId = selected.id
    void run('decide', async () => {
      setSelected(await api.review.submit(documentId, decision, note))
      await refresh()
      setMessage(
        decision === 'REJECT' ? 'Revisione registrata come rifiutata.' : 'Revisione registrata.'
      )
    })
  }

  const assignType = (documentType: string | null) => {
    if (!selected) return
    const documentId = selected.id
    void run('type', async () => {
      setSelected(await api.docs.setType(documentId, documentType))
      await refresh()
    })
  }

  const busy = pending !== null
  const queue = documents.filter((doc) => doc.status === 'NEEDS_REVIEW')

  return (
    <div className={styles.shell}>
      <header className={styles.navbar}>
        <div className={styles.brand}>
          <span className={styles.logo}>P</span> PraticaAI Reviewer
        </div>
        <nav className={styles.nav}>
          <NavButton active={view === 'dashboard'} onClick={() => setView('dashboard')}>
            Dashboard
          </NavButton>
          <NavButton active={view === 'documents'} onClick={showDocuments}>
            Documenti
          </NavButton>
        </nav>
        <span className={styles.spacer} />
        {auth?.signedIn && (
          <AccountMenu
            auth={auth}
            busy={busy}
            refreshing={pending === 'drive'}
            onRefreshDrive={() => {
              setView('documents')
              void loadDriveFiles()
            }}
            onLogout={logout}
          />
        )}
      </header>

      <main className={cx(styles.content, view === 'review' && styles.contentReview)}>
        <AuthPanel status={auth} busy={pending === 'login'} onLogin={login} />

        {progress && (
          <div className={styles.banner}>
            <span className={styles.bannerTitle}>
              {progress.phase === 'downloading'
                ? 'Scarico il documento…'
                : 'Analizzo il documento…'}
            </span>
            <span>{progress.filename}</span>
          </div>
        )}

        {error && <div className={styles.error}>{error}</div>}
        {message && <div className={styles.success}>{message}</div>}

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
            </div>
            <DocumentTable
              documents={queue}
              onOpen={(id) => openDocument(id, 'dashboard')}
              emptyTitle="Nessun documento da verificare"
              emptyHint="Apri un file da «Documenti» per popolare la coda."
            />
          </>
        )}

        {view === 'documents' && (
          <>
            <div className={styles.sectionHeader}>
              <div>
                <h2>Documenti</h2>
                <div className={styles.muted}>
                  I file dell&apos;account su Google Drive: doppio clic su un file per scaricarlo,
                  analizzarlo e aprirlo in revisione.
                </div>
              </div>
              {cache && (
                <div className={styles.muted}>
                  {cache.files === 1 ? '1 file in locale' : `${cache.files} file in locale`} ·{' '}
                  {formatBytes(cache.bytes)} in cache
                </div>
              )}
            </div>
            {!driveLoaded && !busy ? (
              <div className={cx(styles.card, styles.empty)}>
                <div className={styles.emptyTitle}>Elenco non ancora caricato</div>
                <div>
                  Usa «Aggiorna elenco Drive» dal menu dell&apos;account per leggere i file.
                </div>
              </div>
            ) : (
              <DriveFiles
                files={driveFiles}
                fetchingId={fetchingId}
                busy={busy}
                onOpen={openDriveFile}
                emptyHint="L'account non ha PDF o DOCX fuori dal cestino."
              />
            )}
          </>
        )}

        {view === 'review' &&
          (selected ? (
            <ReviewView
              document={selected}
              types={types}
              busy={busy}
              onBack={() => setView(origin)}
              onFieldCommit={commitField}
              onDecide={decide}
              onAssignType={assignType}
              onEvict={() => evictDocument(selected.id)}
            />
          ) : (
            <div className={cx(styles.card, styles.empty)}>
              <div className={styles.emptyTitle}>Nessun documento aperto</div>
              <div>Scegli un documento dalla tabella per iniziare la revisione.</div>
            </div>
          ))}
      </main>
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
