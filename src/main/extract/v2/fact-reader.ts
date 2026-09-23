import { findTextualDate } from '@shared/date-value'
import {
  type ClassExtractionProfile,
  type ExtractedFactV2,
  type ExtractionEvidenceV2,
  type ExtractionResultV2,
  type FieldOntologyEntry,
  type FieldRole,
  piiOf
} from '@shared/extraction-v2'
import { isRegistryField } from '@shared/fields'
import type { AnchorRelation, LearningRuleScope } from '@shared/local-learning'
import { cardinalityOf } from '@shared/profile-overlay'
import { TRAINING_EXPIRY_FIELD, trainingExpiryOf } from '@shared/training-expiry'
import type { BoundingBox } from '@shared/types'
import { FIELD_SPECS, findDate, findMoney, fold, OCR_PENALTY } from '../heuristics'
import { precededByReference, readsReferences } from '../reference-context'
import type { ExtractedPage, TextLine } from '../types'
import type { ExtractionRegistry } from './profile-loader'
import { runFieldValidator, validatorsOf } from './validators'

/**
 * Precompilazione v2: un profilo di campi per tipo documento, regole fisse, nessun LLM.
 *
 * La regola della v1 resta quella che governa tutto: nessun valore senza evidenza
 * verbatim. Cambia cosa si cerca — i campi del profilo del tipo, non un set universale
 * — e come si legge il valore:
 *
 * - l'etichetta si cerca a confini di parola; il valore sta subito dopo sulla stessa
 *   riga oppure, se la riga finisce con l'etichetta, sulla riga successiva;
 * - il lettore dipende dal tipo del campo nell'ontologia: date in `yyyy-mm-dd`, importi
 *   con due decimali, interi e decimali senza separatori delle migliaia, identificativi
 *   come token; il testo libero vuole i due punti subito dopo l'etichetta;
 * - le etichette sono quelle degli hint v2 e dell'ontologia, più le keyword v1 dei campi
 *   legacy che la mappa porta su quell'id: gli hint generati per i profili sono in parte
 *   generici («Data emissione») e da soli perderebbero quello che la v1 già leggeva;
 * - un'etichetta più lunga batte una più corta, anche fra campi diversi: la stessa riga
 *   con lo stesso valore non può essere il numero di protocollo e il numero documento,
 *   e se nessuna etichetta è più specifica il campo va in CONFLICT. L'eccezione sono
 *   partita IVA e codice fiscale della stessa parte, che possono essere lo stesso numero
 *   sulla stessa riga (`fiscalTwinOf`). Una riga già presa da un'etichetta più specifica
 *   non è nemmeno un secondo candidato per un altro campo: «IBAN ordinante» è il conto di
 *   addebito, e l'IBAN del beneficiario resta uno solo;
 * - una riga che è soltanto l'etichetta di un campo del profilo non è il valore di nessuno:
 *   su una carta d'identità a cui l'OCR ha perso il cognome, «COGNOME / SURNAME» seguita da
 *   «NOME / NAME» lascia il cognome vuoto invece di dargli l'etichetta del nome;
 * - i campi `many` raccolgono un elemento per riga, in ordine di documento;
 * - un solo valore non si legge ma si deduce: la scadenza di un attestato di formazione,
 *   quando il documento non la scrive e il corso è in tabella (`@shared/training-expiry`).
 *   Porta `computed`, non ha evidenza, e una scadenza scritta sul documento vince sempre;
 * - le etichette imparate dalle revisioni (`learnedLabels`) passano davanti a quelle del
 *   registry, quelle di un template davanti a quelle di un tipo: a parità di livello decide
 *   ancora la lunghezza. I validatori restano l'ultima parola per tutte: quelli
 *   dell'ontologia, o quelli che il profilo del tipo mette al loro posto
 *   (`field_validator_overrides`).
 */

export const CONFIDENCE_SAME_LINE = 0.85
export const CONFIDENCE_NEXT_LINE = 0.8
/**
 * Un valore dedotto non è mai accettato da solo: sta sotto `AUTO_ACCEPT_THRESHOLD`, così
 * arriva al revisore come NEEDS_REVIEW. Il motore lo propone, non lo afferma.
 */
export const CONFIDENCE_COMPUTED = 0.6
export const VALIDATOR_PENALTY = 0.18
/** Sotto questa confidence un valore va comunque rivisto. */
export const AUTO_ACCEPT_THRESHOLD = 0.85

/** Caratteri ammessi fra l'etichetta e l'inizio di un valore tipizzato. */
const VALUE_WINDOW = 40
/** Sulla riga successiva il valore deve stare in testa. */
const NEXT_LINE_WINDOW = 10
const MAX_TEXT_VALUE = 200

/** Un'etichetta imparata da una regola attiva, già filtrata per tipo e template. */
export interface LearnedLabel {
  ruleId: string
  fieldId: string
  /** Ripiegata come `fold`. */
  label: string
  relation: AnchorRelation
  scope: LearningRuleScope
}

export interface ExtractFactsInput {
  documentType: string
  pages: ExtractedPage[]
  registry: ExtractionRegistry
  /**
   * Pagine il cui testo viene da OCR: la confidence dei loro campi scende di 0,10 come
   * nella v1. Un allegato scansionato non declassa i campi letti dal text layer.
   */
  ocrPages?: number[]
  /** Le etichette delle regole apprese che valgono per questo documento. */
  learnedLabels?: LearnedLabel[]
}

// ---------------------------------------------------------------------------
// Etichette
// ---------------------------------------------------------------------------

interface FoldedLine {
  folded: string
  /** Per ogni carattere di `folded`, l'indice del carattere originale da cui viene. */
  origin: number[]
}

/** Come `fold` della v1, ma ricorda da dove viene ogni carattere. */
export function foldWithOrigin(text: string): FoldedLine {
  let folded = ''
  const origin: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const base = (text[index] ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    for (const char of base) {
      if (/[a-z0-9]/.test(char)) {
        folded += char
        origin.push(index)
      } else if (folded.length > 0 && !folded.endsWith(' ')) {
        folded += ' '
        origin.push(index)
      }
    }
  }
  if (folded.endsWith(' ')) {
    folded = folded.slice(0, -1)
    origin.pop()
  }
  return { folded, origin }
}

/** Un'occorrenza dell'etichetta: `[inizio, fine)` nel testo originale, e dove comincia nel folded. */
interface LabelOccurrence {
  start: number
  end: number
  foldedStart: number
}

