import type { Cardinality, FieldRole } from '@shared/extraction-v2'
import type { ProfileEdit } from '@shared/profile-edit'
import {
  FIELD_ROLE_LABELS,
  type ProfileFieldMeasure,
  type ProfileTypeMeasure
} from '@shared/profile-metrics'
import { CARDINALITY_LABELS, ROLES } from '@shared/profile-overlay'
import type { TypeFieldMap } from '@shared/profile-workspace'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cx } from '../lib/cx'
import { formatDateTime } from '../lib/format'
import styles from './document-review.module.css'
import SearchableSelect from './searchable-select'

/**
 * Scheda «Campi da estrarre»: la mappa del tipo del documento aperto, corretta senza
 * lasciare la revisione.
 *
 * Il revisore sta compilando i dati, si accorge che il motore chiede un campo che questo
 * tipo non ha o non chiede uno che serve, e lo sistema qui. Il documento si rielabora con
 * la mappa nuova e la scheda «Dati» mostra già i campi giusti, con le correzioni fatte.
 *
 * La colonna è stretta: ogni campo è una scheda con nome, peso, numero di valori e azioni
 * impilati, e i numeri dei documenti già revisionati stanno in una riga sola sotto il nome.
 */

interface Props {
  documentType: string | null
  /** `null` finché la mappa del tipo non è arrivata. */
  map: TypeFieldMap | null
  busy: boolean
  onEdit: (edit: ProfileEdit) => void
  onRevert: (actionId: string) => void
  onShowData: () => void
}

