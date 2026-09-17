import type { FieldRole } from '@shared/extraction-v2'
import type { ProfileEdit } from '@shared/profile-edit'
import {
  FIELD_ROLE_LABELS,
  type ProfileFieldMeasure,
  type ProfileTypeMeasure
} from '@shared/profile-metrics'
import type { FieldOption } from '@shared/profile-workspace'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cx } from '../lib/cx'
import { pct } from '../lib/format'
import styles from './document-review.module.css'
import SearchableSelect from './searchable-select'

/**
 * I campi di un tipo con accanto i numeri delle annotazioni, e i pulsanti che
 * correggono la mappa «tipo ↔ dati da estrarre».
 *
 * L'editor è guidato dai numeri — un campo mai valorizzato si segna non utile, un campo
 * che il revisore compila sempre si aggiunge, un campo che il motore non trova chiede
 * l'etichetta con cui compare — ma non è chiuso dentro i numeri: in fondo c'è l'elenco
 * intero dell'ontologia, perché un tipo può avere bisogno di un dato che nessuna
 * annotazione ha ancora prodotto.
 *
 * Nessuna di queste azioni tocca un file: scrivono una decisione sul database, valgono
 * subito per il motore, e restano annullabili dalla cronologia.
 */

const ROLES: FieldRole[] = ['required', 'core', 'optional', 'conditional']

export interface FieldAction {
  edit: ProfileEdit
  /** Cosa sta per succedere, in una frase: è quella della richiesta di conferma. */
  description: string
}

interface Props {
  measure: ProfileTypeMeasure
  /** Tutti i campi dell'ontologia, per il menu che li elenca tutti. */
  ontology: FieldOption[]
  disabled: boolean
  onEdit: (action: FieldAction) => void
}

/** Quota di documenti in cui il campo ha finito per avere un valore. */
function filledRate(field: ProfileFieldMeasure): number {
  return field.documents === 0 ? 0 : field.filled / field.documents
}

/** «3 su 12 (25%)»: il conteggio e la quota, perché da soli dicono due cose diverse. */
function share(count: number, documents: number, rate: number): string {
  if (documents === 0) return '—'
  return `${count} su ${documents} (${pct(rate)})`
}

/** Il pulsante che toglie la decisione del revisore e rimette quella del registry. */
function RestoreButton({
  measure,
  field,
  disabled,
  onEdit
}: {
  measure: ProfileTypeMeasure
  field: ProfileFieldMeasure
  disabled: boolean
  onEdit: (action: FieldAction) => void
}) {
  return (
    <button
      type="button"
      className={cx(styles.button, styles.buttonSmall)}
      disabled={disabled}
      title="Toglie la decisione presa qui: il campo torna a fare quello che dice il registry."
      onClick={() =>
        onEdit({
          edit: {
            kind: 'RESTORE_FIELD',
            documentType: measure.documentType,
            fieldId: field.fieldId
          },
          description: `riportare ${field.label} a quello che dice il registry`
        })
      }
    >
      Ripristina
    </button>
  )
}

