import type { Cardinality, ClassExtractionProfile, FieldRole } from './extraction-v2'
import { confirmedItems, currentFieldValue, fieldCorrections } from './field-edits'
import type { FieldState, TypeCardinality } from './profile-overlay'
import { hasEngineProposal } from './review-workspace'
import type { ExtractedField } from './types'

/**
 * Quanto serve davvero la precompilazione, tipo per tipo e campo per campo.
 *
 * Le istruzioni di estrazione per tipo (`class_extraction_profiles_v2.json`) sono per lo
 * più bozze: 481 profili su 500 li ha proposti l'AI e nessuno li ha verificati. Le
 * annotazioni del revisore dicono quali funzionano — un campo confermato senza toccarlo
 * è un'istruzione che paga, un campo riempito sempre a mano è un'istruzione da
 * sistemare, un campo che non ha mai un valore è un campo che quel tipo non ha.
 *
 * Qui non c'è né database né filesystem né UI: si parte da `ExtractedField`, il contratto
 * che la revisione già usa. Chi legge dal database (`src/main/profile-insights.ts`)
 * prepara gli ingressi; questo modulo conta e basta.
 *
 * Il confine è quello della task: si misura l'utilità delle regole fisse offline, non
 * l'IA di pratica-ai. Quella si valuta col dataset esportato, sul benchmark della
 * monorepo.
 */

/** Com'è andato un campo su un documento annotato. */
export type FieldOutcome =
  /** Il motore ha proposto un valore e il revisore non l'ha toccato. */
  | 'CONFIRMED'
  /** Il motore ha proposto un valore e il revisore ne ha messo un altro (o l'ha tolto). */
  | 'CORRECTED'
  /** Il motore non ha proposto niente e il revisore ha compilato. */
  | 'MANUAL'
  /** Nessuno dei due ha messo un valore. */
  | 'EMPTY'

/** Cosa dicono i numeri di un campo, letti insieme al profilo. */
export type FieldSignal =
  | 'OK'
  /**
   * Il profilo lo chiede, ma su tutti i documenti annotati di questo tipo non ha mai
   * avuto un valore: quel campo probabilmente non appartiene al tipo. Candidato alla
   * rimozione — è il caso del «numero» chiesto a tipi che non lo prevedono.
   */
  | 'NEVER_USED'
  /**
   * Il profilo non lo prevede, ma il revisore lo aggiunge ai documenti di questo tipo.
   * Candidato all'aggiunta; il numero dice quanto è ripetuto.
   */
  | 'MISSING_FROM_PROFILE'
  /**
   * Il revisore lo ha segnato non utile per questo tipo: il motore non lo cerca più.
   * Resta nell'elenco, con i numeri che aveva, perché la decisione si possa rileggere e
   * all'occorrenza togliere.
   */
  | 'EXCLUDED'

/**
 * Gli stati che dicono «questa mappa è già passata su documenti veri». Sono la cornice
 * del lavoro: si possono correggere, ma non per sbaglio, e la schermata li marca. Gli
 * altri stati — `SCHEMA_READY`, e la proposta delle canoniche nuove — sono mappe scritte
 * a tavolino, e correggerle non chiede conferma.
 */
export const FIELD_TESTED_SCHEMA_STATES = ['PRETESTED', 'TESTED', 'VALIDATION_READY']

export function isFieldTestedProfile(
  profile: Pick<ClassExtractionProfile, 'schema_state'> | null
): boolean {
  return profile !== null && FIELD_TESTED_SCHEMA_STATES.includes(profile.schema_state)
}

/** Da dove viene il profilo di un tipo. Ricalca `ProfileSource` del caricatore. */
export type ProfileOrigin = 'EXPLICIT' | 'MISSING'

/** Il peso di un campo nel profilo, come lo legge chi non ha scritto il codice. */
export const FIELD_ROLE_LABELS: Record<FieldRole, string> = {
  required: 'obbligatorio',
  optional: 'opzionale'
}

