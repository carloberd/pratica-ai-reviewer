import type {
  Annotation,
  AuthStatus,
  BoundingBox,
  DashboardKpi,
  DocumentFilters,
  RegistryTypeOption,
  ReviewDecision,
  ReviewDocument,
  ReviewDocumentSummary,
  SyncProgress
} from '@shared/types'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { cx } from '../lib/cx'
import { api, errorMessage, needsLogin } from '../lib/ipc'
import AuthPanel from './auth-panel'
import DocumentFiltersBar from './document-filters'
import styles from './document-review.module.css'
import DocumentTable from './document-table'
import ReviewView from './review-view'

/**
 * Shell portata dal modulo PraticaAI Document Review v5.2. La struttura (sidebar,
 * dashboard con KPI, tabella documenti, vista di revisione con campi, evidenze e
 * timeline) è quella originale; i dati arrivano dal main attraverso i canali IPC:
 * i KPI da query SQL, la tabella dal database, la ricerca da FTS5.
 */
type View = 'dashboard' | 'documents' | 'review'

export default function DocumentReviewShell() {
  const [view, setView] = useState<View>('dashboard')
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [kpis, setKpis] = useState<DashboardKpi[]>([])
  const [documents, setDocuments] = useState<ReviewDocumentSummary[]>([])
  const [total, setTotal] = useState(0)
  const [filters, setFilters] = useState<DocumentFilters>({})
  const [types, setTypes] = useState<RegistryTypeOption[]>([])
  const [selected, setSelected] = useState<ReviewDocument | null>(null)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [progress, setProgress] = useState<SyncProgress | null>(null)

  const refresh = useCallback(async (current: DocumentFilters) => {
    try {
      const [status, stats, list, all] = await Promise.all([
        api.auth.status(),
        api.docs.stats(),
        api.docs.list(current),
        api.docs.list()
      ])
      setAuth(status)
      setKpis(stats.kpis)
      setDocuments(list)
      setTotal(all.length)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [])

  useEffect(() => {
    void refresh(filters)
  }, [refresh, filters])

  useEffect(() => {
    api.docs
      .types()
      .then(setTypes)
      .catch(() => setTypes([]))
    return window.reviewer.onSyncProgress((update) => {
      setProgress(update.phase === 'done' ? null : update)
    })
  }, [])

  /**
   * I tipi offerti dal filtro sono solo quelli presenti fra i documenti: un menu con
   * tutti e 511 i tipi del registry non aiuterebbe a filtrare.
   */
  const typesInUse = useMemo(() => {
    const present = new Set(documents.map((doc) => doc.documentType).filter((id) => id !== null))
    return types.filter((type) => present.has(type.id))
  }, [documents, types])

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
      await refresh(filters)
    })

  const logout = () =>
    run('logout', async () => {
      setAuth(await api.auth.logout())
    })

  const sync = () =>
    run('sync', async () => {
      const result = await api.drive.sync()
      await refresh(filters)
      setMessage(
        `Sincronizzazione completata: ${result.added} nuovi, ${result.updated} aggiornati, ${result.skipped} invariati.`
      )
      if (result.errors.length > 0) {
        setError(
          `${result.errors.length} documenti non sincronizzati. Primo: ${result.errors[0]?.filename} — ${result.errors[0]?.message}`
        )
      }
    })

  const openDocument = (id: string) =>
    run('open', async () => {
      const [document, marks] = await Promise.all([api.docs.get(id), api.annotations.list(id)])
      setSelected(document)
      setAnnotations(marks)
      setView('review')
    })

  const createAnnotation = (page: number, bbox: BoundingBox, kind: 'highlight' | 'note') => {
    if (!selected) return
    const documentId = selected.id
    void run('annotate', async () => {
      await api.annotations.add({ documentId, page, bbox, kind })
      setAnnotations(await api.annotations.list(documentId))
    })
  }

  const updateAnnotation = (id: string, note: string) => {
    if (!selected) return
    const documentId = selected.id
    void run('annotate', async () => {
      await api.annotations.update(id, note)
      setAnnotations(await api.annotations.list(documentId))
    })
  }

  const exportAnnotated = () => {
    if (!selected) return
    const documentId = selected.id
    void run('annotate', async () => {
      const { path } = await api.annotations.export(documentId)
      if (path) {
        setSelected(await api.docs.get(documentId))
        setMessage(`PDF annotato salvato in ${path}. Il file in cache non è stato modificato.`)
      }
    })
  }

  const deleteAnnotation = (id: string) => {
    if (!selected) return
    const documentId = selected.id
    void run('annotate', async () => {
      await api.annotations.delete(id)
      setAnnotations(await api.annotations.list(documentId))
    })
  }

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
      await refresh(filters)
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
      await refresh(filters)
    })
  }

  const busy = pending !== null

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
            <NavButton active={view === 'review'} onClick={() => setView('review')}>
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
                disabled={busy}
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
                  disabled={busy}
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
                  <button
                    type="button"
                    className={styles.button}
                    onClick={() => {
                      setFilters({ status: 'NEEDS_REVIEW' })
                      setView('documents')
                    }}
                  >
                    Vedi tutti
                  </button>
                </div>
                <DocumentTable
                  documents={documents.filter((doc) => doc.status === 'NEEDS_REVIEW').slice(0, 10)}
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
                <DocumentFiltersBar
                  filters={filters}
                  onChange={setFilters}
                  types={typesInUse}
                  total={total}
                  shown={documents.length}
                />
                <DocumentTable
                  documents={documents}
                  onOpen={openDocument}
                  emptyTitle={
                    total === 0 ? 'Nessun documento sincronizzato' : 'Nessun documento trovato'
                  }
                  emptyHint={
                    total === 0
                      ? 'Accedi con Google e avvia la sincronizzazione da Drive.'
                      : 'Prova ad allargare i filtri o a cambiare la ricerca.'
                  }
                />
              </>
            )}

            {view === 'review' &&
              (selected ? (
                <ReviewView
                  document={selected}
                  types={types}
                  annotations={annotations}
                  busy={busy}
                  onBack={() => setView('documents')}
                  onFieldCommit={commitField}
                  onDecide={decide}
                  onAssignType={assignType}
                  onCreateAnnotation={createAnnotation}
                  onUpdateAnnotation={updateAnnotation}
                  onDeleteAnnotation={deleteAnnotation}
                  onExportAnnotated={exportAnnotated}
                />
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