/** Posizioni dell'etichetta a confini di parola. */
function labelOccurrences(line: FoldedLine, label: string): LabelOccurrence[] {
  const padded = ` ${line.folded} `
  const needle = ` ${label} `
  const found: LabelOccurrence[] = []
  for (let at = padded.indexOf(needle); at !== -1; at = padded.indexOf(needle, at + 1)) {
    const start = line.origin[at]!
    const end = line.origin[at + label.length - 1]! + 1
    found.push({ start, end, foldedStart: at })
  }
  return found
}

/** Un'etichetta da cercare, col livello che decide chi vince fra due letture. */
interface LabelSource {
  label: string
  /** 0 registry, 1 regola appresa di tipo, 2 regola appresa di template. */
  tier: number
  ruleId?: string
  /** Assente per il registry: stessa riga, e se non c'è niente la riga successiva. */
  relation?: AnchorRelation
  /** L'ambito della regola in `ruleId`, che l'evidenza si porta dietro come provenienza. */
  scope?: LearningRuleScope
}

const TIER: Record<LearningRuleScope, number> = { CLASS: 1, TEMPLATE: 2 }

function labelsFor(
  fieldId: string,
  spec: FieldOntologyEntry,
  registry: ExtractionRegistry,
  learned: LearnedLabel[]
): LabelSource[] {
  const legacyKeywords = registry
    .legacyNames(fieldId)
    .flatMap((name) => (isRegistryField(name) ? FIELD_SPECS[name].keywords : []))
  const all = [
    ...registry.hints(fieldId),
    spec.label_it,
    ...spec.label_aliases_it,
    ...legacyKeywords
  ]
  const byLabel = new Map<string, LabelSource>()
  for (const label of all.map(fold).filter((label) => label.length > 0)) {
    byLabel.set(label, { label, tier: 0 })
  }
  // Un'etichetta imparata che il registry ha già vale col livello più alto.
  for (const rule of learned.filter((entry) => entry.fieldId === fieldId)) {
    const label = fold(rule.label)
    const tier = TIER[rule.scope]
    if (label.length === 0 || (byLabel.get(label)?.tier ?? -1) >= tier) continue
    byLabel.set(label, {
      label,
      tier,
      ruleId: rule.ruleId,
      relation: rule.relation,
      scope: rule.scope
    })
  }
  return [...byLabel.values()].sort((a, b) => b.tier - a.tier || b.label.length - a.label.length)
}

// ---------------------------------------------------------------------------
// Lettori di valori, per tipo
// ---------------------------------------------------------------------------

/**
 * `after-twin` è la stessa riga, ma dopo che l'etichetta è stata ripetuta in un'altra
 * lingua: «COGNOME/SURNAME ROSSI». Lì i due punti non arrivano mai, e pretenderli
 * lascerebbe vuoto un campo che si legge a occhio.
 */
type ReadMode = 'same-line' | 'next-line' | 'after-twin'

/** Primo match che comincia entro `window` caratteri. */
function within(text: string, raw: string | undefined, window: number): boolean {
  if (!raw) return false
  const at = text.indexOf(raw)
  return at !== -1 && at <= window
}

/** `12 settembre 2026` -> `2026-09-12`, oltre ai formati numerici letti dalla v1. */
export function readDate(text: string, window: number): string | null {
  const numeric = findDate(text)
  if (numeric && within(text, numeric.raw, window)) return numeric.value

  const textual = findTextualDate(text)
  return textual && textual.index <= window ? textual.value : null
}

export function readMoney(text: string, window: number): string | null {
  const money = findMoney(text)
  return money && within(text, money.raw, window) ? money.value : null
}

/**
 * Da `1.250` (migliaia), `12,5` o `1.234,56` a un decimale con il punto.
 *
 * Con un solo separatore: la virgola è decimale; il punto è delle migliaia solo se
 * seguito da esattamente tre cifre, come si scrive in italiano.
 */
export function parseDecimal(raw: string): string | null {
  let cleaned = raw.replace(/\s/g, '')
  const commas = (cleaned.match(/,/g) ?? []).length
  const dots = (cleaned.match(/\./g) ?? []).length

  if (commas > 0 && dots > 0) {
    const decimal = cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.') ? ',' : '.'
    const grouping = decimal === ',' ? '.' : ','
    cleaned = cleaned.split(grouping).join('').replace(decimal, '.')
  } else if (commas > 0) {
    cleaned = commas > 1 ? cleaned.split(',').join('') : cleaned.replace(',', '.')
  } else if (dots > 1 || /^-?\d{1,3}\.\d{3}$/.test(cleaned)) {
    cleaned = cleaned.split('.').join('')
  }

  const value = Number(cleaned)
  return Number.isFinite(value) && /\d/.test(cleaned) ? String(value) : null
}

export function readNumber(text: string, window: number): string | null {
  const match = /-?\d+(?:[.,]\d+|\s\d{3}(?!\d))*/.exec(text)
  if (!match || match.index > window) return null
  return parseDecimal(match[0].trim())
}

/** Un intero: `1.250` vale 1250, `12,5` non è un intero e resta vuoto. */
export function readInteger(text: string, window: number): string | null {
  const match = /(-?\d{1,3}(?:[.\s]\d{3})+|-?\d+)([.,]\d+)?/.exec(text)
  if (!match || match.index > window || match[2]) return null
  const value = Number((match[1] ?? '').replace(/[.\s]/g, ''))
  return Number.isSafeInteger(value) ? String(value) : null
}

/**
 * Una percentuale nella convenzione del registry (`scale: "0_100"`): il numero come sta
 * scritto, dove 3,5 è il tre e mezzo per cento. Fuori da quell'intervallo non è una
 * percentuale di questa convenzione — un importo finito accanto a un'aliquota lo era — e
 * il campo resta vuoto invece di portarsi dietro un numero che nessuno sa più leggere.
 */
export function readPercentage(text: string, window: number): string | null {
  const value = readNumber(text, window)
  if (value === null) return null
  const number = Number(value)
  return number >= 0 && number <= 100 ? value : null
}

/**
 * Come i documenti scrivono la valuta prima che diventi un codice ISO 4217: il simbolo, il
 * nome per esteso, la sigla in minuscolo. Sono le forme che i documenti portano davvero,
 * non tutte quelle immaginabili.
 */