export default function ProfileFields({ measure, ontology, disabled, onEdit }: Props) {
  const [hintField, setHintField] = useState<string | null>(null)

  const inProfile = measure.fields.filter((field) => field.inProfile)
  const candidates = measure.fields.filter(
    (field) => !field.inProfile && field.signal === 'MISSING_FROM_PROFILE'
  )
  const excluded = measure.fields.filter((field) => field.decision === 'excluded')

  return (
    <>
      <div className={styles.panelLabel}>
        Campi che la mappa chiede per questo tipo
        <span className={styles.muted}>{inProfile.length}</span>
      </div>

      {inProfile.length === 0 ? (
        <div className={styles.muted}>
          La mappa di questo tipo non chiede nessun campo: il motore non precompila niente.
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={cx(styles.table, styles.profileTable)}>
            <thead>
              <tr>
                <th>Campo</th>
                <th>Peso</th>
                <th>Confermati dal motore</th>
                <th>Corretti dal revisore</th>
                <th>Scritti a mano</th>
                <th>Cosa fare</th>
              </tr>
            </thead>
            <tbody>
              {inProfile.map((field) => (
                <tr
                  key={field.fieldId}
                  data-field={field.fieldId}
                  data-signal={field.signal}
                  data-decision={field.decision ?? ''}
                >
                  <td>
                    <div className={styles.fileName}>{field.label}</div>
                    <div className={styles.subtle}>{field.fieldId}</div>
                    {field.decision && (
                      <div className={styles.badge} title="Deciso qui, non dal registry.">
                        deciso dal revisore
                      </div>
                    )}
                  </td>
                  <td>
                    <select
                      className={styles.select}
                      value={field.role ?? 'core'}
                      disabled={disabled}
                      aria-label={`Peso di ${field.label}`}
                      onChange={(event) =>
                        onEdit({
                          edit: {
                            kind: 'SET_ROLE',
                            documentType: measure.documentType,
                            fieldId: field.fieldId,
                            role: event.target.value as FieldRole
                          },
                          description: `portare ${field.label} a ${
                            FIELD_ROLE_LABELS[event.target.value as FieldRole]
                          }`
                        })
                      }
                    >
                      {ROLES.map((role) => (
                        <option key={role} value={role}>
                          {FIELD_ROLE_LABELS[role]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{share(field.confirmed, field.documents, field.confirmedRate)}</td>
                  <td>{share(field.corrected, field.documents, field.correctedRate)}</td>
                  <td>{share(field.manual, field.documents, field.manualRate)}</td>
                  <td className={styles.profileActions}>
                    {field.signal === 'NEVER_USED' && (
                      <div className={styles.warning}>
                        Mai usato: su{' '}
                        {field.documents === 1 ? 'un documento' : `${field.documents} documenti`} di
                        questo tipo non ha mai avuto un valore.
                      </div>
                    )}

                    {field.manual > 0 && (
                      <div className={styles.muted}>
                        Il motore lo chiede ma non lo trova: il revisore lo scrive a mano.
                      </div>
                    )}

                    <button
                      type="button"
                      className={cx(styles.button, styles.buttonSmall)}
                      disabled={disabled}
                      title="Il campo non appartiene a questo tipo: il motore smette di cercarlo e la decisione resta scritta."
                      onClick={() =>
                        onEdit({
                          edit: {
                            kind: 'REMOVE_FIELD',
                            documentType: measure.documentType,
                            fieldId: field.fieldId
                          },
                          description: `segnare ${field.label} come non utile per ${measure.documentType}`
                        })
                      }
                    >
                      Segna non utile
                    </button>

                    {field.decision && (
                      <RestoreButton
                        measure={measure}
                        field={field}
                        disabled={disabled}
                        onEdit={onEdit}
                      />
                    )}

                    {hintField === field.fieldId ? (
                      <HintForm
                        measure={measure}
                        field={field}
                        disabled={disabled}
                        onEdit={onEdit}
                        onClose={() => setHintField(null)}
                      />
                    ) : (
                      <button
                        type="button"
                        className={cx(styles.button, styles.buttonSmall)}
                        disabled={disabled}
                        title="Il motore cerca il valore dopo un'etichetta. Aggiungine una se nei documenti veri il campo si chiama in un altro modo."
                        onClick={() => setHintField(field.fieldId)}
                      >
                        Aggiungi un'etichetta
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className={styles.panelLabel}>
        Campi che il revisore compila e la mappa non prevede
        <span className={styles.muted}>{candidates.length}</span>
      </div>

      {candidates.length === 0 ? (
        <div className={styles.muted}>
          Nessuno: su questi documenti il revisore non ha compilato campi fuori dalla mappa.
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={cx(styles.table, styles.profileTable)}>
            <thead>
              <tr>
                <th>Campo</th>
                <th>Quante volte</th>
                <th>Cosa fare</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((field) => (
                <tr key={field.fieldId} data-field={field.fieldId} data-signal={field.signal}>
                  <td>
                    <div className={styles.fileName}>{field.label}</div>
                    <div className={styles.subtle}>{field.fieldId}</div>
                  </td>
                  <td>{share(field.filled, field.documents, filledRate(field))}</td>
                  <td className={styles.profileActions}>
                    <AddField measure={measure} field={field} disabled={disabled} onEdit={onEdit} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {excluded.length > 0 && (
        <>
          <div className={styles.panelLabel}>
            Campi segnati non utili per questo tipo
            <span className={styles.muted}>{excluded.length}</span>
          </div>
          <div className={styles.tableWrap}>
            <table className={cx(styles.table, styles.profileTable)}>
              <thead>
                <tr>
                  <th>Campo</th>
                  <th>Valori raccolti prima</th>
                  <th>Cosa fare</th>
                </tr>
              </thead>
              <tbody>
                {excluded.map((field) => (
                  <tr key={field.fieldId} data-field={field.fieldId} data-decision="excluded">
                    <td>
                      <div className={styles.fileName}>{field.label}</div>
                      <div className={styles.subtle}>{field.fieldId}</div>
                    </td>
                    <td>{share(field.filled, field.documents, filledRate(field))}</td>
                    <td className={styles.profileActions}>
                      <RestoreButton
                        measure={measure}
                        field={field}
                        disabled={disabled}
                        onEdit={onEdit}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <AddAnyField measure={measure} ontology={ontology} disabled={disabled} onEdit={onEdit} />
    </>
  )
}

/**
 * Qualsiasi campo dell'ontologia, anche mai visto su un documento.
 *
 * I candidati qui sopra nascono dalle annotazioni: dicono cosa il revisore ha già
 * compilato. Ma una mappa sbagliata si vede anche per assenza — il tipo vorrebbe un dato
 * che nessuno ha mai scritto perché il motore non lo chiedeva e compilarlo a mano non
 * era previsto. Da qui si aggiunge lo stesso, scegliendolo fra tutti.
 */
function AddAnyField({
  measure,
  ontology,
  disabled,
  onEdit
}: {
  measure: ProfileTypeMeasure
  ontology: FieldOption[]
  disabled: boolean
  onEdit: (action: FieldAction) => void
}) {
  const [fieldId, setFieldId] = useState<string | null>(null)
  const [role, setRole] = useState<FieldRole>('optional')

  /** Quelli che questo tipo già chiede non si possono aggiungere due volte. */
  const taken = useMemo(
    () => new Set(measure.fields.filter((field) => field.inProfile).map((field) => field.fieldId)),
    [measure]
  )
  const options = useMemo(
    () => ontology.filter((option) => !taken.has(option.id)),
    [ontology, taken]
  )
  const chosen = options.find((option) => option.id === fieldId) ?? null

  return (
    <div className={cx(styles.card, styles.addFieldPanel)} data-add-any="true">
      <div className={styles.panelLabel}>Aggiungi un campo che la mappa non prevede</div>
      <div className={styles.muted}>
        Tutti i {ontology.length} campi dell&apos;ontologia, non solo quelli già visti su un
        documento.
      </div>
      <div className={styles.hintForm}>
        <SearchableSelect
          value={fieldId}
          options={options}
          emptyLabel="Nessun campo scelto"
          disabled={disabled}
          searchPlaceholder="Cerca un campo…"
          onChange={setFieldId}
        />
        <select
          className={styles.select}
          value={role}
          disabled={disabled}
          aria-label="Peso del campo da aggiungere"
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
          disabled={disabled || !chosen}
          onClick={() => {
            if (!chosen) return
            setFieldId(null)
            onEdit({
              edit: {
                kind: 'ADD_FIELD',
                documentType: measure.documentType,
                fieldId: chosen.id,
                role
              },
              description: `aggiungere ${chosen.label} alla mappa di ${measure.documentType} come ${FIELD_ROLE_LABELS[role]}`
            })
          }}
        >
          Aggiungi alla mappa
        </button>
      </div>
    </div>
  )
}

/**
 * L'etichetta con cui il campo compare nei documenti veri. È la correzione giusta quando
 * il campo è nella mappa ma il revisore lo riempie sempre a mano: il motore lo cerca, non
 * lo trova, e quello che gli manca è come si chiama.
 */
function HintForm({
  measure,
  field,
  disabled,
  onEdit,
  onClose
}: {
  measure: ProfileTypeMeasure
  field: ProfileFieldMeasure
  disabled: boolean
  onEdit: (action: FieldAction) => void
  onClose: () => void
}) {
  const [label, setLabel] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
  }, [])

  function submit() {
    const value = label.trim()
    if (value === '') return
    onClose()
    onEdit({
      edit: {
        kind: 'ADD_HINT_LABEL',
        documentType: measure.documentType,
        fieldId: field.fieldId,
        label: value
      },
      description: `insegnare al motore che ${field.label} compare come «${value}»`
    })
  }

  return (
    <div className={styles.hintForm}>
      <input
        ref={input}
        className={styles.input}
        value={label}
        placeholder="Etichetta come compare nel documento"
        aria-label={`Etichetta per ${field.label}`}
        disabled={disabled}
        onChange={(event) => setLabel(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit()
          if (event.key === 'Escape') onClose()
        }}
      />
      <button
        type="button"
        className={cx(styles.button, styles.buttonSmall, styles.buttonPrimary)}
        disabled={disabled || label.trim() === ''}
        onClick={submit}
      >
        Salva etichetta
      </button>
    </div>
  )
}

/** Aggiunge alla mappa un campo che il revisore compila già: opzionale di default. */
function AddField({
  measure,
  field,
  disabled,
  onEdit
}: {
  measure: ProfileTypeMeasure
  field: ProfileFieldMeasure
  disabled: boolean
  onEdit: (action: FieldAction) => void
}) {
  const [role, setRole] = useState<FieldRole>('optional')

  return (
    <div className={styles.hintForm}>
      <select
        className={styles.select}
        value={role}
        disabled={disabled}
        aria-label={`Peso da dare a ${field.label}`}
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
        disabled={disabled}
        onClick={() =>
          onEdit({
            edit: {
              kind: 'ADD_FIELD',
              documentType: measure.documentType,
              fieldId: field.fieldId,
              role
            },
            description: `aggiungere ${field.fieldId} alla mappa di ${measure.documentType} come ${FIELD_ROLE_LABELS[role]}`
          })
        }
      >
        Aggiungi alla mappa
      </button>
    </div>
  )
}