/** Una correzione in attesa di conferma, legata al punto della scheda da cui è partita. */
interface PendingEdit {
  key: string
  edit: ProfileEdit
  /** Cosa sta per succedere, in una frase: è quella della richiesta di conferma. */
  description: string
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`
}

export default function ExtractionFields({
  documentType,
  map,
  busy,
  onEdit,
  onRevert,
  onShowData
}: Props) {
  const [pending, setPending] = useState<PendingEdit | null>(null)

  // Una conferma lasciata a metà non deve sopravvivere al cambio di tipo.
  // biome-ignore lint/correctness/useExhaustiveDependencies: si azzera quando cambia il tipo
  useEffect(() => {
    setPending(null)
  }, [documentType])

  if (!documentType) {
    return (
      <div className={styles.empty} data-map="no-type">
        <div className={styles.emptyTitle}>Nessun tipo assegnato</div>
        <div>I campi da estrarre dipendono dal tipo del documento: assegnalo in «Dati».</div>
        <button
          type="button"
          className={cx(styles.button, styles.buttonSmall, styles.mapEmptyAction)}
          onClick={onShowData}
        >
          Vai a Dati
        </button>
      </div>
    )
  }

  if (!map || map.documentType !== documentType) {
    return <div className={styles.spinner}>Leggo i campi da estrarre…</div>
  }

  const { measure } = map

  if (!map.editable) {
    return (
      <div className={styles.empty} data-map="no-profile">
        <div className={styles.emptyTitle}>Nessuna mappa per questo tipo</div>
        <div>
          Il registry non dice quali campi vuole «{documentType}»: non c&apos;è una mappa da
          correggere.
        </div>
      </div>
    )
  }

  /** I profili costruiti su documenti reali si correggono, ma non per sbaglio. */
  function request(key: string, edit: ProfileEdit, description: string) {
    if (measure.fieldTested) setPending({ key, edit, description })
    else onEdit(edit)
  }

  const confirmFor = (key: string) =>
    pending?.key === key ? (
      <ConfirmEdit
        description={pending.description}
        busy={busy}
        onConfirm={() => {
          setPending(null)
          onEdit(pending.edit)
        }}
        onCancel={() => setPending(null)}
      />
    ) : null

  const inProfile = measure.fields.filter((field) => field.inProfile)
  const candidates = measure.fields.filter(
    (field) => !field.inProfile && field.signal === 'MISSING_FROM_PROFILE'
  )
  const excluded = measure.fields.filter((field) => field.decision === 'excluded')
  const reviewed = measure.totals.documents

  return (
    <div className={styles.mapPanel} data-map={documentType}>
      <section className={styles.mapIntro}>
        <div className={styles.mapIntroHead}>
          <div className={styles.mapIntroName}>
            <span className={styles.mapTypeLabel}>{measure.label ?? documentType}</span>
            <span className={styles.mapFieldId}>{documentType}</span>
          </div>
          {measure.fieldTested ? (
            <span
              className={cx(styles.badge, styles.high)}
              title="Il profilo è stato costruito su documenti reali: una modifica chiede conferma."
            >
              Verificato
            </span>
          ) : (
            <span className={cx(styles.badge, styles.low)} title={measure.schemaState ?? ''}>
              Proposto
            </span>
          )}
        </div>
        <div className={styles.muted}>
          Le modifiche valgono per tutti i documenti di questo tipo. Questo documento si rielabora
          subito: poi torna a «Dati» per completarlo.
        </div>
        <div className={styles.subtle} data-reviewed={reviewed}>
          {reviewed === 0
            ? 'Nessun documento di questo tipo è ancora stato revisionato: i numeri arrivano coi primi salvataggi.'
            : `Numeri su ${plural(reviewed, 'documento revisionato', 'documenti revisionati')}.`}
        </div>
      </section>

      <section className={styles.fieldGroup} data-group="in-map">
        <div className={styles.panelLabel}>
          Campi estratti
          <span className={styles.tabCount}>{inProfile.length}</span>
        </div>
        {inProfile.length === 0 ? (
          <div className={styles.muted}>
            La mappa di questo tipo non chiede nessun campo: il motore non precompila niente.
          </div>
        ) : (
          <div className={styles.fieldList}>
            {inProfile.map((field) => (
              <MapFieldCard
                key={field.fieldId}
                measure={measure}
                field={field}
                busy={busy}
                onRequest={request}
                onEdit={onEdit}
                confirm={confirmFor(field.fieldId)}
              />
            ))}
          </div>
        )}
      </section>

      {candidates.length > 0 && (
        <section className={styles.fieldGroup} data-group="candidates">
          <div className={styles.panelLabel}>
            Compilati a mano, fuori dalla mappa
            <span className={styles.tabCount}>{candidates.length}</span>
          </div>
          <div className={styles.muted}>
            Il revisore li scrive su documenti di questo tipo ma il motore non li cerca.
          </div>
          <div className={styles.fieldList}>
            {candidates.map((field) => (
              <div
                key={field.fieldId}
                className={styles.fieldCard}
                data-field={field.fieldId}
                data-signal={field.signal}
              >
                <FieldName field={field} />
                <div className={styles.mapFieldStats}>
                  Compilato su {field.filled} di {plural(field.documents, 'documento', 'documenti')}
                </div>
                <AddRow
                  busy={busy}
                  ariaLabel={`Peso da dare a ${field.label}`}
                  onAdd={(role) =>
                    request(
                      field.fieldId,
                      {
                        kind: 'ADD_FIELD',
                        documentType: measure.documentType,
                        fieldId: field.fieldId,
                        role
                      },
                      `aggiungere ${field.label} alla mappa come ${FIELD_ROLE_LABELS[role]}`
                    )
                  }
                />
                {confirmFor(field.fieldId)}
              </div>
            ))}
          </div>
        </section>
      )}

      {excluded.length > 0 && (
        <section className={styles.fieldGroup} data-group="excluded">
          <div className={styles.panelLabel}>
            Segnati non utili
            <span className={styles.tabCount}>{excluded.length}</span>
          </div>
          <div className={styles.fieldList}>
            {excluded.map((field) => (
              <div
                key={field.fieldId}
                className={cx(styles.fieldCard, styles.mapFieldExcluded)}
                data-field={field.fieldId}
                data-decision="excluded"
              >
                <div className={styles.mapFieldHead}>
                  <FieldName field={field} />
                  <button
                    type="button"
                    className={styles.iconButton}
                    disabled={busy}
                    title="Toglie la decisione presa qui: il campo torna a fare quello che dice il registry."
                    onClick={() =>
                      request(
                        field.fieldId,
                        restoreEdit(measure, field),
                        `riportare ${field.label} a quello che dice il registry`
                      )
                    }
                  >
                    Ripristina
                  </button>
                </div>
                {field.documents > 0 && (
                  <div className={styles.mapFieldStats}>
                    Aveva un valore su {field.filled} di{' '}
                    {plural(field.documents, 'documento', 'documenti')}
                  </div>
                )}
                {confirmFor(field.fieldId)}
              </div>
            ))}
          </div>
        </section>
      )}

      <AddAnyField map={map} busy={busy} onRequest={request} confirm={confirmFor('add-any')} />

      {map.undoable.length > 0 && (
        <section className={styles.fieldGroup} data-group="undo">
          <div className={styles.panelLabel}>
            Modifiche a questo tipo
            <span className={styles.tabCount}>{map.undoable.length}</span>
          </div>
          <ul className={styles.mapUndoList}>
            {map.undoable.map((action) => (
              <li key={action.id} className={styles.mapUndoItem} data-action={action.id}>
                <div className={styles.mapUndoBody}>
                  <div className={styles.mapUndoDetail}>{action.detail}</div>
                  <div className={styles.subtle}>{formatDateTime(action.at)}</div>
                </div>
                <button
                  type="button"
                  className={styles.iconButton}
                  disabled={busy}
                  onClick={() => onRevert(action.id)}
                >
                  Annulla
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function restoreEdit(measure: ProfileTypeMeasure, field: ProfileFieldMeasure): ProfileEdit {
  return { kind: 'RESTORE_FIELD', documentType: measure.documentType, fieldId: field.fieldId }
}

function FieldName({ field }: { field: ProfileFieldMeasure }) {
  return (
    <div className={styles.mapFieldName}>
      <span className={styles.mapFieldLabel}>
        {field.label}
        {field.decision && field.decision !== 'excluded' && (
          <span
            className={cx(styles.pill, styles.pillChanged)}
            title="Deciso qui, non dal registry."
          >
            modificato
          </span>
        )}
      </span>
      <span className={styles.mapFieldId}>{field.fieldId}</span>
      {/* Cosa vuol dire il campo qui: su una ricevuta di bonifico l'IBAN è del beneficiario. */}
      {field.note && <span className={styles.mapFieldNote}>{field.note}</span>}
    </div>
  )
}

/** «3 confermati · 1 corretto · 2 a mano su 6»: tre numeri in una riga sola. */
function stats(field: ProfileFieldMeasure): string {
  return (
    `${field.confirmed} ${field.confirmed === 1 ? 'confermato' : 'confermati'} · ` +
    `${field.corrected} ${field.corrected === 1 ? 'corretto' : 'corretti'} · ` +
    `${field.manual} a mano su ${field.documents}`
  )
}

function MapFieldCard({
  measure,
  field,
  busy,
  onRequest,
  onEdit,
  confirm
}: {
  measure: ProfileTypeMeasure
  field: ProfileFieldMeasure
  busy: boolean
  onRequest: (key: string, edit: ProfileEdit, description: string) => void
  onEdit: (edit: ProfileEdit) => void
  confirm: React.ReactNode
}) {
  const [hintOpen, setHintOpen] = useState(false)
  const { documentType } = measure

  return (
    <div
      className={styles.fieldCard}
      data-field={field.fieldId}
      data-signal={field.signal}
      data-decision={field.decision ?? ''}
    >
      <div className={styles.mapFieldHead}>
        <FieldName field={field} />
        <select
          className={cx(styles.select, styles.mapRoleSelect)}
          value={field.role ?? 'optional'}
          disabled={busy}
          aria-label={`Peso di ${field.label}`}
          onChange={(event) => {
            const role = event.target.value as FieldRole
            onRequest(
              field.fieldId,
              { kind: 'SET_ROLE', documentType, fieldId: field.fieldId, role },
              `portare ${field.label} a ${FIELD_ROLE_LABELS[role]}`
            )
          }}
        >
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {FIELD_ROLE_LABELS[role]}
            </option>
          ))}
        </select>
      </div>

      <CardinalityRow
        field={field}
        busy={busy}
        onChange={(cardinality) =>
          onRequest(
            field.fieldId,
            { kind: 'SET_CARDINALITY', documentType, fieldId: field.fieldId, cardinality },
            `chiedere ${CARDINALITY_LABELS[cardinality]} per ${field.label}`
          )
        }
      />

      {field.documents > 0 && <div className={styles.mapFieldStats}>{stats(field)}</div>}

      {field.signal === 'NEVER_USED' && (
        <div className={cx(styles.mapNote, styles.mapNoteWarn)}>
          Mai valorizzato su{' '}
          {plural(field.documents, 'documento revisionato', 'documenti revisionati')}: forse questo
          tipo non ce l&apos;ha.
        </div>
      )}
      {field.manual > 0 && (
        <div className={styles.mapNote}>
          Il motore non lo trova e il revisore lo scrive a mano: se nel documento ha un&apos;altra
          etichetta, insegnagliela.
        </div>
      )}

      {hintOpen ? (
        <HintForm
          label={field.label}
          busy={busy}
          onClose={() => setHintOpen(false)}
          onSave={(label) => {
            setHintOpen(false)
            // Un'etichetta in più non cambia la mappa: non serve una conferma.
            onEdit({ kind: 'ADD_HINT_LABEL', documentType, fieldId: field.fieldId, label })
          }}
        />
      ) : (
        <div className={styles.mapFieldActions}>
          <button
            type="button"
            className={styles.iconButton}
            disabled={busy}
            title="Il motore cerca il valore dopo un'etichetta. Aggiungine una se nei documenti veri il campo si chiama in un altro modo."
            onClick={() => setHintOpen(true)}
          >
            Aggiungi etichetta
          </button>
          <button
            type="button"
            className={cx(styles.iconButton, styles.iconButtonDanger)}
            disabled={busy}
            title="Il campo non appartiene a questo tipo: il motore smette di cercarlo e la decisione resta scritta."
            onClick={() =>
              onRequest(
                field.fieldId,
                { kind: 'REMOVE_FIELD', documentType, fieldId: field.fieldId },
                `segnare ${field.label} come non utile per questo tipo`
              )
            }
          >
            Segna non utile
          </button>
          {field.decision && (
            <button
              type="button"
              className={styles.iconButton}
              disabled={busy}
              title="Toglie la decisione presa qui: il campo torna a fare quello che dice il registry."
              onClick={() =>
                onRequest(
                  field.fieldId,
                  restoreEdit(measure, field),
                  `riportare ${field.label} a quello che dice il registry`
                )
              }
            >
              Ripristina
            </button>
          )}
        </div>
      )}

      {confirm}
    </div>
  )
}

/**
 * Uno o più valori. Le righe di una fattura, le parti di un contratto, gli IBAN di un
 * estratto conto sono più d'uno; il numero documento è uno. Rimettere la scelta
 * dell'ontologia toglie la decisione: non serve un «Ripristina» a parte.
 */
function CardinalityRow({
  field,
  busy,
  onChange
}: {
  field: ProfileFieldMeasure
  busy: boolean
  onChange: (cardinality: Cardinality) => void
}) {
  return (
    <div className={styles.mapCardinality} data-cardinality={field.cardinality}>
      <span className={styles.mapCardinalityLabel}>
        Valori da estrarre
        {field.cardinalityDecision && (
          <span
            className={cx(styles.pill, styles.pillChanged)}
            title="Deciso qui per questo tipo, non dall'ontologia."
          >
            modificato
          </span>
        )}
      </span>
      <select
        className={cx(styles.select, styles.mapRoleSelect)}
        value={field.cardinality}
        disabled={busy}
        aria-label={`Quanti valori per ${field.label}`}
        title="Un solo valore, o più valori (una riga per valore): il documento si rielabora e in «Dati» il campo cambia forma."
        onChange={(event) => onChange(event.target.value as Cardinality)}
      >
        {(['one', 'many'] as const).map((cardinality) => (
          <option key={cardinality} value={cardinality}>
            {CARDINALITY_LABELS[cardinality]}
          </option>
        ))}
      </select>
    </div>
  )
}

/** Il peso da dare a un campo nuovo, e il pulsante che lo aggiunge: opzionale di default. */
function AddRow({
  busy,
  ariaLabel,
  disabled = false,
  onAdd
}: {
  busy: boolean
  ariaLabel: string
  disabled?: boolean
  onAdd: (role: FieldRole) => void
}) {
  const [role, setRole] = useState<FieldRole>('optional')
  return (
    <div className={styles.mapInline}>
      <select
        className={cx(styles.select, styles.mapInlineGrow)}
        value={role}
        disabled={busy}
        aria-label={ariaLabel}
        onChange={(event) => setRole(event.target.value as FieldRole)}
      >
        {ROLES.map((entry) => (
          <option key={entry} value={entry}>
            {FIELD_ROLE_LABELS[entry]}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={cx(styles.button, styles.buttonSmall, styles.buttonPrimary)}
        disabled={busy || disabled}
        onClick={() => onAdd(role)}
      >
        Aggiungi alla mappa
      </button>
    </div>
  )
}

/**
 * Qualsiasi campo dell'ontologia, anche mai visto su un documento. Una mappa sbagliata si
 * vede anche per assenza: il tipo vorrebbe un dato che nessuno ha mai scritto perché il
 * motore non lo chiedeva.
 */
function AddAnyField({
  map,
  busy,
  onRequest,
  confirm
}: {
  map: TypeFieldMap
  busy: boolean
  onRequest: (key: string, edit: ProfileEdit, description: string) => void
  confirm: React.ReactNode
}) {
  const [fieldId, setFieldId] = useState<string | null>(null)
  const { measure, ontology } = map

  /** Quelli che questo tipo già chiede non si possono aggiungere due volte. */
  const options = useMemo(() => {
    const taken = new Set(
      measure.fields.filter((field) => field.inProfile).map((field) => field.fieldId)
    )
    return ontology.filter((option) => !taken.has(option.id))
  }, [measure, ontology])
  const chosen = options.find((option) => option.id === fieldId) ?? null

  return (
    <section className={styles.fieldGroup} data-add-any="true">
      <div className={styles.panelLabel}>Aggiungi un campo</div>
      <div className={styles.muted}>
        Tutti i {ontology.length} campi dell&apos;ontologia, anche quelli mai visti su un documento.
      </div>
      <div className={cx(styles.fieldCard, styles.mapAddCard)}>
        <SearchableSelect
          value={fieldId}
          options={options}
          emptyLabel="Scegli un campo…"
          disabled={busy}
          searchPlaceholder="Cerca un campo…"
          onChange={setFieldId}
        />
        <AddRow
          busy={busy}
          disabled={!chosen}
          ariaLabel="Peso del campo da aggiungere"
          onAdd={(role) => {
            if (!chosen) return
            setFieldId(null)
            onRequest(
              'add-any',
              { kind: 'ADD_FIELD', documentType: map.documentType, fieldId: chosen.id, role },
              `aggiungere ${chosen.label} alla mappa come ${FIELD_ROLE_LABELS[role]}`
            )
          }}
        />
        {confirm}
      </div>
    </section>
  )
}

/**
 * L'etichetta con cui il campo compare nei documenti veri. È la correzione giusta quando
 * il campo è nella mappa ma il revisore lo riempie sempre a mano.
 */
function HintForm({
  label: fieldLabel,
  busy,
  onSave,
  onClose
}: {
  label: string
  busy: boolean
  onSave: (label: string) => void
  onClose: () => void
}) {
  const [label, setLabel] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
  }, [])

  function submit() {
    const value = label.trim()
    if (value.length < 2) return
    onSave(value)
  }

  return (
    <div className={styles.mapHintForm}>
      <input
        ref={input}
        className={styles.fieldInput}
        value={label}
        placeholder="Etichetta come compare nel documento"
        aria-label={`Etichetta per ${fieldLabel}`}
        disabled={busy}
        onChange={(event) => setLabel(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit()
          if (event.key === 'Escape') onClose()
        }}
      />
      <div className={styles.mapFieldActions}>
        <button
          type="button"
          className={cx(styles.button, styles.buttonSmall, styles.buttonPrimary)}
          disabled={busy || label.trim().length < 2}
          onClick={submit}
        >
          Salva etichetta
        </button>
        <button type="button" className={cx(styles.button, styles.buttonSmall)} onClick={onClose}>
          Annulla
        </button>
      </div>
    </div>
  )
}

/**
 * La conferma esplicita per i profili costruiti su documenti reali: sono la cornice su cui
 * si misura tutto il resto, e cambiarli per sbaglio sposta il metro. Compare dentro la
 * scheda del campo, dove il revisore ha appena cliccato.
 */
export function ConfirmEdit({
  description,
  busy,
  onConfirm,
  onCancel
}: {
  description: string
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className={styles.mapConfirm} data-confirm="true">
      <div>Questo profilo è stato verificato su documenti reali. Confermi di {description}?</div>
      <div className={styles.mapFieldActions}>
        <button
          type="button"
          className={cx(styles.button, styles.buttonPrimary, styles.buttonSmall)}
          disabled={busy}
          onClick={onConfirm}
        >
          Sì, correggi
        </button>
        <button type="button" className={cx(styles.button, styles.buttonSmall)} onClick={onCancel}>
          Annulla
        </button>
      </div>
    </div>
  )
}
