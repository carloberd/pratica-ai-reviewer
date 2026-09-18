import type { LearningOverview, ManualRuleStatus } from '@shared/learning-workspace'
import { LEARNING_MODE_LABELS, type LearningMode } from '@shared/local-learning'
import type { ProfileEdit } from '@shared/profile-edit'
import {
  type ActivityFeed,
  describeBundle,
  describeMapEdit,
  type TypeFieldMap
} from '@shared/profile-workspace'
import type {
  AuthStatus,
  CacheUsage,
  DashboardKpi,
  DocumentPick,
  DriveFileSummary,
  DriveFolderSummary,
  DriveListing,
  DriveLocation,
  DriveRoot,
  FetchProgress,
  RegistryTypeOption,
  ReviewAction,
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
import ExportMenu, { type ExportFormat } from './export-menu'
import HistoryView from './history-view'
import LearningView from './learning-view'
import { KpiSkeleton } from './loading-skeleton'
import ReviewView from './review-view'

/**
 * Shell dell'applicazione: navbar orizzontale e area di contenuto.
 *
 * I menu stanno in cima perché la revisione ha bisogno di tutta l'altezza della
 * finestra per il documento: una colonna laterale se ne mangerebbe una parte senza
 * dare niente in cambio. Le voci sono quattro — la dashboard, i documenti su Drive, la
 * cronologia e l'apprendimento, con la sua modalità sempre in vista — mentre la revisione si
 * apre da una riga e non è una destinazione a sé. I
 * campi da estrarre per tipo si correggono dentro la revisione, dal documento che ha fatto
 * notare l'errore.
 */
type View = 'dashboard' | 'documents' | 'history' | 'learning' | 'review'

/** La cartella aperta in «Documenti»: la radice e le cartelle attraversate per arrivarci. */
interface DrivePlace {
  root: DriveRoot
  path: DriveFolderSummary[]
}

const DRIVE_HOME: DrivePlace = { root: 'my-drive', path: [] }

function locationOf(place: DrivePlace): DriveLocation {
  return { root: place.root, folderId: place.path.at(-1)?.id ?? null }
}

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
  const [drivePlace, setDrivePlace] = useState<DrivePlace>(DRIVE_HOME)
  const [driveListing, setDriveListing] = useState<DriveListing | null>(null)
  const [driveLoaded, setDriveLoaded] = useState(false)
  const [fetchingId, setFetchingId] = useState<string | null>(null)
  const [cache, setCache] = useState<CacheUsage | null>(null)
  const [fieldMap, setFieldMap] = useState<TypeFieldMap | null>(null)
  const [history, setHistory] = useState<ActivityFeed | null>(null)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  /** Quello che il motore ha imparato: si rilegge con il resto, perché cambia a ogni revisione. */
  const [learning, setLearning] = useState<LearningOverview | null>(null)
  /**
   * La prima lettura del database è finita. Prima che lo sia, «nessun documento» non è
   * una risposta: è una domanda ancora aperta, e darla per buona significa smentirsi
   * un istante dopo, quando le righe arrivano.
   */
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [status, stats, list, overview] = await Promise.all([
        api.auth.status(),
        api.docs.stats(),
        api.docs.list(),
        api.learning.overview()
      ])
      setAuth(status)
      setKpis(stats.kpis)
      setDocuments(list)
      setLearning(overview)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLoaded(true)
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
      setDrivePlace(DRIVE_HOME)
      setDriveListing(null)
      setDriveLoaded(false)
    })

  /**
   * Solo metadati: aprire una cartella non scarica nessun file. Senza destinazione rilegge
   * quella aperta, e il contenuto vecchio resta a schermo finché arriva il nuovo; spostandosi
   * altrove invece sparisce subito, perché sarebbe il contenuto di un'altra cartella.
   */
  const loadDriveFiles = (place: DrivePlace = drivePlace) =>
    run('drive', async () => {
      if (place !== drivePlace) {
        setDrivePlace(place)
        setDriveListing(null)
      }
      const [listing, usage] = await Promise.all([
        api.drive.list(locationOf(place)),
        api.drive.cacheUsage()
      ])
      setDriveListing(listing)
      setCache(usage)
      setDriveLoaded(true)
    })

  const showDocuments = () => {
    setView('documents')
    if (!driveLoaded && auth?.signedIn && !pending) void loadDriveFiles()
  }

  /** La cronologia si rilegge dopo ogni azione che ci finisce dentro. */
  const loadHistory = () =>
    run('history', async () => {
      setHistory(await api.history.list())
      setHistoryLoaded(true)
    })

  const showHistory = () => {
    setView('history')
    // Si rilegge solo se nel frattempo è successo qualcosa: una correzione, un re-run,
    // un export o un documento chiuso.
    if (!historyLoaded && !pending) void loadHistory()
  }

  /** La mappa del tipo del documento aperto: si legge sul database locale, senza Drive. */
  const loadFieldMap = () => {
    if (!selected?.documentType) return
    const documentId = selected.id
    void run('map', async () => {
      setFieldMap(await api.map.get(documentId))
    })
  }

  /**
   * Una correzione alla mappa dalla revisione: il main la scrive e rielabora il documento,
   * che torna aggiornato insieme alla mappa. «Dati» mostra già i campi nuovi.
   */
  const editMap = (edit: ProfileEdit) => {
    if (!selected) return
    const documentId = selected.id
    void run('map-edit', async () => {
      const result = await api.map.edit(documentId, edit)
      setSelected(result.document)
      setFieldMap(result.map)
      setHistoryLoaded(false)
      setMessage(describeMapEdit(result))
      await refresh()
    })
  }

  const revertMap = (actionId: string) => {
    if (!selected) return
    const documentId = selected.id
    void run('map-revert', async () => {
      const result = await api.map.revert(documentId, actionId)
      setSelected(result.document)
      setFieldMap(result.map)
      setHistoryLoaded(false)
      setMessage(describeMapEdit(result))
      await refresh()
    })
  }

  /** Annulla dalla Cronologia: la mappa torna com'era, fuori da un documento. */
  const revertAction = (actionId: string) =>
    run('profile-revert', async () => {
      const action = await api.profiles.revert(actionId)
      setHistory(await api.history.list())
      setFieldMap(null)
      setMessage(action.detail)
    })

  /** La modalità del learner: vale dai documenti elaborati da adesso. */
  const setLearningMode = (mode: LearningMode) =>
    run('learning-mode', async () => {
      setLearning(await api.learning.setMode(mode))
      setHistoryLoaded(false)
      setMessage(
        `${LEARNING_MODE_LABELS[mode]}: vale dai documenti elaborati da adesso, quelli già precompilati restano come sono.`
      )
    })

  /** Sospende, riattiva o scarta una regola: la coda che ne dipende si rielabora nel main. */
  const setRuleStatus = (ruleId: string, status: ManualRuleStatus) =>
    run('learning-rule', async () => {
      const overview = await api.learning.setRuleStatus(ruleId, status)
      setLearning(overview)
      setMessage(overview.actions[0]?.detail ?? null)
      await refresh()
    })

  /**
   * Annulla l'ultimo cambio di stato di una regola. Come per un cambio a mano si rilegge
   * tutto: il ripristino può rimettere in gioco una regola, e la coda si rielabora.
   */
  const rollbackRule = (ruleId: string) =>
    run('learning-rule-rollback', async () => {
      const overview = await api.learning.rollbackRule(ruleId)
      setLearning(overview)
      setMessage(overview.actions[0]?.detail ?? null)
      await refresh()
    })

  /**
   * Ripassa per il learner le revisioni già chiuse. È idempotente: ogni documento ritira
   * le sue prove prima di rimetterle, quindi rilanciarlo non conta due volte.
   */
  const replayLearning = () =>
    run('learning-replay', async () => {
      const before = learning?.counts.events ?? 0
      const overview = await api.learning.replay()
      setLearning(overview)
      const added = overview.counts.events - before
      setMessage(
        added > 0
          ? `Revisioni ripassate: ${added.toLocaleString('it-IT')} decisioni in più registrate.`
          : 'Revisioni ripassate: non c’era niente di nuovo da registrare.'
      )
    })

  const exportLearning = () =>
    run('learning-export', async () => {
      const result = await api.learning.export()
      if (!result.saved) return
      setMessage(
        `Regole esportate in ${result.path}: ${result.rules} regole, ${result.events} decisioni registrate.`
      )
    })

  /** Doppio clic su un file: lo scarica, lo analizza e apre la revisione. */
  const openDriveFile = (file: DriveFileSummary) =>
    run('fetch', async () => {
      setFetchingId(file.id)
      try {
        const { documentId } = await api.drive.fetch(file.id)
        const [document, listing, usage] = await Promise.all([
          api.docs.get(documentId),
          api.drive.list(locationOf(drivePlace)),
          api.drive.cacheUsage()
        ])
        setSelected(document)
        setDriveListing(listing)
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
      const [document, listing, usage] = await Promise.all([
        api.docs.get(documentId),
        driveLoaded ? api.drive.list(locationOf(drivePlace)) : Promise.resolve(driveListing),
        api.drive.cacheUsage()
      ])
      setSelected(document)
      setDriveListing(listing)
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

  const commitField = (fieldId: string, value: string | null, pick?: DocumentPick) => {
    if (!selected) return
    const documentId = selected.id
    void run('field', async () => {
      setSelected(await api.fields.update(documentId, fieldId, value, pick))
    })
  }

  /** Le modifiche alle righe dei campi ripetuti: ogni risposta è il documento aggiornato. */
  const editDocument = (label: string, work: (documentId: string) => Promise<ReviewDocument>) => {
    if (!selected) return
    const documentId = selected.id
    void run(label, async () => {
      setSelected(await work(documentId))
    })
  }

  const commitItem = (itemId: string, value: string | null, pick?: DocumentPick) =>
    editDocument('field', (documentId) => api.fields.updateItem(documentId, itemId, value, pick))

  const removeItem = (itemId: string, removed: boolean) =>
    editDocument('field', (documentId) => api.fields.removeItem(documentId, itemId, removed))

  const addItem = (fieldId: string, value: string, pick?: DocumentPick) =>
    editDocument('field', (documentId) => api.fields.addItem(documentId, fieldId, value, pick))

  /**
   * Salva il dataset annotato dove sceglie il revisore, nella forma che ha scelto: lo
   * stesso export, due file diversi.
   */
  const exportDataset = (format: ExportFormat) =>
    run(`export-${format}`, async () => {
      const documents = (count: number) => (count === 1 ? '1 documento' : `${count} documenti`)

      if (format === 'json') {
        const result = await api.dataset.export()
        if (!result.saved) return
        const corrections =
          result.corrections === 1 ? '1 correzione' : `${result.corrections} correzioni`
        setMessage(
          `Dataset esportato in ${result.path}: ${documents(result.documents)}, ${corrections}.`
        )
        return
      }

      if (format === 'map') {
        const result = await api.profiles.exportMap()
        if (!result.saved) return
        setHistoryLoaded(false)
        setMessage(describeBundle(result))
        return
      }

      const result = await api.dataset.exportXlsx()
      if (!result.saved) return
      const fields = result.fields === 1 ? '1 riga campo' : `${result.fields} righe campo`
      setMessage(`Foglio esportato in ${result.path}: ${documents(result.documents)}, ${fields}.`)
    })

  const decide = (action: ReviewAction, note?: string) => {
    if (!selected) return
    const documentId = selected.id
    void run('decide', async () => {
      setSelected(await api.review.submit(documentId, action, note))
      setHistoryLoaded(false)
      await refresh()
      setMessage(
        action === 'DISCARD'
          ? 'Documento scartato: resta fuori dal dataset.'
          : 'Documento revisionato: tipo e campi sono a database.'
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
          <NavButton active={view === 'history'} onClick={showHistory}>
            Cronologia
          </NavButton>
          <NavButton active={view === 'learning'} onClick={() => setView('learning')}>
            Apprendimento
            {learning && (
              <span
                className={cx(
                  styles.navMode,
                  learning.mode === 'LEARNING' && styles.navModeLearning,
                  learning.mode === 'BASELINE' && styles.navModeBaseline
                )}
                data-mode={learning.mode}
                title={LEARNING_MODE_LABELS[learning.mode]}
              >
                {NAV_MODE[learning.mode]}
              </span>
            )}
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
            {loaded ? (
              <section className={styles.kpiGrid}>
                {kpis.map((kpi) => (
                  <article className={cx(styles.card, styles.kpi)} key={kpi.id}>
                    <div className={styles.kpiLabel}>{kpi.label}</div>
                    <div className={styles.kpiValue}>{kpi.value.toLocaleString('it-IT')}</div>
                    <div className={styles.kpiHint}>{kpi.hint}</div>
                  </article>
                ))}
              </section>
            ) : (
              <KpiSkeleton />
            )}

            <div className={styles.sectionHeader}>
              <div>
                <h2>Coda di revisione</h2>
                <div className={styles.muted}>Documenti che richiedono controllo umano</div>
              </div>
              <ExportMenu
                busy={busy}
                pending={
                  pending === 'export-json'
                    ? 'json'
                    : pending === 'export-xlsx'
                      ? 'xlsx'
                      : pending === 'export-map'
                        ? 'map'
                        : null
                }
                onExport={(format) => void exportDataset(format)}
              />
            </div>
            <DocumentTable
              documents={queue}
              onOpen={(id) => openDocument(id, 'dashboard')}
              loading={!loaded}
              loadingLabel="Carico la coda di revisione…"
              emptyTitle="Nessun documento da revisionare"
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
                  Le cartelle dell&apos;account su Google Drive: doppio clic su una cartella per
                  aprirla, su un file per scaricarlo, analizzarlo e aprirlo in revisione.
                </div>
              </div>
              {cache && (
                <div className={styles.muted}>
                  {cache.files === 1 ? '1 file in locale' : `${cache.files} file in locale`} ·{' '}
                  {formatBytes(cache.bytes)} in cache
                </div>
              )}
            </div>
            {driveLoaded || pending === 'drive' ? (
              <DriveFiles
                root={drivePlace.root}
                path={drivePlace.path}
                listing={driveListing}
                fetchingId={fetchingId}
                busy={busy}
                loading={pending === 'drive'}
                onOpen={openDriveFile}
                onNavigate={(root, path) => void loadDriveFiles({ root, path })}
              />
            ) : (
              /* Un'operazione qualsiasi in corso non dice niente su Drive: finché
                 l'elenco non è stato chiesto, la schermata resta questa. */
              <div className={cx(styles.card, styles.empty)}>
                <div className={styles.emptyTitle}>Elenco non ancora caricato</div>
                <div>
                  Usa «Aggiorna elenco Drive» dal menu dell&apos;account per leggere i file.
                </div>
              </div>
            )}
          </>
        )}

        {view === 'learning' && (
          <LearningView
            overview={learning}
            loading={!loaded}
            busy={busy}
            exporting={pending === 'learning-export'}
            replaying={pending === 'learning-replay'}
            onSetMode={setLearningMode}
            onSetRuleStatus={setRuleStatus}
            onReplay={replayLearning}
            onRollbackRule={rollbackRule}
            onExport={exportLearning}
          />
        )}

        {view === 'history' && (
          <HistoryView
            feed={history}
            loading={pending === 'history'}
            busy={busy}
            onRevert={revertAction}
            onOpenDocument={(id) => openDocument(id, 'history')}
          />
        )}

        {view === 'review' &&
          (selected ? (
            <ReviewView
              document={selected}
              types={types}
              busy={busy}
              onBack={() => setView(origin)}
              onFieldCommit={commitField}
              onItemCommit={commitItem}
              onItemRemove={removeItem}
              onItemAdd={addItem}
              onDecide={decide}
              onAssignType={assignType}
              onEvict={() => evictDocument(selected.id)}
              fieldMap={fieldMap}
              onLoadFieldMap={loadFieldMap}
              onMapEdit={editMap}
              onMapRevert={revertMap}
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

/** La modalità in una parola, accanto alla voce di menu. */
const NAV_MODE: Record<LearningMode, string> = {
  LEARNING: 'attivo',
  FROZEN: 'congelato',
  BASELINE: 'solo registry'
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
