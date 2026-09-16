import type { FieldRole } from '@shared/extraction-v2'
import type { ProfileEdit } from '@shared/profile-edit'
import {
  FIELD_ROLE_LABELS,
  type ProfileFieldMeasure,
  type ProfileTypeMeasure
} from '@shared/profile-metrics'
import { useEffect, useRef, useState } from 'react'
import { cx } from '../lib/cx'
import { pct } from '../lib/format'
import styles from './document-review.module.css'

/**
 * I campi di un tipo con accanto i numeri delle annotazioni, e i pulsanti che
 * correggono l'istruzione.
 *
 * L'editor è guidato dai numeri, non da una lista di opzioni: un campo che non ha mai
 * avuto un valore si toglie, un campo che il revisore aggiunge sempre si aggiunge, un
 * campo che il motore non trova mai chiede l'etichetta con cui compare nei documenti.
 * Ogni pulsante sta accanto al numero che lo motiva.
 */

const ROLES: FieldRole[] = ['required', 'core', 'optional', 'conditional']

export interface FieldAction {
  edit: ProfileEdit
  /** Cosa sta per succedere, in una frase: è quella della richiesta di conferma. */
  description: string
}

interface Props {
  measure: ProfileTypeMeasure
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

export default function ProfileFields({ measure, disabled, onEdit }: Props) {
  const [hintField, setHintField] = useState<string | null>(null)

  const inProfile = measure.fields.filter((field) => field.inProfile)
  const candidates = measure.fields.filter(
    (field) => !field.inProfile && field.signal === 'MISSING_FROM_PROFILE'
  )

  return (
    <>
      <div className={styles.panelLabel}>
        Campi che il profilo chiede
        <span className={styles.muted}>{inProfile.length}</span>
      </div>

      {inProfile.length === 0 ? (
        <div className={styles.muted}>
          Il profilo di questo tipo non chiede nessun campo: il motore non precompila niente.
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
                <tr key={field.fieldId} data-field={field.fieldId} data-signal={field.signal}>
                  <td>
                    <div className={styles.fileName}>{field.label}</div>
                    <div className={styles.subtle}>{field.fieldId}</div>
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
                      <>
                        <div className={styles.warning}>
                          Mai usato: su{' '}
                          {field.documents === 1 ? 'un documento' : `${field.documents} documenti`}{' '}
                          di questo tipo non ha mai avuto un valore.
                        </div>
                        <button
                          type="button"
                          className={cx(styles.button, styles.buttonSmall)}
                          disabled={disabled}
                          onClick={() =>
                            onEdit({
                              edit: {
                                kind: 'REMOVE_FIELD',
                                documentType: measure.documentType,
                                fieldId: field.fieldId
                              },
                              description: `togliere ${field.fieldId} dal profilo di ${measure.documentType}`
                            })
                          }
                        >
                          Togli dal profilo
                        </button>
                      </>
                    )}

                    {field.manual > 0 && (
                      <div className={styles.muted}>
                        Il motore lo chiede ma non lo trova: il revisore lo scrive a mano.
                      </div>
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
        Campi che il revisore aggiunge e il profilo non prevede
        <span className={styles.muted}>{candidates.length}</span>
      </div>

      {candidates.length === 0 ? (
        <div className={styles.muted}>
          Nessuno: su questi documenti il revisore non ha compilato campi fuori dal profilo.
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
    </>
  )
}

/**
 * L'etichetta con cui il campo compare nei documenti veri. È la correzione giusta quando
 * il campo è nel profilo ma il revisore lo riempie sempre a mano: il motore lo cerca, non
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
    const trimmed = label.trim()
    if (trimmed === '') return
    onClose()
    onEdit({
      edit: {
        kind: 'ADD_HINT_LABEL',
        documentType: measure.documentType,
        fieldId: field.fieldId,
        label: trimmed
      },
      description: `aggiungere «${trimmed}» fra le etichette con cui il motore cerca ${field.label}`
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

/** Aggiunge un campo al profilo col peso scelto: opzionale di default, il più prudente. */
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
            description: `aggiungere ${field.fieldId} al profilo di ${measure.documentType} come ${FIELD_ROLE_LABELS[role]}`
          })
        }
      >
        Aggiungi al profilo
      </button>
    </div>
  )
}
