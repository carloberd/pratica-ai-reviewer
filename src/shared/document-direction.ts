import { currentFieldValue } from './field-edits'
import type { ExtractedField } from './types'

/**
 * ## Emessa o ricevuta
 *
 * Non è un dato del documento: la stessa fattura è emessa per chi la scrive e ricevuta
 * per chi la paga. Si ricava confrontando le parti del documento con l'azienda di cui
 * sono i documenti, che è un'impostazione dell'app (`company_identity`).
 *
 * Per questo la direzione **non è un campo estratto**: non ha un'etichetta da cercare né
 * un'evidenza verbatim, e cambia se cambia l'impostazione. È un attributo del documento,
 * calcolato ogni volta da quello che il revisore ha confermato. Del revisore resta solo
 * la scelta, quando ne fa una: quella vince sempre e non si ricalcola.
 *
 * ### Come si decide
 *
 * 1. **Gli identificativi.** Partita IVA e codice fiscale dell'emittente contro quelli
 *    dell'azienda: se combaciano è `EMESSO`. Lo stesso col destinatario: `RICEVUTO`. I
 *    profili portano chiavi diverse a seconda del tipo — `*.vat_number` e `*.tax_code`
 *    sulla fattura (PR 1), `*.tax_id` sulla proforma e sulla nota di credito — e un
 *    `tax_id` può essere l'uno o l'altro, quindi si confronta con tutti e due.
 * 2. **Il nome**, solo se gli identificativi non hanno deciso niente. Il preventivo non
 *    ha nessun campo fiscale in profilo: senza il nome resterebbe sempre vuoto, ed è uno
 *    dei tipi che la nota chiede (`e017c573`). Il confronto ignora maiuscole, punti e
 *    forma societaria: «POLESINE MASSETTI SRLS» e «Polesine Massetti S.r.l.s.» sono la
 *    stessa azienda.
 * 3. **Se non decide nessuno dei due, o se decidono tutti e due**, la direzione resta
 *    vuota. Una fattura in cui l'azienda è sia emittente sia destinatario non è né emessa
 *    né ricevuta: è un caso da guardare, non da indovinare.
 *
 * ### E un valore ancora in conflitto?
 *
 * Conta come ogni altro, e non serve una regola sua. Dopo la PR 1 una «P.IVA» che
 * l'etichetta non attribuisce a nessuna parte finisce in `CONFLICT` su emittente **e**
 * destinatario con lo stesso valore: se è la nostra, la regola 3 la trova da tutte e due
 * le parti e non decide niente — che è esattamente quello che quel conflitto vuol dire.
 * Se non è la nostra, non decideva comunque. Scartare i `CONFLICT` a priori avrebbe
 * invece bloccato anche il caso opposto: il revisore risolve una delle due parti, l'altra
 * resta segnata in conflitto perché l'ha accettata comʼera, e la direzione non si
 * sarebbe più ricavata nemmeno a documento chiuso. La direzione si ricalcola a ogni
 * lettura, quindi si aggiorna mentre il revisore lavora.
 *
 * Modulo puro: nessun database, nessun registry.
 */

/** Per l'azienda di cui sono i documenti: `EMESSO` se l'ha scritto lei, `RICEVUTO` se lo riceve. */
export type DocumentDirection = 'EMESSO' | 'RICEVUTO'

/** La scelta del revisore: una direzione, oppure «né l'una né l'altra». */
export type DirectionChoice = DocumentDirection | 'NESSUNA'

export const DIRECTION_CHOICES: DirectionChoice[] = ['EMESSO', 'RICEVUTO', 'NESSUNA']

export function isDirectionChoice(value: unknown): value is DirectionChoice {
  return typeof value === 'string' && (DIRECTION_CHOICES as string[]).includes(value)
}

/** L'azienda di cui sono i documenti. Vuota finché il revisore non la scrive. */
export interface CompanyIdentity {
  name: string | null
  vatNumber: string | null
  taxCode: string | null
}

export const EMPTY_COMPANY: CompanyIdentity = { name: null, vatNumber: null, taxCode: null }

/**
 * I tipi che hanno una direzione: quelli che un'azienda emette o riceve. Su una visura o
 * su una carta d'identità la domanda non ha senso, e un campo vuoto in più su 500 tipi
 * sarebbe solo rumore.
 */
export const DIRECTIONAL_TYPES = [
  'accounting.fattura',
  'accounting.fattura_proforma',
  'accounting.nota_di_credito',
  'procurement.preventivo'
] as const

const DIRECTIONAL: ReadonlySet<string> = new Set(DIRECTIONAL_TYPES)

export function isDirectionalType(documentType: string | null | undefined): boolean {
  return typeof documentType === 'string' && DIRECTIONAL.has(documentType)
}

/** I campi fiscali di una parte, in tutte le forme che i profili usano oggi. */
const FISCAL_FIELDS = ['vat_number', 'tax_code', 'tax_id'] as const