const CURRENCY_WORDS: Record<string, string> = {
  '€': 'EUR',
  euro: 'EUR',
  eur: 'EUR',
  $: 'USD',
  dollaro: 'USD',
  dollari: 'USD',
  usd: 'USD',
  '£': 'GBP',
  sterlina: 'GBP',
  sterline: 'GBP',
  gbp: 'GBP',
  franchi: 'CHF',
  franco: 'CHF',
  chf: 'CHF'
}

/**
 * La valuta, normalizzata prima del confronto con l'enum del campo: «€», «euro» e «EURO»
 * sono tutti `EUR`. Un codice che l'enum non ha non è il valore di questo campo: il campo
 * resta vuoto e chi rivede lo vede, invece che una stringa libera che il template non sa
 * dove mettere.
 */
export function readCurrency(text: string, allowed: readonly string[]): string | null {
  const token = /[\p{L}€$£]+/u.exec(text.replace(/^[\s:=]+/, ''))?.[0]
  const symbol = /[€$£]/.exec(text)?.[0]
  const raw = token ?? symbol
  if (!raw) return null
  const code = CURRENCY_WORDS[raw.toLowerCase()] ?? (symbol ? CURRENCY_WORDS[symbol] : undefined)
  const candidate = code ?? raw.toUpperCase()
  return allowed.includes(candidate) ? candidate : null
}

function readBoolean(text: string): string | null {
  const trimmed = text.replace(/^[\s:=]+/, '')
  if (/^(s[iì]|yes|true|vero)\b/i.test(trimmed)) return 'true'
  if (/^(no|false|falso)\b/i.test(trimmed)) return 'false'
  return null
}

/**
 * Partita IVA, anche col prefisso `IT` attaccato, o codice fiscale di una persona, anche
 * omocodico (lettere `LMNPQRSTUV` al posto delle cifre). Se è giusto lo dicono i validatori.
 */
const TAX_ID =
  /\b(?:IT)?(\d{11})\b|\b([A-Z]{6}[\dLMNPQRSTUV]{2}[A-Z][\dLMNPQRSTUV]{2}[A-Z][\dLMNPQRSTUV]{3}[A-Z])\b/i
/** Solo partita IVA: un codice fiscale di persona accanto non è il valore di questo campo. */
const VAT_NUMBER = /\b(?:IT)?(\d{11})\b/i
const IBAN = /\b([A-Za-z]{2}\d{2}(?:\s?[A-Za-z0-9]){11,30})\b/
/**
 * Numero REA: la sigla della provincia e il numero, «RO - 160649», o il numero da solo.
 * Deve stare in testa, e un numero seguito da `/` o `.` e altre cifre è l'inizio di una
 * data («Data iscrizione REA 12/03/2010»), non il REA. La sigla è in maiuscolo, come la
 * stampa la visura: così «nr 160649» non diventa la provincia `NR`.
 */
const REA_NUMBER = /^(?:([A-Z]{2})\s*[-–]?\s*)?(\d{1,7})(?!\d|[/.,]\d)/

/**
 * CIG e CUP: un blocco alfanumerico di lunghezza fissa, dieci caratteri il primo e quindici
 * il secondo. La lunghezza è tutta la forma che hanno, ed è anche quello che li separa: su
 * un ordine che li scrive uno accanto all'altro, la lettura per token prenderebbe il primo
 * dei due per tutti e due.
 */
const CIG_CODE = /\b([A-Za-z0-9]{10})\b/
const CUP_CODE = /\b([A-Za-z0-9]{15})\b/

/**
 * Identificativo subito dopo l'etichetta: «Protocollo n. 2026/554321», «Documento n.
 * CC-2026-018». Deve contenere almeno una cifra e non essere una data.
 */