/** Da dove viene il profilo, in una frase. */
export const PROFILE_ORIGIN_LABELS: Record<ProfileOrigin, string> = {
  EXPLICIT: 'mappa dei campi del registry',
  MISSING: 'nessuna mappa per questo tipo: il motore non estrae niente'
}

export interface ProfileFieldRef {
  fieldId: string
  label: string
  role: FieldRole
}

/** Un documento annotato che vota. Solo i `REVIEWED`: gli scartati non votano. */
export interface MeasuredDocumentInput {
  documentId: string
  driveFileId: string
  filename: string
  reviewedAt: string | null
  fields: ExtractedField[]
}

export interface MeasuredTypeInput {
  documentType: string
  label: string | null
  profileOrigin: ProfileOrigin
  schemaState: string | null
  /** Profilo costruito su documenti reali: modificarlo chiede conferma. */
  fieldTested: boolean
  /** Campi del profilo attuale, nell'ordine required → optional. */
  profileFields: ProfileFieldRef[]
  /** Le decisioni del revisore su questo tipo: campo per campo, ruolo o «non utile». */
  decisions?: Record<string, FieldState>
  /** L'etichetta di un campo dell'ontologia, per quelli che nessun documento porta. */
  fieldLabel?: (fieldId: string) => string | null
  /** Cosa vuol dire il campo su questo tipo, dove il profilo lo dice. */
  fieldNote?: (fieldId: string) => string | null
  /** Quanti valori chiede il campo su questo tipo adesso: decisione del revisore o ontologia. */
  fieldCardinality?: (fieldId: string) => Cardinality
  /** Le cardinalità decise dal revisore su questo tipo, dove diverse dall'ontologia. */
  cardinalityDecisions?: TypeCardinality
  documents: MeasuredDocumentInput[]
}

export interface ProfileFieldMeasure {
  fieldId: string
  label: string
  /**
   * Cosa vuol dire il campo su questo tipo, quando il profilo lo scrive: l'IBAN di una
   * ricevuta di bonifico è quello del beneficiario. `null` quando non c'è niente da
   * aggiungere all'etichetta.
   */
  note: string | null
  /** Ruolo nel profilo attuale; `null` quando il profilo non prevede il campo. */
  role: FieldRole | null
  inProfile: boolean
  confirmed: number
  corrected: number
  manual: number
  empty: number
  /** Documenti in cui il campo ha finito per avere un valore. */
  filled: number
  /** Documenti annotati del tipo: il denominatore di tutti i conteggi qui sopra. */
  documents: number
  confirmedRate: number
  correctedRate: number
  manualRate: number
  signal: FieldSignal
  /**
   * La decisione del revisore su questo campo, `null` se il campo segue il registry.
   * È quello che distingue «il registry non lo prevede» da «l'abbiamo scartato noi».
   */
  decision: FieldState | null
  /** Uno o più valori: quello con cui il motore legge il campo su questo tipo adesso. */
  cardinality: Cardinality
  /** La cardinalità decisa dal revisore, `null` se il campo segue l'ontologia. */
  cardinalityDecision: Cardinality | null
}

export interface ProfileTotals {
  documents: number
  confirmed: number
  corrected: number
  manual: number
  /**
   * `confirmed + corrected + manual`: i campi che nel dataset hanno un valore. È il
   * denominatore delle tre quote — un campo vuoto per entrambi non dice niente
   * sull'utilità della precompilazione, e finisce invece nel segnale «mai usato».
   */
  outcomes: number
  confirmedRate: number
  correctedRate: number
  manualRate: number
}

export interface MeasuredDocument {
  documentId: string
  driveFileId: string
  filename: string
  reviewedAt: string | null
  confirmed: number
  corrected: number
  manual: number
}