/** Un identificativo fiscale confrontabile: niente spazi, punti, né il prefisso `IT`. */
export function foldIdentifier(value: string | null | undefined): string | null {
  if (!value) return null
  const folded = value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^IT(?=\d{11}$)/, '')
  return folded.length > 0 ? folded : null
}

/**
 * Forme societarie, con e senza punti: non distinguono due aziende, e il revisore le
 * scrive come capita.
 */
const LEGAL_FORMS =
  /\b(s\s?r\s?l\s?s?|s\s?p\s?a|s\s?n\s?c|s\s?a\s?s|s\s?s|s\s?c\s?a\s?r\s?l|soc(?:ieta)?\s+cooperativa|societa\s+semplice|impresa\s+individuale|ditta\s+individuale)\b/g

/** Un nome confrontabile: minuscolo, senza accenti, senza punteggiatura né forma societaria. */
export function foldCompanyName(value: string | null | undefined): string | null {
  if (!value) return null
  const plain = value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  const folded = plain.replace(LEGAL_FORMS, ' ').replace(/\s+/g, ' ').trim()
  return folded.length > 0 ? folded : null
}

/** Su cosa ha deciso il confronto: serve a spiegarlo, sulla scheda e nel dataset. */
export type DirectionMatch = 'FISCAL_ID' | 'NAME'

export interface ComputedDirection {
  direction: DocumentDirection
  matchedBy: DirectionMatch
}

/**
 * Il valore confermato di un campo singolo: la correzione del revisore, o la proposta del
 * motore se non l'ha toccata. È lo stesso valore che finisce nel dataset.
 */
function usableValue(fields: ExtractedField[], name: string): string | null {
  const field = fields.find((entry) => entry.name === name)
  if (!field || field.cardinality === 'many') return null
  return currentFieldValue(field)
}

function identifiersOf(fields: ExtractedField[], party: string): string[] {
  return FISCAL_FIELDS.map((key) => foldIdentifier(usableValue(fields, `${party}.${key}`))).filter(
    (value): value is string => value !== null
  )
}

function companyIdentifiers(company: CompanyIdentity): string[] {
  return [foldIdentifier(company.vatNumber), foldIdentifier(company.taxCode)].filter(
    (value): value is string => value !== null
  )
}

/**
 * La direzione che si ricava dal documento, o `null` se non si ricava. Non guarda la
 * scelta del revisore: quella la applica `directionOf`.
 */
export function computeDirection(input: {
  documentType: string | null
  company: CompanyIdentity
  fields: ExtractedField[]
}): ComputedDirection | null {
  if (!isDirectionalType(input.documentType)) return null

  const ours = companyIdentifiers(input.company)
  if (ours.length > 0) {
    const issuer = identifiersOf(input.fields, 'issuer').some((id) => ours.includes(id))
    const recipient = identifiersOf(input.fields, 'recipient').some((id) => ours.includes(id))
    if (issuer !== recipient) {
      return { direction: issuer ? 'EMESSO' : 'RICEVUTO', matchedBy: 'FISCAL_ID' }
    }
    // Tutti e due, o nessuno dei due: gli identificativi non hanno deciso. Se hanno
    // trovato l'azienda da entrambe le parti non decide nemmeno il nome.
    if (issuer && recipient) return null
  }

  const name = foldCompanyName(input.company.name)
  if (!name) return null
  const issuer = foldCompanyName(usableValue(input.fields, 'issuer.name')) === name
  const recipient = foldCompanyName(usableValue(input.fields, 'recipient.name')) === name
  if (issuer === recipient) return null
  return { direction: issuer ? 'EMESSO' : 'RICEVUTO', matchedBy: 'NAME' }
}

export interface DocumentDirectionState {
  /** La direzione che vale: la scelta del revisore, o quella calcolata. */
  value: DocumentDirection | null
  /** Quella calcolata dal documento, anche quando il revisore ha scelto altro. */
  computed: ComputedDirection | null
  /** `null` quando il tipo non ha una direzione o non si ricava niente. */
  chosenBy: 'REVIEWER' | 'ENGINE' | null
  /** La scelta del revisore comʼè: `NESSUNA` dice che l'ha guardata e non è né l'una né l'altra. */
  choice: DirectionChoice | null
}

/** Che direzione ha un documento adesso: la scelta del revisore vince sul calcolo. */
export function directionOf(input: {
  documentType: string | null
  company: CompanyIdentity
  fields: ExtractedField[]
  choice: DirectionChoice | null
}): DocumentDirectionState {
  if (!isDirectionalType(input.documentType)) {
    return { value: null, computed: null, chosenBy: null, choice: null }
  }
  const computed = computeDirection(input)
  if (input.choice !== null) {
    return {
      value: input.choice === 'NESSUNA' ? null : input.choice,
      computed,
      chosenBy: 'REVIEWER',
      choice: input.choice
    }
  }
  return {
    value: computed?.direction ?? null,
    computed,
    chosenBy: computed ? 'ENGINE' : null,
    choice: null
  }
}
