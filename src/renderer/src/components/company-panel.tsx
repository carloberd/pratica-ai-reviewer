import { type CompanyIdentity, EMPTY_COMPANY } from '@shared/document-direction'
import { useEffect, useState } from 'react'
import { cx } from '../lib/cx'
import styles from './document-review.module.css'

interface Props {
  company: CompanyIdentity | null
  busy: boolean
  onSave: (identity: CompanyIdentity) => void
}

/**
 * L'azienda di cui sono i documenti: l'unica impostazione dell'app.
 *
 * Serve a dire se un documento è emesso o ricevuto — la stessa fattura è emessa per chi
 * la scrive e ricevuta per chi la paga, e senza sapere chi siamo la domanda non ha
 * risposta. Sta nella dashboard perché vale per tutti i documenti, non per quello aperto.
 *
 * Partita IVA e codice fiscale decidono; il nome serve ai tipi che nel profilo non hanno
 * nessun campo fiscale, come il preventivo, dove altrimenti la direzione resterebbe
 * sempre vuota.
 */
export default function CompanyPanel({ company, busy, onSave }: Props) {
  const [draft, setDraft] = useState<CompanyIdentity>(company ?? EMPTY_COMPANY)

  // Si risincronizza sui valori salvati, non sull'oggetto: ogni refresh ne porta uno
  // nuovo, e ricopiarlo cancellerebbe quello che il revisore sta scrivendo.
  const saved = `${company?.name ?? ''}|${company?.vatNumber ?? ''}|${company?.taxCode ?? ''}`
  // biome-ignore lint/correctness/useExhaustiveDependencies: si rilegge solo quando cambia quello che è salvato
  useEffect(() => {
    if (company) setDraft(company)
  }, [saved])

  const dirty =
    company !== null &&
    (trimmed(draft.name) !== trimmed(company.name) ||
      trimmed(draft.vatNumber) !== trimmed(company.vatNumber) ||
      trimmed(draft.taxCode) !== trimmed(company.taxCode))
  const empty = !company?.name && !company?.vatNumber && !company?.taxCode

  const set = (key: keyof CompanyIdentity) => (value: string) =>
    setDraft((current) => ({ ...current, [key]: value }))

  return (
    <section className={cx(styles.card, styles.companyCard)} data-company={empty ? 'empty' : 'set'}>
      <div className={styles.panelLabel}>L’azienda di cui sono i documenti</div>
      <div className={styles.muted}>
        Serve a dire se un documento è emesso o ricevuto: si confrontano emittente e destinatario
        con lei. Finché è vuota, nessun documento ha una direzione.
      </div>

      <div className={styles.companyFields}>
        <Field
          label="Ragione sociale"
          value={draft.name ?? ''}
          disabled={busy}
          onChange={set('name')}
        />
        <Field
          label="Partita IVA"
          value={draft.vatNumber ?? ''}
          disabled={busy}
          onChange={set('vatNumber')}
        />
        <Field
          label="Codice fiscale"
          value={draft.taxCode ?? ''}
          disabled={busy}
          onChange={set('taxCode')}
        />
      </div>

      <div className={styles.mapFieldActions}>
        <button
          type="button"
          className={styles.iconButton}
          disabled={busy || !dirty}
          onClick={() => onSave(draft)}
        >
          Salva
        </button>
        {dirty && <span className={styles.subtle}>Non ancora salvata.</span>}
      </div>
    </section>
  )
}

function Field({
  label,
  value,
  disabled,
  onChange
}: {
  label: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <label className={styles.companyField}>
      <span className={styles.subtle}>{label}</span>
      <input
        className={styles.fieldInput}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

function trimmed(value: string | null | undefined): string {
  return value?.trim() ?? ''
}