export function readIdentifier(text: string, format: string | null | undefined): string | null {
  if (format === 'tax_id' || format === 'italian_tax_code') {
    const match = TAX_ID.exec(text)
    const id = match?.[1] ?? match?.[2]
    return match && id && match.index <= VALUE_WINDOW ? id.toUpperCase() : null
  }
  if (format === 'vat_number') {
    const match = VAT_NUMBER.exec(text)
    return match?.[1] && match.index <= VALUE_WINDOW ? match[1] : null
  }
  if (format === 'rea_number') {
    const rest = text.replace(/^[\s:=°#.\-–—]+/, '')
    // Prima con quello che c'è, poi senza «n.»: «NO - 123456» è Novara, non «numero».
    const match =
      REA_NUMBER.exec(rest) ??
      REA_NUMBER.exec(rest.replace(/^(?:n|nr|no|num|numero)\b\.?\s*[:°]?\s*/i, ''))
    if (!match?.[2]) return null
    // La forma in cui la scrive la visura, e in cui la trascrive il revisore: «RO - 160649».
    return match[1] ? `${match[1]} - ${match[2]}` : match[2]
  }
  if (format === 'cig' || format === 'cup') {
    const match = (format === 'cig' ? CIG_CODE : CUP_CODE).exec(text)
    const code = match?.[1]
    // Almeno una cifra, come per ogni identificativo: «comunicare» ha dieci lettere e
    // sarebbe un CIG a norma di lunghezza.
    if (!code || match.index > VALUE_WINDOW || !/\d/.test(code)) return null
    return code.toUpperCase()
  }
  if (format === 'iban') {
    const match = IBAN.exec(text)
    return match?.[1] && match.index <= VALUE_WINDOW
      ? match[1].replace(/\s/g, '').toUpperCase()
      : null
  }
  // Il conto da cui parte un bonifico è scritto come IBAN o come numero di rapporto: se è
  // un IBAN va letto intero anche a gruppi di quattro, altrimenti vale la lettura per
  // token, che di «IT60 X054 2811 …» terrebbe solo `IT60`.
  if (format === 'account_number') {
    const match = IBAN.exec(text)
    if (match?.[1] && match.index <= VALUE_WINDOW) return match[1].replace(/\s/g, '').toUpperCase()
  }

  const unprefixed = text.replace(/^[\s.\-–—]+/, '')
  const rest = unprefixed
    .replace(/^[:=°#]+\s*/, '')
    .replace(/^(?:n|nr|no|num|numero)\b\.?\s*[:°]?\s*/i, '')
  const token = /^[A-Za-z0-9][A-Za-z0-9/._-]*/.exec(rest)?.[0]?.replace(/[._/-]+$/, '')
  if (!token || !/\d/.test(token)) return null
  if (findDate(token)?.raw === token) return null
  // Una cifra sola dopo un'etichetta nuda è più spesso un contatore che un numero di
  // documento («NUMBER 0 1»): vale solo se annunciata da due punti o da «n.».
  if (token.length < 2 && rest === unprefixed) return null
  return format === 'vehicle_plate' || format === 'vin' ? token.toUpperCase() : token
}

/**
 * Testo libero: sulla stessa riga solo dopo i due punti che seguono l'etichetta, sulla
 * riga successiva l'intera riga, purché non sia a sua volta un'etichetta con valore.
 */
function readText(text: string, mode: ReadMode): string | null {
  let value: string
  if (mode === 'same-line') {
    const colon = /^\s*[:=]\s*/.exec(text)
    if (!colon) return null
    value = text.slice(colon[0].length).trim()
  } else {
    value = text.trim()
    const colon = value.indexOf(':')
    if (colon !== -1 && colon < VALUE_WINDOW) return null
  }
  // `/Nome e cognome` è la coda di un'etichetta composta — «Ragione sociale/Nome e
  // cognome» andata a capo sulla barra — non il valore della sua prima metà.
  if (/^[\\/]/.test(value)) return null
  return value.length > 0 && value.length <= MAX_TEXT_VALUE ? value : null
}

/** Numeri di documento e protocollo sono `string` nell'ontologia, ma si leggono come id. */
function readsAsIdentifier(fieldId: string, spec: FieldOntologyEntry): boolean {
  return spec.type === 'identifier' || /(^|\.|_)(number|protocol_number)$/.test(fieldId)
}

function readValue(
  fieldId: string,
  spec: FieldOntologyEntry,
  text: string,
  mode: ReadMode
): string | null {
  const window = mode === 'next-line' ? NEXT_LINE_WINDOW : VALUE_WINDOW
  if (readsAsIdentifier(fieldId, spec)) return readIdentifier(text, spec.format)
  // Un campo chiuso si legge nel suo vocabolario: la valuta, l'unico che ne ha uno oggi.
  if (spec.format === 'currency') return readCurrency(text, spec.enum ?? [])
  switch (spec.type) {
    case 'date':
      return readDate(text, window)
    case 'money':
      return readMoney(text, window)
    case 'number':
      return spec.scale === '0_100' ? readPercentage(text, window) : readNumber(text, window)
    case 'integer':
      return readInteger(text, window)
    case 'boolean':
      return readBoolean(text)
    default:
      return readText(text, mode)
  }
}

// ---------------------------------------------------------------------------
// Candidati
// ---------------------------------------------------------------------------

interface Candidate {
  fieldId: string
  value: string
  confidence: number
  /** Livello dell'etichetta: una regola appresa batte il registry. */
  tier: number
  /** Lunghezza dell'etichetta ripiegata: più è lunga, più è specifica. */
  labelLength: number
  sameLine: boolean
  validatorsFailed: string[]
  evidence: ExtractionEvidenceV2
  /** Pagina e riga del valore, per riconoscere due campi che leggono la stessa cosa. */
  position: { page: number; line: number }
}

function unionBox(a: BoundingBox | undefined, b: BoundingBox | undefined): BoundingBox | undefined {
  if (!a || !b) return a ?? b
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y
  }
}

function pageLines(page: ExtractedPage): TextLine[] {
  if (page.lines.length > 0) return page.lines
  return page.text
    .split(/\r?\n/)
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text) => ({ text }))
}

/**
 * Un identificativo fiscale completo in coda: partita IVA, anche col prefisso `IT`, o
 * codice fiscale.
 */
const TRAILING_TAX_ID = /\b(?:(?:IT)?\d{11}|[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z])$/i

/**
 * Un testo libero con l'etichetta a metà frase non è un'etichetta: «Codice cliente: 12».
 *
 * Un'eccezione, stretta: il generatore PDF fonde `P.IVA 01234567890` con l'intestazione
 * della colonna accanto, e ne esce `P.IVA 01234567890 DESTINATARIO`. Quell'etichetta vale
 * solo se chiude la riga — il valore sta sotto — e la precede un identificativo intero, non
 * un pezzo di frase.
 */
function startsSegment(text: string, start: number, end: number): boolean {
  const before = text.slice(0, start).trimEnd()
  if (before === '' || /[-–—|;•(]$/.test(before)) return true
  return text.slice(end).trim() === '' && TRAILING_TAX_ID.test(before)
}

/**
 * La riga finisce con l'etichetta, e il valore sta sotto.
 *
 * Vale quando dopo l'etichetta non resta che punteggiatura, ma anche quando resta la
 * **stessa etichetta in un'altra lingua**: i documenti d'identità le scrivono appaiate,
 * «COGNOME/SURNAME», «CITTADINANZA/NATIONALITY», «NOME/GIVEN NAMES/PRÉNOMS», e il valore
 * è sulla riga successiva. Senza questa eccezione la coda inglese fa sembrare la riga
 * «già piena» e il valore sotto non viene nemmeno cercato: su una carta d'identità è la
 * differenza fra leggere tre campi su dodici e leggerne nove.
 *
 * Il controllo è stretto di proposito: ogni pezzo dopo la barra dev'essere un'etichetta
 * che il registry già dichiara **per lo stesso campo**. Una coda qualsiasi resterebbe
 * un'intestazione di colonna, e la riga sotto il suo primo dato.
 */
function endsLabelLine(remainder: string, twins: ReadonlySet<string>): boolean {
  if (/^[\s:=.°#\-–—]*$/.test(remainder)) return true
  const rest = remainder.replace(/^[\s:=.°#\-–—]+/, '')
  if (!rest.startsWith('/') && !rest.startsWith('\\')) return false
  const parts = rest.split(/[/\\]/).filter((part) => part.trim().length > 0)
  return parts.length > 0 && parts.every((part) => twins.has(fold(part)))
}

/**
 * Dove finisce la coda dell'etichetta ripetuta in un'altra lingua, o -1 se non c'è.
 *
 * «COGNOME» seguito da «/SURNAME» o da «/SURNAME/NOM»: ogni pezzo dopo la barra dev'essere
 * un'etichetta che il registry dichiara per lo stesso campo, e si consuma la più lunga che
 * combacia, così «/GIVEN NAMES MARIO» lascia fuori il valore.
 */
function twinTailEnd(remainder: string, twins: ReadonlySet<string>): number {
  let at = 0
  let end = -1
  for (;;) {
    const separator = /^[\s:=.°#\-–—]*[/\\]\s*/.exec(remainder.slice(at))
    if (!separator) return end
    const after = at + separator[0].length
    const folded = foldWithOrigin(remainder.slice(after))
    let longest = -1
    for (const twin of twins) {
      if (twin.length <= longest) continue
      if (folded.folded === twin || folded.folded.startsWith(`${twin} `)) longest = twin.length
    }
    if (longest === -1) return end
    at = after + folded.origin[longest - 1]! + 1
    end = at
  }
}

/**
 * Una parola bilingue: `SESSO/SEX`, `STATURA/HEIGHT`. Lettere da una parte e dall'altra,
 * almeno tre per lato, così `VIA ROMA 1/A` e `01/01/1980` non lo sono.
 */
const BILINGUAL_WORD = /(?:^|\s)(\p{L}{3,}[/\\]\p{L}{3,})/u

/**
 * Il valore si ferma dove comincia la colonna successiva.
 *
 * Su una scansione l'OCR fonde le colonne in una riga sola — «COGNOME/SURNAME ROSSI
 * NOME/NAME MARIO», «CITTADINANZA/NATIONALITY ITA SESSO/SEX M» — e senza questo taglio il
 * primo campo si porterebbe via tutta la riga. Due cose la aprono: l'etichetta di un altro
 * campo del profilo, e una parola bilingue, che è come questi moduli scrivono le
 * intestazioni anche dove il profilo non ha un campo corrispondente («sesso», «statura»).
 */
function cutAtNextColumn(text: string, labels: ReadonlySet<string>): string {
  const folded = foldWithOrigin(text)
  let cut = text.length
  for (const label of labels) {
    for (const occurrence of labelOccurrences(folded, label)) {
      if (occurrence.start > 0 && occurrence.start < cut) cut = occurrence.start
    }
  }
  const bilingual = BILINGUAL_WORD.exec(text)
  if (bilingual) {
    const start = bilingual.index + bilingual[0].length - bilingual[1]!.length
    if (start > 0 && start < cut) cut = start
  }
  return text.slice(0, cut)
}

/** Gli importi che compaiono in un testo, in ordine, con dove comincia ognuno. */
function moneyRuns(text: string): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = []
  let offset = 0
  for (let guard = 0; guard < 8; guard += 1) {
    const money = findMoney(text.slice(offset))
    if (!money) break
    const at = text.slice(offset).indexOf(money.raw)
    if (at === -1) break
    runs.push({ start: offset + at, end: offset + at + money.raw.length })
    offset += at + money.raw.length
  }
  return runs
}

/**
 * La riga è una riga di tabella, e quale colonna sia questo campo non si sa.
 *
 * Il riepilogo IVA di una fattura mette aliquota, imponibile e imposta in colonna:
 *
 * ```
 * Aliquota IVA 10%                   2.051,00            205,10
 * ```
 *
 * L'etichetta «iva» aggancia, e prendere il primo importo dà 2.051,00 — l'imponibile
 * scambiato per l'imposta, accettato da solo perché la lettura sulla stessa riga vale
 * 0,85. Due importi separati da uno stacco di colonna dicono che la riga è una tabella:
 * lì il campo resta vuoto, che è meno peggio di un numero sbagliato.
 *
 * Un valore seguito dall'etichetta di un altro campo non è questo caso: «Imponibile
 * 1.000,00 Imposta 220,00» si taglia prima, e di importi ne resta uno solo.
 */
function columnAmbiguous(text: string): boolean {
  const runs = moneyRuns(text)
  if (runs.length < 2) return false
  return runs.slice(1).some((run, index) => /\s{3,}/.test(text.slice(runs[index]!.end, run.start)))
}

/** Una lettura di un'etichetta: dove compare, e il valore che si legge dopo. */
export interface LabelRead {
  /** Riga dell'etichetta e riga del valore, indici in `lines`. */
  line: number
  valueLine: number
  sameLine: boolean
  /** Dove finisce l'etichetta nel testo della sua riga. */
  labelEnd: number
  value: string
}

function readsInLines(
  fieldId: string,
  spec: FieldOntologyEntry,
  lines: TextLine[],
  folded: FoldedLine[],
  label: string,
  relation: AnchorRelation | undefined,
  /** Le altre etichette dello stesso campo, ripiegate: le lingue in cui il modulo lo chiama. */
  twins: ReadonlySet<string>,
  /** Le etichette di tutti i campi del profilo: dove il valore di questo finisce. */
  bareLabels: ReadonlySet<string>
): LabelRead[] {
  const isText = !readsAsIdentifier(fieldId, spec) && ['string', 'object'].includes(spec.type)
  const citing = readsReferences(
    [spec.label_it, ...spec.label_aliases_it].map((label) => foldWithOrigin(label).folded)
  )
  const reads: LabelRead[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    for (const { start, end, foldedStart } of labelOccurrences(folded[index]!, label)) {
      const remainder = line.text.slice(end)
      const twinEnd = twinTailEnd(remainder, twins)
      // Un'etichetta a metà riga è quasi sempre prosa — «Codice cliente: 12» — e non conta.
      // Ma se è ripetuta in un'altra lingua è l'intestazione della colonna accanto, che
      // l'OCR ha fuso con la prima: «COGNOME/SURNAME ROSSI NOME/NAME MARIO».
      if (isText && twinEnd === -1 && !startsSegment(line.text, start, end)) continue
      if (!citing && precededByReference(folded[index]!.folded, foldedStart, label)) continue

      // Un importo si legge solo fino a dove comincia il campo accanto, e non si legge
      // affatto se la riga è una tabella a colonne.
      const sameLineText =
        spec.type === 'money' ? cutAtNextColumn(remainder, bareLabels) : remainder
      const sameLine =
        relation === 'next-line' || (spec.type === 'money' && columnAmbiguous(sameLineText))
          ? null
          : readValue(fieldId, spec, sameLineText, 'same-line')
      if (sameLine !== null) {
        reads.push({
          line: index,
          valueLine: index,
          sameLine: true,
          labelEnd: end,
          value: sameLine
        })
        continue
      }
      // «COGNOME/SURNAME ROSSI»: l'etichetta è ripetuta in un'altra lingua e poi c'è il
      // valore, senza i due punti che il testo libero pretende. Si legge quello che resta
      // dopo la coda, fermandosi all'etichetta del campo accanto.
      if (
        relation !== 'next-line' &&
        twinEnd !== -1 &&
        remainder.slice(twinEnd).trim().length > 0
      ) {
        const afterTwin = readValue(
          fieldId,
          spec,
          cutAtNextColumn(remainder.slice(twinEnd), bareLabels),
          'after-twin'
        )
        if (afterTwin !== null) {
          reads.push({
            line: index,
            valueLine: index,
            sameLine: true,
            labelEnd: end + twinEnd,
            value: afterTwin
          })
          continue
        }
      }

      if (relation !== 'same-line' && endsLabelLine(remainder, twins) && index + 1 < lines.length) {
        const nextLine = readValue(fieldId, spec, lines[index + 1]!.text, 'next-line')
        if (nextLine !== null) {
          reads.push({
            line: index,
            valueLine: index + 1,
            sameLine: false,
            labelEnd: end,
            value: nextLine
          })
        }
      }
    }
  }
  return reads
}

/**
 * Tutte le letture di un'etichetta sulle righe di una pagina, con le regole
 * dell'estrazione: confini di parola, lettore del tipo del campo, stessa riga o riga
 * successiva. `relation` limita la lettura a una delle due. È quello che serve per sapere
 * se un'etichetta imparata leggerebbe davvero il valore che il revisore ha selezionato.
 */
export function readsOfLabel(
  fieldId: string,
  spec: FieldOntologyEntry,
  lines: TextLine[],
  label: string,
  relation?: AnchorRelation
): LabelRead[] {
  const folded = lines.map((line) => foldWithOrigin(line.text))
  // Nessuna gemella: qui si verifica un'etichetta candidata da sola, e una lettura in più
  // aperta da un'altra lingua farebbe scartare un'ancora che invece è buona.
  return readsInLines(fieldId, spec, lines, folded, fold(label), relation, new Set(), new Set())
}

/**
 * La parte di cui parla un campo: `issuer.name` è dell'emittente, `recipient.vat_number`
 * del destinatario. Gli altri campi non hanno parte e nessuna sezione li riguarda.
 */
function partyOf(fieldId: string, parties: ReadonlySet<string>): string | null {
  const dot = fieldId.indexOf('.')
  if (dot === -1) return null
  const prefix = fieldId.slice(0, dot)
  return parties.has(prefix) ? prefix : null
}

/**
 * La parte di cui parla ogni riga, propagata da un'intestazione alla successiva.
 *
 * Una fattura elettronica resa dallo stilo SdI scrive due volte le stesse etichette, una
 * per parte:
 *
 * ```
 * Cedente prestatore (fornitore)
 * Denominazione: ALFA S.R.L.
 * Cessionario committente (cliente)
 * Denominazione: BETA S.P.A.
 * ```
 *
 * «Denominazione» da sola non distingue l'emittente dal destinatario — è la stessa parola,
 * con la stessa specificità — e senza sezione i due campi restano vuoti tutti e due. Con
 * la sezione ognuno legge la riga che gli tocca.
 *
 * Una riga che apre due parti insieme — le due intestazioni affiancate, come le stampano
 * i moduli a due colonne — non apre nessuna sezione: lì la parte dipende dalla colonna, e
 * il lettore le colonne non le separa. Meglio nessuna sezione che quella sbagliata.
 */
export function sectionsOfLines(
  folded: FoldedLine[],
  sections: ReadonlyArray<{ party: string; label: string }>
): Array<string | null> {
  let current: string | null = null
  return folded.map((line) => {
    const opened = new Set<string>()
    for (const section of sections) {
      // Solo una riga che è **soltanto** l'intestazione apre la sezione. «Destinatario:
      // Beta S.p.A.» è un'etichetta con il suo valore, non l'inizio di un blocco: presa
      // per intestazione si porterebbe dentro tutte le righe che seguono.
      if (line.folded === section.label) opened.add(section.party)
    }
    if (opened.size === 1) current = [...opened][0]!
    else if (opened.size > 1) current = null
    return current
  })
}

function candidatesForField(
  fieldId: string,
  spec: FieldOntologyEntry,
  labels: LabelSource[],
  pages: ExtractedPage[],
  fromOcr: Set<number>,
  bareLabels: ReadonlySet<string>,
  sections: ReadonlyArray<{ party: string; label: string }>,
  parties: ReadonlySet<string>
): Candidate[] {
  // Per ogni riga del valore resta solo il candidato con l'etichetta più specifica.
  const best = new Map<string, Candidate>()
  // Tutte le etichette di questo campo: servono a riconoscere «COGNOME/SURNAME» come una
  // riga che finisce con l'etichetta, non come una riga che ha già il suo valore.
  const twins = new Set(labels.map((source) => source.label))

  const party = partyOf(fieldId, parties)

  for (const page of pages) {
    const penalty = fromOcr.has(page.page) ? OCR_PENALTY : 0
    const lines = pageLines(page)
    const folded = lines.map((line) => foldWithOrigin(line.text))
    const lineParty = party === null ? null : sectionsOfLines(folded, sections)

    for (const source of labels) {
      for (const read of readsInLines(
        fieldId,
        spec,
        lines,
        folded,
        source.label,
        source.relation,
        twins,
        bareLabels
      )) {
        const { value, sameLine } = read
        // La riga sotto è l'etichetta di un altro campo: il valore di questa manca.
        if (!sameLine && bareLabels.has(folded[read.valueLine]!.folded)) continue
        // La riga è nella sezione di un'altra parte: quel valore non è di questo campo.
        // Fuori da ogni sezione (`null`) il documento non dichiara le parti, e vale tutto.
        const at = lineParty?.[read.valueLine] ?? null
        if (at !== null && at !== party) continue
        const failed = spec.validators
          .map((validator) => runFieldValidator(validator, value))
          .filter((error): error is string => error !== null)
        const base = sameLine ? CONFIDENCE_SAME_LINE : CONFIDENCE_NEXT_LINE
        const confidence = round(Math.max(0, base - penalty - failed.length * VALIDATOR_PENALTY))

        const line = lines[read.line]!
        const valueLine = lines[read.valueLine]!
        const bbox = sameLine ? line.bbox : unionBox(line.bbox, valueLine.bbox)
        const candidate: Candidate = {
          fieldId,
          value,
          confidence,
          tier: source.tier,
          labelLength: source.label.length,
          sameLine,
          validatorsFailed: failed,
          evidence: {
            page: page.page,
            text: sameLine ? line.text : `${line.text}\n${valueLine.text}`,
            ...(bbox ? { bbox } : {}),
            ...(source.ruleId ? { ruleId: source.ruleId } : {}),
            // Come si è letto e con che ambito: l'evidenza è l'unico posto dove questo
            // resta scritto, e serve a spiegare i numeri della misura, non a decidere.
            strategy: sameLine ? 'LABEL_STRICT' : 'NEXT_LINE',
            ...(source.scope ? { ruleScope: source.scope } : {})
          },
          position: { page: page.page, line: read.valueLine }
        }

        const key = `${page.page}:${read.valueLine}:${value}`
        const previous = best.get(key)
        if (!previous || compareCandidates(candidate, previous) < 0) best.set(key, candidate)
      }
    }
  }

  return [...best.values()].sort(compareCandidates)
}

/**
 * Partita IVA e codice fiscale della stessa parte possono essere lo stesso numero: per una
 * società il codice fiscale è quasi sempre la partita IVA, e la fattura li scrive insieme,
 * «C.F. e P.IVA 01234567890». Su quella riga il valore è di tutti e due i campi, e non è
 * un conflitto: `issuer.tax_code` è il gemello di `issuer.vat_number`, e viceversa.
 */
export function fiscalTwinOf(fieldId: string): string | null {
  const dot = fieldId.lastIndexOf('.')
  if (dot === -1) return null
  const party = fieldId.slice(0, dot)
  const key = fieldId.slice(dot + 1)
  if (key === 'vat_number') return `${party}.tax_code`
  if (key === 'tax_code') return `${party}.vat_number`
  return null
}

/** L'etichetta di `a` è più specifica di quella di `b`: livello, poi lunghezza. */
function moreSpecific(a: Candidate, b: Candidate): boolean {
  return a.tier > b.tier || (a.tier === b.tier && a.labelLength > b.labelLength)
}

/**
 * Etichetta più specifica (livello, poi lunghezza), poi stessa riga, poi validatori
 * superati, poi ordine di documento.
 */
function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    b.tier - a.tier ||
    b.labelLength - a.labelLength ||
    Number(b.sameLine) - Number(a.sameLine) ||
    a.validatorsFailed.length - b.validatorsFailed.length ||
    documentOrder(a, b)
  )
}

function documentOrder(a: Candidate, b: Candidate): number {
  return a.position.page - b.position.page || a.position.line - b.position.line
}

// ---------------------------------------------------------------------------
// Estrazione
// ---------------------------------------------------------------------------

function roleOf(profile: ClassExtractionProfile, fieldId: string): FieldRole {
  return profile.required_fields.includes(fieldId) ? 'required' : 'optional'
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Estrae i fatti del profilo del tipo.
 *
 * Per i campi `many`, `value` è l'elenco dei valori e `evidence[i]` è l'evidenza di
 * `value[i]`. Un campo senza evidenza resta `null` con stato MISSING: il ruolo dice se
 * la mancanza pesa.
 */
export function extractFactsV2(input: ExtractFactsInput): ExtractionResultV2 {
  const profile = input.registry.profile(input.documentType)
  if (!profile) throw new Error(`Nessun profilo di estrazione per ${input.documentType}.`)

  const fieldIds = [...new Set([...profile.required_fields, ...profile.optional_fields])]

  // Quanti valori chiede il campo su questo tipo: la decisione del revisore, se c'è,
  // altrimenti l'ontologia.
  const cardinality = (fieldId: string, spec: FieldOntologyEntry) =>
    cardinalityOf(profile, fieldId, spec.default_cardinality)

  const ocrPages = new Set(input.ocrPages ?? [])
  const sections = input.registry.sections()
  const parties = new Set(sections.map((section) => section.party))
  const conflicts: string[] = []
  const specs = new Map<string, FieldOntologyEntry>()
  const labels = new Map<string, LabelSource[]>()
  for (const fieldId of fieldIds) {
    const ontologySpec = input.registry.field(fieldId)
    if (!ontologySpec) {
      // Un campo che il profilo chiede e l'ontologia non descrive non si può cercare: non
      // si sa con che etichette né con che lettore. Ma non può nemmeno sparire, o il run
      // chiuderebbe con copertura piena su un obbligatorio mai cercato.
      conflicts.push(`UNKNOWN_FIELD:${fieldId}`)
      continue
    }
    // I validatori del tipo, dove il profilo li decide: su una nota di credito un totale
    // negativo è il valore giusto, non un errore da segnalare. Lo stesso per il `pii`.
    const spec = {
      ...ontologySpec,
      validators: validatorsOf(profile, fieldId, ontologySpec),
      pii: piiOf(profile, fieldId, ontologySpec)
    }
    specs.set(fieldId, spec)
    labels.set(fieldId, labelsFor(fieldId, spec, input.registry, input.learnedLabels ?? []))
  }

  // Le etichette di tutti i campi del profilo: una riga fatta solo di una di queste non è
  // un valore da leggere sotto un'altra etichetta.
  const bareLabels = new Set([...labels.values()].flatMap((list) => list.map((l) => l.label)))
  const candidates = new Map<string, Candidate[]>()
  for (const [fieldId, spec] of specs) {
    candidates.set(
      fieldId,
      candidatesForField(
        fieldId,
        spec,
        labels.get(fieldId)!,
        input.pages,
        ocrPages,
        bareLabels,
        sections,
        parties
      )
    )
  }

  // Assegnazione dei campi `one`: tutte le coppie (campo, candidato) in ordine di
  // specificità. Una riga con un valore appartiene al campo con l'etichetta più specifica;
  // a parità la tengono entrambi, in conflitto.
  const chosen = new Map<string, Candidate>()
  const conflicted = new Set<string>()
  const claims = new Map<string, Candidate>()
  const pairs = [...candidates.entries()]
    .filter(([fieldId]) => {
      const spec = specs.get(fieldId)
      return spec !== undefined && cardinality(fieldId, spec) === 'one'
    })
    .flatMap(([, list]) => list)
    .sort(compareCandidates)

  const claimKey = (candidate: Candidate) =>
    `${candidate.position.page}:${candidate.position.line}:${candidate.value}`
  // Campo -> il gemello di cui ha preso il valore: ne segue anche il conflitto.
  const twinned = new Map<string, string>()
  for (const candidate of pairs) {
    if (chosen.has(candidate.fieldId)) continue
    const key = claimKey(candidate)
    const twin = fiscalTwinOf(candidate.fieldId)
    const twinPick = twin ? chosen.get(twin) : undefined
    if (twin && twinPick && claimKey(twinPick) === key) {
      twinned.set(candidate.fieldId, twin)
      chosen.set(candidate.fieldId, candidate)
      continue
    }
    const owner = claims.get(key)
    if (owner && moreSpecific(owner, candidate)) continue
    if (owner) {
      conflicted.add(owner.fieldId)
      conflicted.add(candidate.fieldId)
      conflicts.push(`SHARED_EVIDENCE:${owner.fieldId}|${candidate.fieldId}`)
    } else {
      claims.set(key, candidate)
    }
    chosen.set(candidate.fieldId, candidate)
  }
  // Se il gemello è in conflitto — la riga è anche di un'altra parte — lo è anche lui.
  for (const [fieldId, twin] of twinned) {
    if (conflicted.has(twin)) conflicted.add(fieldId)
  }

  /**
   * La riga di questo candidato è di un altro campo, che la chiama con un'etichetta più
   * specifica: su una ricevuta di bonifico «IBAN ordinante» è il conto di addebito, e la
   * sua riga non è un secondo candidato per l'IBAN del beneficiario.
   */
  const claimedByOther = (candidate: Candidate): boolean => {
    const owner = claims.get(claimKey(candidate))
    return (
      owner !== undefined && owner.fieldId !== candidate.fieldId && moreSpecific(owner, candidate)
    )
  }

  const facts: ExtractedFactV2[] = []
  const missingRequired: string[] = []

  for (const fieldId of fieldIds) {
    const spec = specs.get(fieldId)
    const role = roleOf(profile, fieldId)
    if (!spec) {
      // Il campo resta nel run, vuoto e con il motivo: `UNKNOWN_FIELD` fra gli errori dice
      // che non è stato cercato, non che il documento non ce l'ha.
      if (role === 'required') missingRequired.push(fieldId)
      facts.push({
        ...emptyFact(fieldId, role, cardinalityOf(profile, fieldId, 'one')),
        validationErrors: ['UNKNOWN_FIELD']
      })
      continue
    }
    const list = candidates.get(fieldId) ?? []

    if (cardinality(fieldId, spec) === 'many') {
      // Un elemento per riga, nell'ordine in cui compare nel documento.
      const perLine = new Map<string, Candidate>()
      for (const candidate of list) {
        const key = `${candidate.position.page}:${candidate.position.line}`
        if (!perLine.has(key)) perLine.set(key, candidate)
      }
      const items = [...perLine.values()].sort(documentOrder)
      if (items.length === 0) {
        if (role === 'required') missingRequired.push(fieldId)
        facts.push(emptyFact(fieldId, role, 'many'))
        continue
      }
      const errors = [...new Set(items.flatMap((item) => item.validatorsFailed))]
      const confidence = round(items.reduce((sum, item) => sum + item.confidence, 0) / items.length)
      facts.push({
        fieldId,
        role,
        cardinality: 'many',
        value: items.map((item) => item.value),
        confidence,
        evidence: items.map((item) => item.evidence),
        reviewStatus:
          errors.length > 0 || items.some((item) => item.confidence < AUTO_ACCEPT_THRESHOLD)
            ? 'NEEDS_REVIEW'
            : 'AUTO_ACCEPTED',
        validationErrors: errors
      })
      continue
    }

    const pick = chosen.get(fieldId)
    if (!pick) {
      if (role === 'required') missingRequired.push(fieldId)
      facts.push(emptyFact(fieldId, role, 'one'))
      continue
    }

    const rivals = list.filter(
      (other) =>
        other.tier === pick.tier &&
        other.labelLength === pick.labelLength &&
        other.value !== pick.value &&
        !claimedByOther(other)
    )
    if (rivals.length > 0) {
      conflicted.add(fieldId)
      conflicts.push(`MULTIPLE_CANDIDATES:${fieldId}`)
    }

    facts.push({
      fieldId,
      role,
      cardinality: 'one',
      value: pick.value,
      confidence: pick.confidence,
      evidence: [pick.evidence],
      reviewStatus: conflicted.has(fieldId)
        ? 'CONFLICT'
        : pick.validatorsFailed.length > 0 || pick.confidence < AUTO_ACCEPT_THRESHOLD
          ? 'NEEDS_REVIEW'
          : 'AUTO_ACCEPTED',
      validationErrors: pick.validatorsFailed
    })
  }

  deduceFacts(input.documentType, facts, missingRequired)

  const filled = facts.filter((fact) => fact.value !== null)
  return {
    documentType: input.documentType,
    schemaState: profile.schema_state,
    facts,
    missingRequired,
    conflicts,
    coverage: facts.length === 0 ? 0 : round(filled.length / facts.length),
    confidence:
      filled.length === 0
        ? 0
        : Math.round(
            (filled.reduce((sum, fact) => sum + fact.confidence, 0) / filled.length) * 1e4
          ) / 1e4
  }
}

/**
 * L'unico valore che il motore propone senza averlo letto: la scadenza di un attestato di
 * formazione. Vale solo se il campo è rimasto vuoto — una scadenza scritta sul documento
 * vince sempre — e solo per i corsi che la tabella conosce. Resta senza evidenza, perché
 * nel documento quella data non c'è, e `computed` lo dice a chi misura.
 */
function deduceFacts(
  documentType: string,
  facts: ExtractedFactV2[],
  missingRequired: string[]
): void {
  const expiry = facts.find((fact) => fact.fieldId === TRAINING_EXPIRY_FIELD)
  if (!expiry || expiry.value !== null) return

  const computed = trainingExpiryOf(documentType, (fieldId) => {
    const fact = facts.find((entry) => entry.fieldId === fieldId)
    return typeof fact?.value === 'string' ? fact.value : null
  })
  if (!computed) return

  expiry.value = computed.value
  expiry.confidence = CONFIDENCE_COMPUTED
  expiry.reviewStatus = 'NEEDS_REVIEW'
  expiry.computed = true
  // Un campo dedotto non è più un obbligatorio senza valore: il run non deve chiedere al
  // revisore di cercare nel documento una data che il documento non ha.
  const missing = missingRequired.indexOf(TRAINING_EXPIRY_FIELD)
  if (missing !== -1) missingRequired.splice(missing, 1)
}

function emptyFact(fieldId: string, role: FieldRole, cardinality: 'one' | 'many'): ExtractedFactV2 {
  return {
    fieldId,
    role,
    cardinality,
    value: null,
    confidence: 0,
    evidence: [],
    reviewStatus: 'MISSING',
    validationErrors: []
  }
}
