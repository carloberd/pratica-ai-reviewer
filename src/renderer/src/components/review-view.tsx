import type {
  Annotation,
  BoundingBox,
  RegistryTypeOption,
  ReviewDecision,
  ReviewDocument
} from '@shared/types'
import { useState } from 'react'
import { cx } from '../lib/cx'
import { formatDateTime, pct, textSourceLabel, typeLabel } from '../lib/format'
import DocumentPreview from './document-preview'
import styles from './document-review.module.css'
import { BAND_CLASS } from './document-table'
import FieldEditor from './field-editor'

interface Props {
  document: ReviewDocument
  types: RegistryTypeOption[]
  annotations: Annotation[]
  busy: boolean
  onBack: () => void
  onFieldCommit: (fieldId: string, value: string | null) => void
  onDecide: (decision: ReviewDecision, note?: string) => void
  onAssignType: (documentType: string | null) => void
  onCreateAnnotation: (page: number, bbox: BoundingBox, kind: 'highlight' | 'note') => void
  onUpdateAnnotation: (id: string, note: string) => void
  onDeleteAnnotation: (id: string) => void
  onExportAnnotated: () => void
}

type Tab = 'fields' | 'document'

export default function ReviewView({
  document,
  types,
  annotations,
  busy,
  onBack,
  onFieldCommit,
  onDecide,
  onAssignType,
  onCreateAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onExportAnnotated
}: Props) {
  const [note, setNote] = useState('')
  const [tab, setTab] = useState<Tab>('fields')
  const [focusedEvidence, setFocusedEvidence] = useState<string | null>(null)

  /** Da un'evidenza si salta al documento, sulla pagina e sulla riga da cui viene. */
  function openEvidence(evidenceId: string) {
    setFocusedEvidence(evidenceId)
    setTab('document')
  }

  const corrections = document.fields.filter(
    (field) => field.correctedValue !== undefined && field.correctedValue !== field.value
  ).length
  const decided = document.status !== 'NEEDS_REVIEW'

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
              <div className={styles.subtle}>
                {document.source} · sincronizzato il {formatDateTime(document.syncedAt)}
              </div>
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
                {document.typeConfidence !== null && ` · ${pct(document.typeConfidence)}`}
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

          <div className={styles.toolbar}>
            <span className={styles.muted}>Tipo documento</span>
            <select
              className={styles.select}
              value={document.documentType ?? ''}
              disabled={busy}
              onChange={(event) => onAssignType(event.target.value || null)}
            >
              <option value="">Da assegnare</option>
              {types.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.label} · {type.id}
                </option>
              ))}
            </select>
            <span className={styles.muted}>
              Cambiando tipo cambiano i campi richiesti alla prossima elaborazione.
            </span>
          </div>

          <div className={styles.tabs}>
            <button
              type="button"
              className={cx(styles.tab, tab === 'fields' && styles.tabActive)}
              onClick={() => setTab('fields')}
            >
              Dati estratti<span className={styles.tabCount}>{document.fields.length}</span>
            </button>
            <button
              type="button"
              className={cx(styles.tab, tab === 'document' && styles.tabActive)}
              onClick={() => setTab('document')}
            >
              Documento
              {annotations.length > 0 && (
                <span className={styles.tabCount}>
                  {annotations.length === 1 ? '1 annotazione' : `${annotations.length} annotazioni`}
                </span>
              )}
            </button>
          </div>

          {tab === 'document' && (
            <DocumentPreview
              document={document}
              evidence={document.evidence}
              annotations={annotations}
              focusedEvidenceId={focusedEvidence}
              busy={busy}
              onCreateAnnotation={onCreateAnnotation}
              onUpdateNote={onUpdateAnnotation}
              onDeleteAnnotation={onDeleteAnnotation}
              onExport={onExportAnnotated}
            />
          )}

          {tab === 'fields' && (
            <>
              <div className={styles.sectionHeader}>
                <div>
                  <h2>Dati estratti</h2>
                  <div className={styles.muted}>
                    Modifica un valore per registrarlo come correzione: il precompilato resta
                    visibile.
                  </div>
                </div>
                {corrections > 0 && (
                  <span className={cx(styles.badge, styles.medium)}>
                    {corrections === 1 ? '1 correzione' : `${corrections} correzioni`}
                  </span>
                )}
              </div>

              {document.fields.length === 0 ? (
                <div className={styles.empty}>
                  <div className={styles.emptyTitle}>Nessun campo da compilare</div>
                  <div>La precompilazione non è ancora stata eseguita su questo documento.</div>
                </div>
              ) : (
                <div className={styles.fieldList}>
                  {document.fields.map((field) => (
                    <FieldEditor
                      key={field.id}
                      field={field}
                      disabled={busy}
                      onCommit={(value) => onFieldCommit(field.id, value)}
                      onFocusEvidence={openEvidence}
                    />
                  ))}
                </div>
              )}

              <div className={styles.sectionHeader}>
                <div>
                  <h2>Decisione</h2>
                  <div className={styles.muted}>
                    La nota viene registrata nella timeline insieme alla decisione.
                  </div>
                </div>
              </div>
              <textarea
                className={styles.textarea}
                placeholder="Nota per la revisione (facoltativa)"
                value={note}
                disabled={busy}
                onChange={(event) => setNote(event.target.value)}
              />

              <div className={styles.actions}>
                <button
                  type="button"
                  className={cx(styles.button, styles.buttonPrimary)}
                  disabled={busy || corrections > 0}
                  title={
                    corrections > 0
                      ? 'Ci sono correzioni: usa «Conferma con correzione».'
                      : undefined
                  }
                  onClick={() => onDecide('APPROVE', note || undefined)}
                >
                  Approva
                </button>
                <button
                  type="button"
                  className={styles.button}
                  disabled={busy || corrections === 0}
                  title={corrections === 0 ? 'Modifica almeno un campo per correggere.' : undefined}
                  onClick={() => onDecide('CORRECT', note || undefined)}
                >
                  Conferma con correzione
                </button>
                <button
                  type="button"
                  className={cx(styles.button, styles.buttonDanger)}
                  disabled={busy}
                  onClick={() => onDecide('REJECT', note || undefined)}
                >
                  Rifiuta
                </button>
                {decided && (
                  <span className={cx(styles.badge, styles.status)}>
                    {document.status === 'APPROVED' ? 'Già approvato' : 'Già rifiutato'}
                  </span>
                )}
              </div>
            </>
          )}
        </section>

        <div style={{ display: 'grid', gap: 16 }}>
          <section className={cx(styles.card, styles.panel)}>
            <div className={styles.panelTitle}>
              <h3>Evidenze</h3>
              <span className={cx(styles.badge, styles.status)}>
                {document.evidence.length} prove
              </span>
            </div>
            {document.evidence.length === 0 ? (
              <div className={styles.muted}>Nessuna evidenza registrata.</div>
            ) : (
              document.evidence.map((evidence) => (
                <button
                  type="button"
                  key={evidence.id}
                  className={cx(
                    styles.evidenceButton,
                    focusedEvidence === evidence.id && styles.evidenceActive
                  )}
                  onClick={() => openEvidence(evidence.id)}
                >
                  <div className={styles.evidenceTop}>
                    <span>
                      {evidence.label} · pag. {evidence.page}
                    </span>
                    <strong>{pct(evidence.confidence)}</strong>
                  </div>
                  <div className={styles.evidenceText}>{evidence.text}</div>
                </button>
              ))
            )}
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
