import type { RegistryTypeOption, ReviewAction, ReviewDocument } from '@shared/types'
import { useMemo, useState } from 'react'
import { cx } from '../lib/cx'
import { formatDateTime, pct, STATUS_LABELS, textSourceLabel } from '../lib/format'
import DocumentPreview from './document-preview'
import styles from './document-review.module.css'
import { BAND_CLASS } from './document-table'
import FieldEditor from './field-editor'
import SearchableSelect from './searchable-select'

interface Props {
  document: ReviewDocument
  types: RegistryTypeOption[]
  busy: boolean
  onBack: () => void
  onFieldCommit: (fieldId: string, value: string | null) => void
  onDecide: (action: ReviewAction, note?: string) => void
  onAssignType: (documentType: string | null) => void
  /** Toglie la copia locale del file, lasciando i dati estratti. */
  onEvict: () => void
}

type Tab = 'fields' | 'history' | 'evidence'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'fields', label: 'Dati' },
  { id: 'history', label: 'History' },
  { id: 'evidence', label: 'Evidenze' }
]

/**
 * Vista di revisione: il documento sta sempre sotto gli occhi, a destra, e tutto il
 * resto — tipo, campi, storia ed evidenze — vive nella colonna di sinistra divisa in
 * schede. Prima documento e campi erano due tab che si escludevano a vicenda: per
 * controllare un valore bisognava perdere di vista la pagina da cui era stato letto.
 */
export default function ReviewView({
  document,
  types,
  busy,
  onBack,
  onFieldCommit,
  onDecide,
  onAssignType,
  onEvict
}: Props) {
  const [note, setNote] = useState('')
  const [tab, setTab] = useState<Tab>('fields')
  const [focusedEvidence, setFocusedEvidence] = useState<string | null>(null)
  /**
   * Campo che riceve il testo preso dal documento. Resta attivo anche quando
   * l'input perde il fuoco: selezionare sul documento lo fa perdere per forza.
   */
  const [activeField, setActiveField] = useState<string | null>(null)

  /** Da un'evidenza si salta alla pagina del documento da cui viene. */
  function openEvidence(evidenceId: string) {
    setFocusedEvidence(evidenceId)
    setTab('evidence')
  }

  const typeOptions = useMemo(
    () => types.map((type) => ({ id: type.id, label: type.label, hint: type.id })),
    [types]
  )

  const active = document.fields.find((field) => field.id === activeField) ?? null

  /** Quello che il revisore ha selezionato sul documento finisce nel campo attivo. */
  function capture(text: string) {
    if (!active) return
    const value = text.replace(/\s+/g, ' ').trim()
    if (value) onFieldCommit(active.id, value)
  }

  const corrections = document.fields.filter(
    (field) => field.correctedValue !== undefined && field.correctedValue !== field.value
  ).length
  const decided = document.status !== 'NEEDS_REVIEW'

  return (
    <div className={styles.reviewShell}>
      <header className={styles.reviewHeader}>
        <button type="button" className={styles.back} onClick={onBack}>
          ← Indietro
        </button>
        <div className={styles.reviewTitle}>
          <h2>{document.filename}</h2>
          <div className={styles.subtle}>
            {document.source} · sincronizzato il {formatDateTime(document.syncedAt)} ·{' '}
            {textSourceLabel(document.textSource)}
          </div>
        </div>
        <span className={styles.spacer} />
        <span className={cx(styles.badge, styles.status)}>{STATUS_LABELS[document.status]}</span>
        <span className={cx(styles.badge, BAND_CLASS[document.confidenceBand])}>
          {pct(document.confidence)}
        </span>
        {document.cachedPath && (
          <button
            type="button"
            className={cx(styles.button, styles.buttonSmall)}
            disabled={busy}
            onClick={onEvict}
            title="Elimina il file dalla cache locale. I dati estratti restano, il file si riscarica riaprendolo da Drive."
          >
            Libera spazio
          </button>
        )}
      </header>

      <div className={styles.reviewBody}>
        <aside className={cx(styles.card, styles.reviewSidebar)}>
          <div className={styles.tabs}>
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={cx(styles.tab, tab === entry.id && styles.tabActive)}
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
                {entry.id === 'fields' && document.fields.length > 0 && (
                  <span className={styles.tabCount}>{document.fields.length}</span>
                )}
                {entry.id === 'evidence' && document.evidence.length > 0 && (
                  <span className={styles.tabCount}>{document.evidence.length}</span>
                )}
              </button>
            ))}
          </div>

          <div className={styles.tabPanel}>
            {tab === 'fields' && (
              <>
                {document.warnings.map((warning) => (
                  <div className={styles.warning} key={warning}>
                    {warning}
                  </div>
                ))}

                <div className={styles.panelSection}>
                  <div className={styles.panelLabel}>Tipo documento</div>
                  <SearchableSelect
                    value={document.documentType}
                    options={typeOptions}
                    emptyLabel="Da assegnare"
                    searchPlaceholder="Cerca un tipo del registry…"
                    disabled={busy}
                    onChange={onAssignType}
                  />
                  <div className={styles.muted}>
                    {document.typeConfidence !== null
                      ? `Classificato dal registry al ${pct(document.typeConfidence)}. `
                      : ''}
                    Cambiando tipo cambiano i campi richiesti alla prossima elaborazione.
                  </div>
                </div>

                <div className={styles.panelSection}>
                  <div className={styles.panelLabel}>
                    Dati estratti
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
                          active={field.id === activeField}
                          onActivate={() => setActiveField(field.id)}
                          onCommit={(value) => onFieldCommit(field.id, value)}
                          onFocusEvidence={openEvidence}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            {tab === 'history' && (
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
            )}

            {tab === 'evidence' &&
              (document.evidence.length === 0 ? (
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
                    onClick={() => setFocusedEvidence(evidence.id)}
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
              ))}
          </div>

          <div className={styles.reviewDecision}>
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
                disabled={busy}
                title="Chiude il documento come revisionato: tipo e campi restano a database ed entrano nel dataset."
                onClick={() => onDecide('SAVE', note || undefined)}
              >
                Salva
              </button>
              <button
                type="button"
                className={cx(styles.button, styles.buttonDanger)}
                disabled={busy}
                title="Tiene il documento fuori dal dataset dei test futuri. I dati estratti restano, non vengono usati."
                onClick={() => onDecide('DISCARD', note || undefined)}
              >
                Scarta
              </button>
              {decided && (
                <span className={cx(styles.badge, styles.status)}>
                  {document.status === 'REVIEWED' ? 'Già revisionato' : 'Già scartato'}
                </span>
              )}
            </div>
          </div>
        </aside>

        <section className={cx(styles.card, styles.reviewDocument)}>
          <DocumentPreview
            document={document}
            evidence={document.evidence}
            focusedEvidenceId={focusedEvidence}
            captureTarget={active?.label ?? null}
            onCapture={capture}
          />
        </section>
      </div>
    </div>
  )
}
