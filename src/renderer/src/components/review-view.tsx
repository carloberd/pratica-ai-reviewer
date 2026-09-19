import {
  type CompanyIdentity,
  type DirectionChoice,
  EMPTY_COMPANY
} from '@shared/document-direction'
import { type EvidenceTarget, targetOfEvidence } from '@shared/evidence-locate'
import { documentCorrections } from '@shared/field-edits'
import { pickValue } from '@shared/pick-locate'
import type { ProfileEdit } from '@shared/profile-edit'
import type { TypeFieldMap } from '@shared/profile-workspace'
import type { DocumentPick, RegistryTypeOption, ReviewAction, ReviewDocument } from '@shared/types'
import { useEffect, useMemo, useState } from 'react'
import { cx } from '../lib/cx'
import { formatDateTime, pct, STATUS_LABELS, textSourceLabel } from '../lib/format'
import DirectionPanel from './direction-panel'
import DocumentPreview from './document-preview'
import styles from './document-review.module.css'
import { BAND_CLASS } from './document-table'
import ExtractionFields from './extraction-fields'
import FieldsPanel, { type ActiveTarget } from './fields-panel'
import type { EvidenceFocus } from './pdf-viewer'
import SearchableSelect from './searchable-select'
import TypeCandidates from './type-candidates'

interface Props {
  document: ReviewDocument
  types: RegistryTypeOption[]
  busy: boolean
  onBack: () => void
  /** `pick` quando il valore è stato preso dal documento. */
  onFieldCommit: (fieldId: string, value: string | null, pick?: DocumentPick) => void
  onItemCommit: (itemId: string, value: string | null, pick?: DocumentPick) => void
  onItemRemove: (itemId: string, removed: boolean) => void
  onItemAdd: (fieldId: string, value: string, pick?: DocumentPick) => void
  onDecide: (action: ReviewAction, note?: string) => void
  onAssignType: (documentType: string | null) => void
  /** L'azienda di cui sono i documenti: con lei si decide emesso o ricevuto. */
  company: CompanyIdentity | null
  onChooseDirection: (choice: DirectionChoice | null) => void
  /** Toglie la copia locale del file, lasciando i dati estratti. */
  onEvict: () => void
  /** La mappa del tipo del documento, per la scheda «Campi da estrarre». */
  fieldMap: TypeFieldMap | null
  onLoadFieldMap: () => void
  onMapEdit: (edit: ProfileEdit) => void
  onMapRevert: (actionId: string) => void
}

type Tab = 'fields' | 'map' | 'history' | 'evidence'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'fields', label: 'Dati' },
  { id: 'map', label: 'Campi da estrarre' },
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
  onItemCommit,
  onItemRemove,
  onItemAdd,
  onDecide,
  onAssignType,
  company,
  onChooseDirection,
  onEvict,
  fieldMap,
  onLoadFieldMap,
  onMapEdit,
  onMapRevert
}: Props) {
  const [note, setNote] = useState('')
  const [tab, setTab] = useState<Tab>('fields')
  const [focus, setFocus] = useState<EvidenceFocus | null>(null)
  /**
   * Campo (o riga) che riceve il testo preso dal documento. Resta attivo anche quando
   * l'input perde il fuoco: selezionare sul documento lo fa perdere per forza.
   */
  const [active, setActive] = useState<ActiveTarget | null>(null)

  // La mappa si rilegge ogni volta che si apre la scheda, e quando cambia il tipo: i numeri
  // dipendono dai documenti salvati nel frattempo, i campi dal tipo.
  // biome-ignore lint/correctness/useExhaustiveDependencies: si rilegge solo su scheda, documento e tipo
  useEffect(() => {
    if (tab === 'map' && document.documentType) onLoadFieldMap()
  }, [tab, document.id, document.documentType])

  /** Da un'evidenza si va al punto del documento da cui viene, restando nella scheda. */
  function focusEvidence(target: EvidenceTarget) {
    setFocus((current) => ({ target, seq: (current?.seq ?? 0) + 1 }))
  }

  const typeOptions = useMemo(
    () => types.map((type) => ({ id: type.id, label: type.label, hint: type.id })),
    [types]
  )

  const activeField = active
    ? (document.fields.find((field) => field.id === active.fieldId) ?? null)
    : null
  const activeItem =
    active?.kind === 'item'
      ? (activeField?.items.find((item) => item.id === active.itemId) ?? null)
      : null
  const captureTarget = !activeField
    ? null
    : active?.kind === 'new-item'
      ? `${activeField.label} · nuova riga`
      : activeItem
        ? `${activeField.label} · riga ${activeItem.index + 1}`
        : active?.kind === 'field'
          ? activeField.label
          : null

  /**
   * Quello che il revisore ha selezionato sul documento finisce nel campo attivo; con la
   * riga nuova attiva, ogni selezione aggiunge una riga. Il punto da cui viene va col
   * valore: è da lì che il motore imparerà dove cercarlo.
   */
  function capture(text: string, pick?: DocumentPick) {
    if (!active || !captureTarget) return
    const value = pickValue(text)
    if (!value) return
    if (active.kind === 'field') onFieldCommit(active.fieldId, value, pick)
    else if (active.kind === 'item') onItemCommit(active.itemId, value, pick)
    else onItemAdd(active.fieldId, value, pick)
  }

  const corrections = documentCorrections(document.fields).length
  const decided = document.status !== 'NEEDS_REVIEW'
  const shownEvidenceId = focus?.target.evidenceId ?? null

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
                      : document.documentType
                        ? 'Scelto dal revisore. '
                        : ''}
                    Cambiando tipo il documento si rielabora coi campi del nuovo tipo; le correzioni
                    fatte restano.
                  </div>
                  <TypeCandidates
                    document={document}
                    disabled={busy}
                    onAssign={onAssignType}
                    onFocusEvidence={focusEvidence}
                  />
                </div>

                <DirectionPanel
                  document={document}
                  company={company ?? EMPTY_COMPANY}
                  busy={busy}
                  onChoose={onChooseDirection}
                />

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
                      <div>
                        {document.documentType
                          ? 'Il profilo di questo tipo non chiede campi, o il documento non è ancora stato elaborato.'
                          : 'Senza tipo non c’è un profilo di campi: assegna il tipo e il documento si precompila.'}
                      </div>
                    </div>
                  ) : (
                    <FieldsPanel
                      fields={document.fields}
                      evidence={document.evidence}
                      disabled={busy}
                      active={active}
                      shownEvidenceId={shownEvidenceId}
                      onActivate={setActive}
                      onFieldCommit={onFieldCommit}
                      onItemCommit={onItemCommit}
                      onItemRemove={onItemRemove}
                      onItemAdd={onItemAdd}
                      onFocusEvidence={focusEvidence}
                    />
                  )}
                </div>
              </>
            )}

            {tab === 'map' && (
              <ExtractionFields
                documentType={document.documentType}
                map={fieldMap}
                busy={busy}
                onEdit={onMapEdit}
                onRevert={onMapRevert}
                onShowData={() => setTab('fields')}
              />
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
                      shownEvidenceId === evidence.id && styles.evidenceActive
                    )}
                    onClick={() => focusEvidence(targetOfEvidence(evidence))}
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
            focus={focus}
            captureTarget={captureTarget}
            onCapture={capture}
          />
        </section>
      </div>
    </div>
  )
}
