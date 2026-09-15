import type { Annotation } from '@shared/types'
import { useState } from 'react'
import { cx } from '../lib/cx'
import { formatDateTime } from '../lib/format'
import styles from './document-review.module.css'
import type { DrawMode } from './pdf-viewer'

interface Props {
  annotations: Annotation[]
  mode: DrawMode
  busy: boolean
  selectedId: string | null
  onModeChange: (mode: DrawMode) => void
  onSelect: (id: string | null) => void
  onUpdateNote: (id: string, note: string) => void
  onDelete: (id: string) => void
  onExport: () => void
}

/**
 * D3: le annotazioni stanno in SQLite, non nel PDF. Il file in cache resta identico
 * a quello su Drive, e una rielaborazione del documento non le tocca.
 */
export default function AnnotationsPanel({
  annotations,
  mode,
  busy,
  selectedId,
  onModeChange,
  onSelect,
  onUpdateNote,
  onDelete,
  onExport
}: Props) {
  const [draft, setDraft] = useState('')
  const editing = annotations.find((annotation) => annotation.id === selectedId) ?? null

  return (
    <>
      <div className={styles.toolbar}>
        <span className={styles.muted}>Annota</span>
        <button
          type="button"
          className={cx(
            styles.button,
            styles.buttonSmall,
            mode === 'highlight' && styles.buttonPrimary
          )}
          disabled={busy}
          onClick={() => onModeChange(mode === 'highlight' ? 'none' : 'highlight')}
        >
          Evidenzia
        </button>
        <button
          type="button"
          className={cx(styles.button, styles.buttonSmall, mode === 'note' && styles.buttonPrimary)}
          disabled={busy}
          onClick={() => onModeChange(mode === 'note' ? 'none' : 'note')}
        >
          Nota
        </button>
        <span className={styles.muted}>
          {mode === 'none'
            ? 'Scegli uno strumento e trascina sul documento.'
            : 'Trascina sul documento per creare l’annotazione.'}
        </span>
        <span className={styles.spacer} />
        <button
          type="button"
          className={cx(styles.button, styles.buttonSmall)}
          disabled={busy}
          onClick={onExport}
          title="Salva una copia del PDF con le annotazioni sopra. L'originale resta intatto."
        >
          Esporta PDF annotato
        </button>
      </div>

      {editing && (
        <div className={cx(styles.card, styles.panel)} style={{ marginBottom: 12 }}>
          <div className={styles.panelTitle}>
            <h3>
              {editing.kind === 'note' ? 'Nota' : 'Evidenziazione'} · pag. {editing.page}
            </h3>
            <button type="button" className={styles.iconButton} onClick={() => onSelect(null)}>
              chiudi
            </button>
          </div>
          <textarea
            className={styles.textarea}
            placeholder="Scrivi la nota…"
            value={draft || (editing.note ?? '')}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className={styles.actions}>
            <button
              type="button"
              className={cx(styles.button, styles.buttonPrimary, styles.buttonSmall)}
              disabled={busy}
              onClick={() => {
                onUpdateNote(editing.id, draft || (editing.note ?? ''))
                setDraft('')
              }}
            >
              Salva nota
            </button>
            <button
              type="button"
              className={cx(styles.button, styles.buttonDanger, styles.buttonSmall)}
              disabled={busy}
              onClick={() => {
                onDelete(editing.id)
                setDraft('')
              }}
            >
              Elimina
            </button>
          </div>
        </div>
      )}

      {annotations.length === 0 ? (
        <div className={styles.muted}>Nessuna annotazione su questo documento.</div>
      ) : (
        annotations.map((annotation) => (
          <div className={styles.annotationRow} key={annotation.id}>
            <div>
              <div className={styles.annotationNote}>
                {annotation.note ||
                  (annotation.kind === 'note' ? 'Nota senza testo' : 'Evidenziazione')}
              </div>
              <div className={styles.annotationMeta}>
                pag. {annotation.page} · {formatDateTime(annotation.updatedAt)}
              </div>
            </div>
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => onSelect(annotation.id)}
            >
              apri
            </button>
          </div>
        ))
      )}
    </>
  )
}
