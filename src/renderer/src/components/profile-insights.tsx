import type { ProfileEdit } from '@shared/profile-edit'
import { PROFILE_ORIGIN_LABELS, type ProfileTotals } from '@shared/profile-metrics'
import {
  describeRerun,
  describeStore,
  type ProfileWorkspace,
  type TypeRerunResult
} from '@shared/profile-workspace'
import { useState } from 'react'
import { cx } from '../lib/cx'
import { formatDateTime, pct } from '../lib/format'
import styles from './document-review.module.css'
import { TableSkeleton } from './loading-skeleton'
import ProfileFields, { type FieldAction } from './profile-fields'

/**
 * «Mappa tipi ↔ dati»: da che parte la precompilazione aiuta e da che parte no.
 *
 * Si sceglie un tipo documento e si vede cosa la mappa chiede accanto ai numeri delle
 * annotazioni già fatte, con l'elenco dei documenti che li alimentano. Da qui si
 * corregge, e il pulsante di rielaborazione dice, in numeri, se la correzione è servita.
 * Ogni correzione resta nel database di questa installazione e si annulla dalla
 * cronologia: i file per pratica-ai escono solo dall'export.
 *
 * Niente gergo: «confermati dal motore», «corretti», «scritti a mano». Chi legge non ha
 * scritto il codice e non deve sapere cosa sia un profilo v2.
 */