export interface ProfileTypeMeasure {
  documentType: string
  label: string | null
  profileOrigin: ProfileOrigin
  schemaState: string | null
  fieldTested: boolean
  totals: ProfileTotals
  /** Campi del profilo, poi quelli che il revisore aggiunge e il profilo non prevede. */
  fields: ProfileFieldMeasure[]
  /** I documenti che alimentano i numeri, dal più recente. */
  documents: MeasuredDocument[]
}

// ---------------------------------------------------------------------------
// Il singolo campo su un singolo documento
// ---------------------------------------------------------------------------

/**
 * Le regole sono quelle che la revisione già applica (`@shared/field-edits`): il valore
 * proposto non si sovrascrive mai, e riscrivere quello che il motore aveva proposto non
 * è una correzione. Qui si legge lo stesso stato da un'altra angolazione.
 */
export function fieldOutcome(field: ExtractedField): FieldOutcome {
  const proposed = hasEngineProposal(field)

  if (field.cardinality === 'many') {
    if (!proposed) return confirmedItems(field.items).length > 0 ? 'MANUAL' : 'EMPTY'
    return fieldCorrections(field).length > 0 ? 'CORRECTED' : 'CONFIRMED'
  }

  if (!proposed) return currentFieldValue(field) === null ? 'EMPTY' : 'MANUAL'
  return fieldCorrections(field).length > 0 ? 'CORRECTED' : 'CONFIRMED'
}

// ---------------------------------------------------------------------------
// Aggregazione per tipo
// ---------------------------------------------------------------------------

interface Tally {
  fieldId: string
  label: string
  confirmed: number
  corrected: number
  manual: number
}

const ROLE_ORDER: FieldRole[] = ['required', 'optional']

function rate(count: number, total: number): number {
  if (total === 0) return 0
  return Math.round((count / total) * 1e4) / 1e4
}

function signalOf(
  tally: Tally,
  inProfile: boolean,
  documents: number,
  decision: FieldState | null
): FieldSignal {
  if (decision === 'excluded') return 'EXCLUDED'
  const filled = tally.confirmed + tally.corrected + tally.manual
  if (inProfile) return documents > 0 && filled === 0 ? 'NEVER_USED' : 'OK'
  return filled > 0 ? 'MISSING_FROM_PROFILE' : 'OK'
}

/**
 * I numeri di un tipo documento.
 *
 * Il denominatore di ogni campo è il totale dei documenti annotati del tipo, non i
 * documenti in cui il campo compare: un campo che il profilo chiede e che su un
 * documento non c'è nemmeno come riga vuota conta come vuoto, altrimenti «mai usato» non
 * si distinguerebbe da «mai cercato».
 */
