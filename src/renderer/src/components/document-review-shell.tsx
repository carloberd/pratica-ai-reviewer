import type { ConfidenceBand, ReviewDocument } from '@shared/types'
import { useMemo, useState } from 'react'
import { cx } from '../lib/cx'
import { formatDateTime, pct, STATUS_LABELS, textSourceLabel, typeLabel } from '../lib/format'
import { dashboardKpis, mockDocuments } from '../lib/mock-data'
import styles from './document-review.module.css'

/**
 * Porting della shell `components/document-review/document-review-shell.tsx` del
 * modulo PraticaAI Document Review v5.2. In F0 gira ancora sui dati demo: la
 * sostituzione di `mock-data` con i dati reali via IPC avviene in F4.
 */
type View = 'dashboard' | 'documents' | 'review'

const BAND_CLASS: Record<ConfidenceBand, string | undefined> = {
  HIGH: styles.high,
  MEDIUM: styles.medium,
  LOW: styles.low
}

export default function DocumentReviewShell() {
  const [view, setView] = useState<View>('dashboard')
  const [documents] = useState<ReviewDocument[]>(mockDocuments)
  const [selectedId, setSelectedId] = useState<string | null>(mockDocuments[0]?.id ?? null)

  const selected = useMemo(
    () => documents.find((doc) => doc.id === selectedId) ?? documents[0] ?? null,
    [documents, selectedId]
  )

  function openDocument(id: string) {
    setSelectedId(id)
    setView('review')
  }

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
            <div className={styles.avatar}>AI</div>
          </header>

          <div className={styles.content}>
            <div className={styles.banner}>
              <span className={styles.bannerTitle}>Anteprima con dati demo.</span>
              <span>
                La pipeline Google Drive, SQLite e precompilazione non è ancora collegata.
              </span>
            </div>

            {view === 'dashboard' && (
              <>
                <section className={styles.kpiGrid}>
                  {dashboardKpis.map((kpi) => (
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
                <DocumentTable documents={documents} onOpen={openDocument} />
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
                <DocumentTable documents={documents} onOpen={openDocument} />
              </>
            )}

            {view === 'review' && selected && (
              <ReviewView document={selected} onBack={() => setView('documents')} />
            )}
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

function DocumentTable({
  documents,
  onOpen
}: {
  documents: ReviewDocument[]
  onOpen: (id: string) => void
}) {
  return (
    <div className={cx(styles.card, styles.tableWrap)}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Documento</th>
            <th>Tipo</th>
            <th>Testo</th>
            <th>Confidence</th>
            <th>Stato</th>
            <th>Modificato</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((doc) => (
            <tr key={doc.id} onClick={() => onOpen(doc.id)}>
              <td>
                <div className={styles.fileName}>{doc.filename}</div>
                <div className={styles.subtle}>{doc.source}</div>
              </td>
              <td>{typeLabel(doc.documentType, doc.documentTypeLabel)}</td>
              <td>{textSourceLabel(doc.textSource)}</td>
              <td>
                <span className={cx(styles.badge, BAND_CLASS[doc.confidenceBand])}>
                  {pct(doc.confidence)}
                </span>
              </td>
              <td>
                <span className={cx(styles.badge, styles.status)}>{STATUS_LABELS[doc.status]}</span>
              </td>
              <td>{formatDateTime(doc.receivedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ReviewView({ document, onBack }: { document: ReviewDocument; onBack: () => void }) {
  return (
    <>
      <button type="button" className={styles.back} onClick={onBack}>
        ← Torna ai documenti
      </button>
      <div className={styles.reviewLayout}>
        <section className={cx(styles.card, styles.panel)}>
          <div className={styles.panelTitle}>
            <div>
              <h2>{document.filename}</h2>
              <div className={styles.subtle}>{document.driveFileId}</div>
            </div>
            <span className={cx(styles.badge, BAND_CLASS[document.confidenceBand])}>
              {pct(document.confidence)}
            </span>
          </div>

          <div className={styles.metaGrid}>
            <div className={styles.meta}>
              <div className={styles.metaLabel}>Tipo documento</div>
              <div className={styles.metaValue}>
                {typeLabel(document.documentType, document.documentTypeLabel)}
              </div>
            </div>
            <div className={styles.meta}>
              <div className={styles.metaLabel}>Sorgente testo</div>
              <div className={styles.metaValue}>{textSourceLabel(document.textSource)}</div>
            </div>
            <div className={styles.meta}>
              <div className={styles.metaLabel}>Modificato su Drive</div>
              <div className={styles.metaValue}>{formatDateTime(document.receivedAt)}</div>
            </div>
          </div>

          {document.warnings.map((warning) => (
            <div className={styles.warning} key={warning}>
              {warning}
            </div>
          ))}

          <div className={styles.sectionHeader}>
            <div>
              <h2>Dati estratti</h2>
              <div className={styles.muted}>Ogni dato è collegato alla propria evidenza</div>
            </div>
          </div>
          <div className={styles.fieldList}>
            {document.fields.map((field) => (
              <div className={styles.fieldRow} key={field.id}>
                <div className={styles.fieldLabel}>{field.label}</div>
                <div className={field.value ? styles.fieldValue : styles.fieldEmpty}>
                  {field.value || 'Nessuna evidenza'}
                </div>
                <div className={styles.confidence}>{field.value ? pct(field.confidence) : '—'}</div>
              </div>
            ))}
          </div>

          <div className={styles.actions}>
            <button type="button" className={cx(styles.button, styles.buttonPrimary)} disabled>
              Approva
            </button>
            <button type="button" className={styles.button} disabled>
              Conferma con correzione
            </button>
            <button type="button" className={cx(styles.button, styles.buttonDanger)} disabled>
              Rifiuta
            </button>
          </div>
        </section>

        <div style={{ display: 'grid', gap: 16 }}>
          <section className={cx(styles.card, styles.panel)}>
            <div className={styles.panelTitle}>
              <h3>Evidenze</h3>
              <span className={cx(styles.badge, styles.status)}>
                {document.evidence.length} prove
              </span>
            </div>
            {document.evidence.map((evidence) => (
              <div className={styles.evidence} key={evidence.id}>
                <div className={styles.evidenceTop}>
                  <span>
                    {evidence.label} · pag. {evidence.page}
                  </span>
                  <strong>{pct(evidence.confidence)}</strong>
                </div>
                <div className={styles.evidenceText}>{evidence.text}</div>
              </div>
            ))}
          </section>

          <section className={cx(styles.card, styles.panel)}>
            <div className={styles.panelTitle}>
              <h3>Timeline documento</h3>
            </div>
            <div className={styles.timeline}>
              {document.timeline.map((item) => (
                <div className={styles.timelineItem} key={item.id}>
                  <div className={styles.dot} />
                  <div>
                    <div className={styles.timelineTitle}>{item.title}</div>
                    <div className={styles.timelineDetail}>{item.detail}</div>
                    <div className={styles.timelineAt}>{formatDateTime(item.at)}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </>
  )
}