interface Props {
  workspace: ProfileWorkspace | null
  loading: boolean
  busy: boolean
  selected: string | null
  /** L'ultimo re-run, mostrato come prima/dopo sotto il tipo a cui appartiene. */
  rerun: TypeRerunResult | null
  onSelect: (documentType: string) => void
  onEdit: (edit: ProfileEdit) => void
  onRerun: (documentType: string) => void
  onExport: (format: 'json' | 'csv') => void
  onOpenDocument: (documentId: string) => void
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`
}

export default function ProfileInsights({
  workspace,
  loading,
  busy,
  selected,
  rerun,
  onSelect,
  onEdit,
  onRerun,
  onExport,
  onOpenDocument
}: Props) {
  /** Una correzione su un profilo verificato aspetta un sì esplicito. */
  const [pendingAction, setPendingAction] = useState<FieldAction | null>(null)

  if (loading && !workspace) {
    return <TableSkeleton label="Calcolo le misure sulle annotazioni…" />
  }

  const types = workspace?.types ?? []
  const measure = types.find((type) => type.documentType === selected) ?? types[0] ?? null

  if (types.length === 0) {
    return (
      <div className={cx(styles.card, styles.empty)}>
        <div className={styles.emptyTitle}>Nessuna misura ancora</div>
        <div>
          I numeri arrivano dai documenti salvati con un tipo assegnato. Revisiona qualche documento
          e torna qui: gli scartati non contano.
        </div>
      </div>
    )
  }

  function requestEdit(action: FieldAction) {
    // I profili costruiti su documenti reali sono la cornice del lavoro: correggerli si
    // può, ma non per sbaglio.
    if (measure?.fieldTested) setPendingAction(action)
    else onEdit(action.edit)
  }

  return (
    <div className={styles.profileShell}>
      <aside className={cx(styles.card, styles.profileList)}>
        <div className={styles.panelLabel}>Tipi con documenti annotati</div>
        {types.map((type) => (
          <button
            key={type.documentType}
            type="button"
            data-type={type.documentType}
            className={cx(
              styles.profileType,
              type.documentType === measure?.documentType && styles.profileTypeActive
            )}
            onClick={() => onSelect(type.documentType)}
          >
            <div className={styles.profileTypeHead}>
              <span className={styles.fileName}>{type.label ?? type.documentType}</span>
              <span className={styles.badge}>
                {plural(type.totals.documents, 'documento', 'documenti')}
              </span>
            </div>
            <div className={styles.subtle}>{type.documentType}</div>
            <RateBar totals={type.totals} />
          </button>
        ))}
      </aside>

      <section className={cx(styles.card, styles.profileDetail)}>
        {measure && (
          <>
            <div className={styles.sectionHeader}>
              <div>
                <h2>{measure.label ?? measure.documentType}</h2>
                <div className={styles.subtle}>{measure.documentType}</div>
              </div>
              <span className={styles.spacer} />
              {measure.fieldTested ? (
                <span
                  className={cx(styles.badge, styles.high)}
                  title="Il profilo è stato costruito su documenti reali: una modifica chiede conferma."
                >
                  Verificato su documenti reali
                </span>
              ) : (
                <span className={cx(styles.badge, styles.low)} title={measure.schemaState ?? ''}>
                  {measure.profileOrigin === 'LEGACY_FALLBACK'
                    ? 'Senza profilo esplicito'
                    : 'Schema proposto, mai verificato'}
                </span>
              )}
            </div>

            <div className={styles.muted}>
              {PROFILE_ORIGIN_LABELS[measure.profileOrigin]}
              {measure.profileOrigin === 'LEGACY_FALLBACK' &&
                ' — si corregge come gli altri, ma resta marcato: non è uno schema verificato.'}
            </div>

            <Totals totals={measure.totals} />

            <div className={styles.actions}>
              <button
                type="button"
                className={cx(styles.button, styles.buttonPrimary)}
                disabled={busy}
                title="Rilancia la precompilazione sui documenti già annotati di questo tipo, usando le copie in cache. Nessun file viene riscaricato e le correzioni del revisore restano."
                onClick={() => onRerun(measure.documentType)}
              >
                Rielabora i {plural(measure.totals.documents, 'documento', 'documenti')}
              </button>
              <span className={styles.spacer} />
              <button
                type="button"
                className={cx(styles.button, styles.buttonSmall)}
                disabled={busy}
                onClick={() => onExport('json')}
              >
                Report JSON
              </button>
              <button
                type="button"
                className={cx(styles.button, styles.buttonSmall)}
                disabled={busy}
                onClick={() => onExport('csv')}
              >
                Report CSV
              </button>
            </div>

            {workspace && (
              <div className={styles.muted}>{describeStore(workspace.standingEdits)}</div>
            )}

            {pendingAction && (
              <ConfirmEdit
                action={pendingAction}
                busy={busy}
                onConfirm={() => {
                  setPendingAction(null)
                  onEdit(pendingAction.edit)
                }}
                onCancel={() => setPendingAction(null)}
              />
            )}

            {rerun && rerun.documentType === measure.documentType && <RerunDelta rerun={rerun} />}

            <ProfileFields
              measure={measure}
              ontology={workspace?.ontology ?? []}
              disabled={busy}
              onEdit={requestEdit}
            />

            <div className={styles.panelLabel}>
              Documenti che alimentano questi numeri
              <span className={styles.muted}>{measure.documents.length}</span>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Documento</th>
                    <th>Revisionato il</th>
                    <th>Confermati</th>
                    <th>Corretti</th>
                    <th>A mano</th>
                  </tr>
                </thead>
                <tbody>
                  {measure.documents.map((document) => (
                    <tr
                      key={document.documentId}
                      data-document={document.documentId}
                      onDoubleClick={() => onOpenDocument(document.documentId)}
                    >
                      <td className={styles.fileName}>{document.filename}</td>
                      <td>{formatDateTime(document.reviewedAt)}</td>
                      <td>{document.confirmed}</td>
                      <td>{document.corrected}</td>
                      <td>{document.manual}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  )
}

/**
 * La conferma esplicita per i 15 profili costruiti su documenti reali. Non è un
 * ostacolo burocratico: quei profili sono la cornice su cui si misura tutto il resto, e
 * cambiarli per sbaglio sposta il metro.
 */
export function ConfirmEdit({
  action,
  busy,
  onConfirm,
  onCancel
}: {
  action: FieldAction
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className={styles.warning} data-confirm="true">
      <div>
        Questo profilo è stato costruito su documenti reali. Confermi di {action.description}?
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={cx(styles.button, styles.buttonPrimary, styles.buttonSmall)}
          disabled={busy}
          onClick={onConfirm}
        >
          Sì, correggi il profilo
        </button>
        <button type="button" className={cx(styles.button, styles.buttonSmall)} onClick={onCancel}>
          Annulla
        </button>
      </div>
    </div>
  )
}

/** Le tre quote in una riga sola, larghe quanto valgono. */
function RateBar({ totals }: { totals: ProfileTotals }) {
  if (totals.outcomes === 0) {
    return <div className={styles.subtle}>Nessun campo con un valore.</div>
  }
  return (
    <div className={styles.rateBar} title="Confermati dal motore, corretti, scritti a mano">
      <span className={styles.rateConfirmed} style={{ flexGrow: totals.confirmed }} />
      <span className={styles.rateCorrected} style={{ flexGrow: totals.corrected }} />
      <span className={styles.rateManual} style={{ flexGrow: totals.manual }} />
    </div>
  )
}

function Totals({ totals }: { totals: ProfileTotals }) {
  if (totals.outcomes === 0) {
    return (
      <div className={styles.muted}>
        Su {plural(totals.documents, 'documento annotato', 'documenti annotati')} nessun campo ha un
        valore: il profilo di questo tipo non sta precompilando niente.
      </div>
    )
  }
  return (
    <div className={styles.profileTotals} data-outcomes={totals.outcomes}>
      <div>
        Su <strong>{totals.outcomes}</strong> valori raccolti in{' '}
        {plural(totals.documents, 'documento', 'documenti')}:
      </div>
      <div className={styles.profileTotal}>
        <strong>{pct(totals.confirmedRate)}</strong> arrivati dal motore e confermati
      </div>
      <div className={styles.profileTotal}>
        <strong>{pct(totals.correctedRate)}</strong> proposti e corretti
      </div>
      <div className={styles.profileTotal}>
        <strong>{pct(totals.manualRate)}</strong> scritti a mano dal revisore
      </div>
    </div>
  )
}

/** Il prima/dopo: la prova che la correzione ha funzionato, o che non è servita. */
function RerunDelta({ rerun }: { rerun: TypeRerunResult }) {
  const { delta } = rerun
  return (
    <div className={cx(styles.card, styles.deltaPanel)} data-delta={rerun.documentType}>
      <div className={styles.panelLabel}>Prima e dopo la rielaborazione</div>
      <div className={styles.muted}>{describeRerun(rerun)}</div>
      <div className={styles.profileTotals}>
        <div className={styles.profileTotal}>
          Scritti a mano: <strong>{pct(delta.before.manualRate)}</strong> →{' '}
          <strong>{pct(delta.after.manualRate)}</strong>
        </div>
        <div className={styles.profileTotal}>
          Confermati dal motore: <strong>{pct(delta.before.confirmedRate)}</strong> →{' '}
          <strong>{pct(delta.after.confirmedRate)}</strong>
        </div>
      </div>

      {delta.fields.length > 0 && (
        <ul className={styles.deltaList}>
          {delta.fields.map((field) => (
            <li key={field.fieldId} data-field={field.fieldId}>
              <span className={styles.fileName}>{field.label}</span> — a mano{' '}
              {pct(field.before?.manualRate ?? 0)} → {pct(field.after?.manualRate ?? 0)}
              {field.before === null && ' (campo nuovo)'}
              {field.after === null && ' (campo tolto dal profilo)'}
            </li>
          ))}
        </ul>
      )}

      {rerun.skipped.length > 0 && (
        <ul className={styles.deltaList}>
          {rerun.skipped.map((document) => (
            <li key={document.documentId}>
              {document.filename}: {document.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
