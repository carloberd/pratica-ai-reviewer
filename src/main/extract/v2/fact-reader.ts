import type {
  ClassExtractionProfile,
  ExtractedFactV2,
  ExtractionEvidenceV2,
  ExtractionResultV2,
  FieldOntologyEntry,
  FieldRole
} from '@shared/extraction-v2'
import { isRegistryField } from '@shared/fields'
import { cardinalityOf } from '@shared/profile-overlay'
import type { BoundingBox } from '@shared/types'
import { FIELD_SPECS, findDate, findMoney, fold, OCR_PENALTY } from '../heuristics'
import type { ExtractedPage, TextLine } from '../types'
import type { ExtractionRegistryV2 } from './profile-loader'
import { runFieldValidator } from './validators'

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
 *   e se nessuna etichetta è più specifica il campo va in CONFLICT;
 * - i campi `many` raccolgono un elemento per riga, in ordine di documento.
 */

export const CONFIDENCE_SAME_LINE = 0.85
export const CONFIDENCE_NEXT_LINE = 0.8
export const VALIDATOR_PENALTY = 0.18
/** Sotto questa confidence un valore va comunque rivisto. */
export const AUTO_ACCEPT_THRESHOLD = 0.85

/** Caratteri ammessi fra l'etichetta e l'inizio di un valore tipizzato. */
const VALUE_WINDOW = 40
/** Sulla riga successiva il valore deve stare in testa. */
const NEXT_LINE_WINDOW = 10
const MAX_TEXT_VALUE = 200

