import { normalizeDateValue } from './date-value'

/**
 * ## La scadenza di un attestato di formazione, che il documento quasi mai scrive
 *
 * Un attestato dice quando il corso è stato fatto, non quando la formazione scade: la
 * scadenza dipende dal corso e dalla normativa, e chi la scrive la calcola. Il revisore
 * l'ha fatto a mano su `6ad7d267` (export del 18/09): attestato del 13/05/2021,
 * `hse.training_expiry` = 13/05/2026, cinque anni dopo il rilascio — non dopo l'ultima
 * giornata d'aula (04/05), che pure c'era sul documento.
 *
 * Qui c'è solo la tabella e il conto. Nessun file, nessun database: chi estrae la applica
 * e marca il valore come dedotto, perché una scadenza calcolata non è una scadenza letta
 * e nel dataset le due non vanno confuse (`origin: "COMPUTED"`).
 *
 * ### Come si aggiunge un corso
 *
 * Una riga per tipo di attestato, con gli anni, la data da cui si contano e **il
 * riferimento normativo scritto accanto**. La tabella non si scrive a memoria: l'unico
 * dato che l'export conferma sono i cinque anni della formazione dei lavoratori, e
 * finché qualcuno che conosce la normativa in vigore non scrive la riga, un attestato
 * resta senza scadenza calcolata. Meglio un campo vuoto che una data inventata: il
 * revisore vede che manca, una data sbagliata la confermerebbe.
 *
 * I corsi che aspettano una riga, tutti già tipi del registry: preposto, antincendio,
 * primo soccorso, lavori in quota, spazi confinati, DPI di terza categoria, RLS.
 */

/** Il campo che questa tabella riempie. */
export const TRAINING_EXPIRY_FIELD = 'hse.training_expiry'

export interface TrainingValidity {
  /** Anni di validità della formazione. */
  years: number
  /**
   * Il campo da cui si contano: `document.issue_date` è il rilascio dell'attestato,
   * `hse.training_date` la data del corso. Il revisore è partito dal rilascio.
   */
  from: string
  /** La norma che fissa la validità: chi rilegge la riga deve poterla verificare. */
  reference: string
}

/**
 * Corso per corso, quanto vale. La chiave è il tipo del documento, che in questa
 * tassonomia **è** il corso: `hse.training_course` è testo libero letto dal documento, e
 * una tabella che ci si appoggiasse cambierebbe risultato a ogni dicitura nuova.
 */
export const TRAINING_VALIDITY: Record<string, TrainingValidity> = {
  'hse_training.attestato_formazione_generale': {
    years: 5,
    from: 'document.issue_date',
    reference:
      'Accordo Stato-Regioni 21/12/2011, aggiornamento quinquennale della formazione dei lavoratori'
  },
  'hse_training.attestato_formazione_specifica': {
    years: 5,
    from: 'document.issue_date',
    reference:
      'Accordo Stato-Regioni 21/12/2011, aggiornamento quinquennale della formazione dei lavoratori'
  }
}

/**
 * La stessa data quanti anni dopo. Il 29 febbraio non esiste negli anni che non sono
 * bisestili: in quel caso vale il 28, l'ultimo giorno che quel mese ha davvero.
 */
export function addYears(isoDate: string, years: number): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (!match) return null
  const year = Number(match[1]) + years
  const month = Number(match[2])
  const day = Number(match[3])
  const lastOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${String(year).padStart(4, '0')}-${match[2]}-${String(Math.min(day, lastOfMonth)).padStart(2, '0')}`
}

export interface ComputedTrainingExpiry {
  value: string
  /** Il campo da cui è stata contata, e quanti anni: è quello che va scritto nell'evento. */
  from: string
  years: number
  reference: string
}

/**
 * La scadenza dedotta per un attestato, o `null` se non c'è niente da dedurre: il corso
 * non è in tabella, o la data da cui contare manca o non è una data.
 *
 * `fieldValue` dà il valore di un campo già letto dal documento. Non tocca il caso in cui
 * la scadenza c'è già scritta: quella decisione sta in chi chiama, perché una scadenza letta
 * vince sempre su una calcolata.
 */
export function trainingExpiryOf(
  documentType: string,
  fieldValue: (fieldId: string) => string | null
): ComputedTrainingExpiry | null {
  const validity = TRAINING_VALIDITY[documentType]
  if (!validity) return null

  const raw = fieldValue(validity.from)
  const start = raw ? normalizeDateValue(raw) : null
  if (!start) return null

  const value = addYears(start, validity.years)
  return value
    ? { value, from: validity.from, years: validity.years, reference: validity.reference }
    : null
}