export function measureType(input: MeasuredTypeInput): ProfileTypeMeasure {
  const documents = input.documents.length
  const tallies = new Map<string, Tally>()
  const inProfile = new Map<string, FieldRole>()
  const decisions = input.decisions ?? {}
  const cardinalityDecisions = input.cardinalityDecisions ?? {}

  for (const entry of input.profileFields) {
    inProfile.set(entry.fieldId, entry.role)
    tallies.set(entry.fieldId, {
      fieldId: entry.fieldId,
      label: entry.label,
      confirmed: 0,
      corrected: 0,
      manual: 0
    })
  }

  // Un campo segnato non utile è uscito dal profilo e può non comparire su nessun
  // documento: senza questa riga sparirebbe dalla schermata, e con lui il modo di
  // rimetterlo dentro.
  for (const fieldId of Object.keys(decisions)) {
    if (tallies.has(fieldId)) continue
    tallies.set(fieldId, {
      fieldId,
      label: input.fieldLabel?.(fieldId) ?? fieldId,
      confirmed: 0,
      corrected: 0,
      manual: 0
    })
  }

  const measured: MeasuredDocument[] = []

  for (const document of input.documents) {
    const counts = { confirmed: 0, corrected: 0, manual: 0 }
    for (const field of document.fields) {
      const tally = tallies.get(field.name) ?? {
        fieldId: field.name,
        label: field.label,
        confirmed: 0,
        corrected: 0,
        manual: 0
      }
      // L'etichetta del profilo vince su quella salvata col campo: è quella che il
      // revisore vedrà accanto al pulsante che modifica il profilo.
      if (!inProfile.has(field.name) && field.label) tally.label = field.label
      tallies.set(field.name, tally)

      const outcome = fieldOutcome(field)
      if (outcome === 'EMPTY') continue
      const key =
        outcome === 'CONFIRMED' ? 'confirmed' : outcome === 'CORRECTED' ? 'corrected' : 'manual'
      tally[key] += 1
      counts[key] += 1
    }
    measured.push({
      documentId: document.documentId,
      driveFileId: document.driveFileId,
      filename: document.filename,
      reviewedAt: document.reviewedAt,
      ...counts
    })
  }

  const fields: ProfileFieldMeasure[] = [...tallies.values()].map((tally) => {
    const role = inProfile.get(tally.fieldId) ?? null
    const filled = tally.confirmed + tally.corrected + tally.manual
    return {
      fieldId: tally.fieldId,
      label: tally.label,
      note: input.fieldNote?.(tally.fieldId) ?? null,
      role,
      inProfile: role !== null,
      confirmed: tally.confirmed,
      corrected: tally.corrected,
      manual: tally.manual,
      empty: documents - filled,
      filled,
      documents,
      confirmedRate: rate(tally.confirmed, documents),
      correctedRate: rate(tally.corrected, documents),
      manualRate: rate(tally.manual, documents),
      signal: signalOf(tally, role !== null, documents, decisions[tally.fieldId] ?? null),
      decision: decisions[tally.fieldId] ?? null,
      cardinality:
        cardinalityDecisions[tally.fieldId] ?? input.fieldCardinality?.(tally.fieldId) ?? 'one',
      cardinalityDecision: cardinalityDecisions[tally.fieldId] ?? null
    }
  })

  fields.sort(compareFields)

  const confirmed = sum(fields, 'confirmed')
  const corrected = sum(fields, 'corrected')
  const manual = sum(fields, 'manual')
  const outcomes = confirmed + corrected + manual

  return {
    documentType: input.documentType,
    label: input.label,
    profileOrigin: input.profileOrigin,
    schemaState: input.schemaState,
    fieldTested: input.fieldTested,
    totals: {
      documents,
      confirmed,
      corrected,
      manual,
      outcomes,
      confirmedRate: rate(confirmed, outcomes),
      correctedRate: rate(corrected, outcomes),
      manualRate: rate(manual, outcomes)
    },
    fields,
    documents: measured.sort(
      (a, b) =>
        (b.reviewedAt ?? '').localeCompare(a.reviewedAt ?? '') ||
        a.filename.localeCompare(b.filename, 'it')
    )
  }
}

/** Prima i campi del profilo, per ruolo; poi i candidati all'aggiunta, i più chiesti sopra. */
function compareFields(a: ProfileFieldMeasure, b: ProfileFieldMeasure): number {
  if (a.inProfile !== b.inProfile) return a.inProfile ? -1 : 1
  // I campi scartati in fondo: sono decisioni prese, non lavoro da fare.
  const excluded = (field: ProfileFieldMeasure) => (field.decision === 'excluded' ? 1 : 0)
  if (excluded(a) !== excluded(b)) return excluded(a) - excluded(b)
  if (a.role && b.role && a.role !== b.role) {
    return ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)
  }
  if (!a.inProfile && a.filled !== b.filled) return b.filled - a.filled
  return a.fieldId.localeCompare(b.fieldId)
}

function sum(fields: ProfileFieldMeasure[], key: 'confirmed' | 'corrected' | 'manual'): number {
  return fields.reduce((total, field) => total + field[key], 0)
}