export interface ExtractFactsInput {
  documentType: string
  pages: ExtractedPage[]
  registry: ExtractionRegistryV2
  /** Testo da OCR: la confidence scende di 0,10 come nella v1. */
  fromOcr?: boolean
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

/** Posizioni dell'etichetta a confini di parola: `[inizio, fine)` nel testo originale. */
function labelOccurrences(line: FoldedLine, label: string): Array<[number, number]> {
  const padded = ` ${line.folded} `
  const needle = ` ${label} `
  const found: Array<[number, number]> = []
  for (let at = padded.indexOf(needle); at !== -1; at = padded.indexOf(needle, at + 1)) {
    const start = line.origin[at]!
    const end = line.origin[at + label.length - 1]! + 1
    found.push([start, end])
  }
  return found
}

function labelsFor(fieldId: string, spec: FieldOntologyEntry, registry: ExtractionRegistryV2) {
  const legacyKeywords = registry
    .legacyNames(fieldId)
    .flatMap((name) => (isRegistryField(name) ? FIELD_SPECS[name].keywords : []))
  const all = [
    ...registry.hints(fieldId),
    spec.label_it,
    ...spec.label_aliases_it,
    ...legacyKeywords
  ]
  return [...new Set(all.map(fold).filter((label) => label.length > 0))].sort(
    (a, b) => b.length - a.length
  )
}

// ---------------------------------------------------------------------------
// Lettori di valori, per tipo
// ---------------------------------------------------------------------------

type ReadMode = 'same-line' | 'next-line'

const MONTHS = [
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
  'luglio',
  'agosto',
  'settembre',
  'ottobre',
  'novembre',
  'dicembre'
]
const TEXT_DATE = new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS.join('|')})\\s+(\\d{4})\\b`, 'i')

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

  const textual = TEXT_DATE.exec(text)
  if (textual && textual.index <= window) {
    const day = Number(textual[1])
    const month = MONTHS.indexOf((textual[2] ?? '').toLowerCase()) + 1
    const year = Number(textual[3])
    const date = new Date(Date.UTC(year, month - 1, day))
    if (date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }
  }
  return null
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

function readBoolean(text: string): string | null {
  const trimmed = text.replace(/^[\s:=]+/, '')
  if (/^(s[iì]|yes|true|vero)\b/i.test(trimmed)) return 'true'
  if (/^(no|false|falso)\b/i.test(trimmed)) return 'false'
  return null
}

const TAX_ID = /\b(\d{11}|[A-Za-z]{6}\d{2}[A-Za-z]\d{2}[A-Za-z]\d{3}[A-Za-z])\b/
const IBAN = /\b([A-Za-z]{2}\d{2}(?:\s?[A-Za-z0-9]){11,30})\b/

/**
 * Identificativo subito dopo l'etichetta: «Protocollo n. 2026/554321», «Documento n.
 * CC-2026-018». Deve contenere almeno una cifra e non essere una data.
 */
export function readIdentifier(text: string, format: string | null | undefined): string | null {
  if (format === 'tax_id' || format === 'italian_tax_code') {
    const match = TAX_ID.exec(text)
    return match?.[1] && match.index <= VALUE_WINDOW ? match[1].toUpperCase() : null
  }
  if (format === 'iban') {
    const match = IBAN.exec(text)
    return match?.[1] && match.index <= VALUE_WINDOW
      ? match[1].replace(/\s/g, '').toUpperCase()
      : null
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
  const window = mode === 'same-line' ? VALUE_WINDOW : NEXT_LINE_WINDOW
  if (readsAsIdentifier(fieldId, spec)) return readIdentifier(text, spec.format)
  switch (spec.type) {
    case 'date':
      return readDate(text, window)
    case 'money':
      return readMoney(text, window)
    case 'number':
      return readNumber(text, window)
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

/** Un testo libero con l'etichetta a metà frase non è un'etichetta: «Codice cliente: 12». */
function startsSegment(text: string, start: number): boolean {
  const before = text.slice(0, start).trimEnd()
  return before === '' || /[-–—|;•(]$/.test(before)
}

function candidatesForField(
  fieldId: string,
  spec: FieldOntologyEntry,
  labels: string[],
  pages: ExtractedPage[],
  fromOcr: boolean
): Candidate[] {
  const penalty = fromOcr ? OCR_PENALTY : 0
  const isText = !readsAsIdentifier(fieldId, spec) && ['string', 'object'].includes(spec.type)
  // Per ogni riga del valore resta solo il candidato con l'etichetta più specifica.
  const best = new Map<string, Candidate>()

  for (const page of pages) {
    const lines = pageLines(page)
    const folded = lines.map((line) => foldWithOrigin(line.text))

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!
      for (const label of labels) {
        for (const [start, end] of labelOccurrences(folded[index]!, label)) {
          if (isText && !startsSegment(line.text, start)) continue

          const remainder = line.text.slice(end)
          let value = readValue(fieldId, spec, remainder, 'same-line')
          let sameLine = true
          let valueIndex = index
          if (value === null && /^[\s:=.°#\-–—]*$/.test(remainder) && index + 1 < lines.length) {
            value = readValue(fieldId, spec, lines[index + 1]!.text, 'next-line')
            sameLine = false
            valueIndex = index + 1
          }
          if (value === null) continue

          const failed = spec.validators
            .map((validator) => runFieldValidator(validator, value))
            .filter((error): error is string => error !== null)
          const base = sameLine ? CONFIDENCE_SAME_LINE : CONFIDENCE_NEXT_LINE
          const confidence = round(Math.max(0, base - penalty - failed.length * VALIDATOR_PENALTY))

          const valueLine = lines[valueIndex]!
          const bbox = sameLine ? line.bbox : unionBox(line.bbox, valueLine.bbox)
          const candidate: Candidate = {
            fieldId,
            value,
            confidence,
            labelLength: label.length,
            sameLine,
            validatorsFailed: failed,
            evidence: {
              page: page.page,
              text: sameLine ? line.text : `${line.text}\n${valueLine.text}`,
              ...(bbox ? { bbox } : {})
            },
            position: { page: page.page, line: valueIndex }
          }

          const key = `${page.page}:${valueIndex}:${value}`
          const previous = best.get(key)
          if (!previous || compareCandidates(candidate, previous) < 0) best.set(key, candidate)
        }
      }
    }
  }

  return [...best.values()].sort(compareCandidates)
}

/** Etichetta più specifica, poi stessa riga, poi validatori superati, poi ordine di documento. */
function compareCandidates(a: Candidate, b: Candidate): number {
  return (
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
  if (profile.required_fields.includes(fieldId)) return 'required'
  if (profile.core_fields.includes(fieldId)) return 'core'
  if (profile.conditional_fields.includes(fieldId)) return 'conditional'
  return 'optional'
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

  const fieldIds = [
    ...new Set([
      ...profile.required_fields,
      ...profile.core_fields,
      ...profile.optional_fields,
      ...profile.conditional_fields
    ])
  ]

  // Quanti valori chiede il campo su questo tipo: la decisione del revisore, se c'è,
  // altrimenti l'ontologia.
  const cardinality = (fieldId: string, spec: FieldOntologyEntry) =>
    cardinalityOf(profile, fieldId, spec.default_cardinality)

  const conflicts: string[] = []
  const specs = new Map<string, FieldOntologyEntry>()
  const candidates = new Map<string, Candidate[]>()
  for (const fieldId of fieldIds) {
    const spec = input.registry.field(fieldId)
    if (!spec) {
      conflicts.push(`UNKNOWN_FIELD:${fieldId}`)
      continue
    }
    specs.set(fieldId, spec)
    candidates.set(
      fieldId,
      candidatesForField(
        fieldId,
        spec,
        labelsFor(fieldId, spec, input.registry),
        input.pages,
        input.fromOcr ?? false
      )
    )
  }

  // Assegnazione dei campi `one`: tutte le coppie (campo, candidato) in ordine di
  // specificità. Una riga con un valore appartiene al campo con l'etichetta più lunga;
  // a parità di etichetta la tengono entrambi, in conflitto.
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

  for (const candidate of pairs) {
    if (chosen.has(candidate.fieldId)) continue
    const key = `${candidate.position.page}:${candidate.position.line}:${candidate.value}`
    const owner = claims.get(key)
    if (owner && owner.labelLength > candidate.labelLength) continue
    if (owner) {
      conflicted.add(owner.fieldId)
      conflicted.add(candidate.fieldId)
      conflicts.push(`SHARED_EVIDENCE:${owner.fieldId}|${candidate.fieldId}`)
    } else {
      claims.set(key, candidate)
    }
    chosen.set(candidate.fieldId, candidate)
  }

  const facts: ExtractedFactV2[] = []
  const missingRequired: string[] = []

  for (const fieldId of fieldIds) {
    const spec = specs.get(fieldId)
    if (!spec) continue
    const role = roleOf(profile, fieldId)
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
      (other) => other.labelLength === pick.labelLength && other.value !== pick.value
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
