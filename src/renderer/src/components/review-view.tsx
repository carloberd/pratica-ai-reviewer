import type { ReviewDocument } from '@shared/types'
import { cx } from '../lib/cx'
import { formatDateTime, pct, textSourceLabel, typeLabel } from '../lib/format'
import styles from './document-review.module.css'
import { BAND_CLASS } from './document-table'

interface Props {
  document: ReviewDocument
  onBack: () => void
}

export default function ReviewView({ document, onBack }: Props) {
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

          <div className={styles.sectionHeader}>
            <div>
              <h2>Dati estratti</h2>
              <div className={styles.muted}>Ogni dato è collegato alla propria evidenza</div>
            </div>
          </div>

          {document.fields.length === 0 ? (
            <div className={styles.empty}>
              <div className={styles.emptyTitle}>Nessun campo da compilare</div>
              <div>La precompilazione non è ancora stata eseguita su questo documento.</div>
            </div>
          ) : (
            <div className={styles.fieldList}>
              {document.fields.map((field) => {
                const shown = field.correctedValue ?? field.value
                return (
                  <div className={styles.fieldRow} key={field.id}>
                    <div className={styles.fieldLabel}>{field.label}</div>
                    <div className={shown ? styles.fieldValue : styles.fieldEmpty}>
                      {shown || 'Nessuna evidenza'}
                    </div>
                    <div className={styles.confidence}>
                      {field.value ? pct(field.confidence) : '—'}
                    </div>
                  </div>
                )
              })}
            </div>
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
                <div className={styles.evidence} key={evidence.id}>
                  <div className={styles.evidenceTop}>
                    <span>
                      {evidence.label} · pag. {evidence.page}
                    </span>
                    <strong>{pct(evidence.confidence)}</strong>
                  </div>
                  <div className={styles.evidenceText}>{evidence.text}</div>
                </div>
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
