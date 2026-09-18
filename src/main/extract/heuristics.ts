import { fieldSemanticType, type RegistryFieldName } from '@shared/fields'
import type { BoundingBox } from '@shared/types'
import { mentionsReference, precededByReference } from './reference-context'
import type { ExtractedPage, TextLine } from './types'

/**
 * Precompilazione v1: deterministica, nessun LLM.
 *
 * Regola che governa tutto il modulo: nessun valore senza evidenza verbatim. Se non
 * si trova la riga da cui viene un dato, il campo resta vuoto, perché un valore che
 * il revisore non può verificare costa più di un campo da riempire a mano.
 *
 * Questo modulo è il punto di innesto previsto per il fact reader del Document Brain:
 * ha la stessa forma (campi richiesti in ingresso, candidati con evidenza in uscita)
 * e può essere sostituito senza toccare il resto della pipeline.
 */

export const CONFIDENCE_WITH_CONTEXT = 0.85
export const CONFIDENCE_REGEX_ONLY = 0.7
export const OCR_PENALTY = 0.1

export interface FieldCandidate {
  name: RegistryFieldName
  /** Valore normalizzato: `yyyy-mm-dd` per le date, decimale con punto per gli importi. */
  value: string
  confidence: number
  evidence: {
    page: number
    /** Riga del documento, verbatim. */
    text: string
    bbox?: BoundingBox
  }
}

/** Minuscole, senza accenti, senza punteggiatura: solo per cercare le keyword. */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Date
// ---------------------------------------------------------------------------

const DATE_DMY = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/
const DATE_ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0')
}

/** Prima data della riga, normalizzata a `yyyy-mm-dd`. */
export function findDate(line: string): { raw: string; value: string } | null {
  const iso = DATE_ISO.exec(line)
  if (iso) {
    const [raw, y, m, d] = iso
    const year = Number(y)
    const month = Number(m)
    const day = Number(d)
    if (isRealDate(year, month, day)) {
      return { raw, value: `${pad(year, 4)}-${pad(month)}-${pad(day)}` }
    }
  }

  const dmy = DATE_DMY.exec(line)
  if (dmy) {
    const [raw, d, m, y] = dmy
    const day = Number(d)
    const month = Number(m)
    let year = Number(y)
    // Anno a due cifre: il pivot a 69 è quello di POSIX, «26» è il 2026.
    if (y && y.length === 2) year = year <= 69 ? 2000 + year : 1900 + year
    if (isRealDate(year, month, day)) {
      return { raw, value: `${pad(year, 4)}-${pad(month)}-${pad(day)}` }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Importi
// ---------------------------------------------------------------------------

const MONEY =
  /(€\s*)?(\d{1,3}(?:[.\s]\d{3})+(?:,\d{1,2})?|\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+,\d{1,2}|\d+\.\d{1,2}|\d+)(\s*(?:€|eur|euro))?/gi

/** Le stesse due forme di `findDate`, globali: qui servono tutte le date, non la prima. */
const DATE_DMY_ALL = new RegExp(DATE_DMY.source, 'g')
const DATE_ISO_ALL = new RegExp(DATE_ISO.source, 'g')

/**
 * Gli intervalli `[inizio, fine)` che una data vera occupa nella riga.
 *
 * Le cifre di una data non sono un importo: in «Totale al 31.12.2025 di 1.234,56» il
 * pattern degli importi aggancia «31.12», che ha la parte decimale e passerebbe la
 * guardia sul numero nudo, e l'importo vero non verrebbe mai letto. Solo le date che
 * esistono coprono le loro cifre: «31.02.2026» non è una data, e «45.13» resta un
 * numero come un altro.
 */
function dateSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  for (const pattern of [DATE_ISO_ALL, DATE_DMY_ALL]) {
    pattern.lastIndex = 0
    for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
      if (findDate(match[0]) === null) continue
      spans.push([match.index, match.index + match[0].length])
    }
  }
  return spans
}

/**
 * Da `€ 12.840,50`, `12.840,50 EUR` o `1.234,56` a `12840.50`.
 *
 * Quando compaiono sia il punto sia la virgola, l'ultimo separatore è quello
 * decimale: è l'unico modo per leggere insieme `1.234,56` e `1,234.56`.
 */
export function parseMoney(raw: string): string | null {
  const cleaned = raw.replace(/[€\s]/g, '').replace(/eur(o)?/gi, '')
  if (!/\d/.test(cleaned)) return null

  const lastComma = cleaned.lastIndexOf(',')
  const lastDot = cleaned.lastIndexOf('.')
  let integerPart = cleaned
  let decimalPart = ''

  if (lastComma !== -1 || lastDot !== -1) {
    const separator = lastComma > lastDot ? lastComma : lastDot
    const tail = cleaned.slice(separator + 1)
    if (/^\d{1,2}$/.test(tail)) {
      integerPart = cleaned.slice(0, separator)
      decimalPart = tail
    }
  }

  const digits = integerPart.replace(/\D/g, '')
  if (digits.length === 0) return null

  const value = Number(`${digits}.${decimalPart.padEnd(2, '0')}`)
  if (!Number.isFinite(value)) return null
  return value.toFixed(2)
}

/**
 * Primo importo della riga.
 *
 * Un numero nudo non basta: «2026» è un anno, non un totale. Serve un simbolo di
 * valuta, una parte decimale o il raggruppamento delle migliaia. E le cifre di una data
 * non contano: sono l'unico numero della riga che imita un importo senza essere un
 * candidato.
 */
export function findMoney(line: string): { raw: string; value: string } | null {
  const dates = dateSpans(line)
  MONEY.lastIndex = 0
  for (let match = MONEY.exec(line); match !== null; match = MONEY.exec(line)) {
    const [raw, prefix, number, suffix] = match
    if (!number) continue
    const start = match.index + (prefix?.length ?? 0)
    if (dates.some(([from, to]) => start < to && from < start + number.length)) continue
    const hasCurrency = Boolean(prefix || suffix)
    const hasDecimals = /[.,]\d{1,2}$/.test(number)
    const hasGrouping = /\d[.\s,]\d{3}/.test(number)
    if (!hasCurrency && !hasDecimals && !hasGrouping) continue

    const value = parseMoney(raw)
    if (value) return { raw: raw.trim(), value }
  }
  return null
}

// ---------------------------------------------------------------------------
// Identificativi
// ---------------------------------------------------------------------------

const CODICE_FISCALE = /\b[A-Za-z]{6}\d{2}[A-Za-z]\d{2}[A-Za-z]\d{3}[A-Za-z]\b/
const PARTITA_IVA = /\b\d{11}\b/
/**
 * Il `\b` in testa evita che la `n` dentro «Contratto» apra un falso numero, e la
 * forma abbreviata richiede il punto (`n.`) per lo stesso motivo. Il pattern del
 * protocollo copre «Prot. n. 2026/554321», dove sia «prot.» sia «n.» precedono il
 * valore.
 */
const PROTOCOLLO =
  /\b(?:protocollo|prot\.)\s*(?:n(?:umero)?\.?|nr\.?)?\s*[:°]?\s*([A-Za-z0-9][A-Za-z0-9/_-]{0,30})/gi
const NUMERO = /\b(?:numero|nr\.?|n\.)\s*[:°]?\s*([A-Za-z0-9][A-Za-z0-9/_-]{0,30})/gi
/** «Prot. n. » subito prima di un numero: quel numero è il protocollo, e solo quello. */
const ANNUNCIO_PROTOCOLLO = /\b(?:protocollo|prot\.?)\s*(?:n(?:umero)?\.?|nr\.?)?\s*[:°]?\s*$/i

/** Quale dei due numeri si sta cercando: si leggono con pattern diversi. */
export type NumberKind = 'document' | 'protocol'

/** Codice fiscale (16 caratteri) o partita IVA (11 cifre). */
export function findTaxCode(
  line: string,
  allowBarePartitaIva: boolean
): { raw: string; value: string } | null {
  const fiscale = CODICE_FISCALE.exec(line)
  if (fiscale?.[0]) return { raw: fiscale[0], value: fiscale[0].toUpperCase() }

  if (allowBarePartitaIva) {
    const iva = PARTITA_IVA.exec(line)
    if (iva?.[0]) return { raw: iva[0], value: iva[0] }
  }
  return null
}

/**
 * Numero di documento o di protocollo: «fattura n. 114», «prot. n. 1234/2026».
 *
 * I due non si leggono con lo stesso pattern, perché una riga può portarli entrambi:
 * «Fattura n. 114 - Prot. n. 2026/554321» dà 114 al numero documento e 2026/554321 al
 * protocollo. Il protocollo si legge solo dove «prot.»/«protocollo» lo annuncia — è
 * l'unica cosa che lo distingue da un numero qualsiasi — e il numero documento salta i
 * numeri annunciati così: un protocollo non è il numero del documento, e un campo
 * vuoto costa meno di un campo sbagliato.
 */
export function findNumber(line: string, kind: NumberKind): { raw: string; value: string } | null {
  const pattern = kind === 'protocol' ? PROTOCOLLO : NUMERO
  pattern.lastIndex = 0
  for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
    const captured = match[1]
    // Un numero deve contenere almeno una cifra e non deve essere una data.
    if (!captured || !/\d/.test(captured) || findDate(captured)) continue
    if (kind === 'document' && ANNUNCIO_PROTOCOLLO.test(line.slice(0, match.index))) continue
    return { raw: match[0], value: captured.replace(/[.,;:]+$/, '') }
  }
  return null
}

/**
 * Valore di un `<etichetta>: <valore>` sulla stessa riga.
 *
 * Si cercano i due punti che seguono la keyword, non i primi della riga: in
 * «Fattura n. 114 - Cliente: Alfa S.r.l.» il cliente è «Alfa S.r.l.».
 */
export function findLabeledValue(line: string, keyword: string): string | null {
  const parts = line.split(':')
  if (parts.length < 2) return null

  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!containsKeyword(fold(parts[index] ?? ''), keyword)) continue
    const value = parts
      .slice(index + 1)
      .join(':')
      .trim()
    if (value.length === 0 || value.length > 200) return null
    return value
  }
  return null
}

// ---------------------------------------------------------------------------
// Keyword di contesto, per campo
// ---------------------------------------------------------------------------

interface FieldSpec {
  keywords: string[]
  /**
   * Il campo accetta anche un match senza keyword di contesto (0,70). Riservato ai
   * campi che su un documento italiano hanno un solo candidato plausibile.
   */
  fallback?: boolean
}

export const FIELD_SPECS: Record<RegistryFieldName, FieldSpec> = {
  // date
  issue_date: {
    keywords: [
      'data di emissione',
      'data emissione',
      'data documento',
      'data fattura',
      'emessa il',
      'emesso il',
      'rilasciato il',
      'data del',
      'del'
    ],
    fallback: true
  },
  payment_date: {
    keywords: ['data di pagamento', 'data pagamento', 'data versamento', 'data valuta', 'pagato il']
  },
  transaction_date: {
    keywords: ['data operazione', 'data dell operazione', 'data movimento', 'data transazione']
  },
  effective_date: {
    keywords: [
      'data di decorrenza',
      'con effetto dal',
      'decorre dal',
      'efficacia dal',
      'decorrenza'
    ]
  },
  declaration_date: {
    keywords: ['data della dichiarazione', 'data dichiarazione', 'dichiarato il']
  },
  shipment_date: {
    keywords: ['data di spedizione', 'data spedizione', 'data trasporto', 'spedito il']
  },
  coverage_start: {
    keywords: [
      'decorrenza copertura',
      'inizio copertura',
      'copertura dal',
      'valida dal',
      'validita dal'
    ]
  },
  coverage_end: {
    keywords: [
      'scadenza copertura',
      'fine copertura',
      'copertura al',
      'valida al',
      'validita al',
      'scadenza'
    ]
  },
  period_start: {
    keywords: ['periodo di riferimento dal', 'inizio periodo', 'periodo dal', 'dal']
  },
  period_end: {
    keywords: ['periodo di riferimento al', 'fine periodo', 'periodo al', 'al']
  },
  service_period_start: {
    keywords: ['periodo di servizio dal', 'prestazione dal', 'servizio dal']
  },
  service_period_end: {
    keywords: ['periodo di servizio al', 'prestazione al', 'servizio al']
  },

  // importi
  total_amount: {
    keywords: [
      'totale complessivo',
      'totale documento',
      'totale da pagare',
      'totale fattura',
      'importo totale',
      'totale'
    ]
  },
  taxable_amount: { keywords: ['totale imponibile', 'base imponibile', 'imponibile'] },
  tax_amount: { keywords: ['totale iva', 'importo iva', 'imposta', 'iva'] },
  amount: { keywords: ['importo dovuto', 'ammontare', 'importo'] },
  premium_amount: { keywords: ['premio annuo', 'premio lordo', 'premio'] },
  customs_value: { keywords: ['valore doganale', 'valore in dogana', 'valore statistico'] },

  // identificativi e stringhe
  document_number: {
    keywords: [
      'numero documento',
      'numero fattura',
      'fattura n',
      'documento n',
      'numero',
      'nr',
      'n'
    ],
    fallback: true
  },
  protocol_number: { keywords: ['numero di protocollo', 'protocollo n', 'protocollo', 'prot'] },
  tax_code: { keywords: ['codice fiscale', 'partita iva', 'cod fisc', 'p iva', 'c f'] },
  issuer_name: {
    keywords: [
      'ente emittente',
      'ragione sociale',
      'rilasciato da',
      'emittente',
      'fornitore',
      'mittente',
      'cedente'
    ]
  },
  recipient_name: {
    keywords: [
      'destinatario',
      'intestatario',
      'committente',
      'cessionario',
      'spettabile',
      'cliente'
    ]
  },
  currency: { keywords: ['valuta', 'divisa'] },
  policy_number: { keywords: ['numero polizza', 'polizza n', 'polizza'] },
  account_identifier: {
    keywords: [
      'numero contratto',
      'codice cliente',
      'codice utente',
      'numero conto',
      'matricola',
      'iban',
      'pod',
      'pdr'
    ]
  },
  employee_name: { keywords: ['nome e cognome', 'dipendente', 'lavoratore', 'nominativo'] },
  job_title: { keywords: ['profilo professionale', 'mansione', 'qualifica', 'livello'] },
  site_name: { keywords: ['unita locale', 'stabilimento', 'cantiere', 'sito', 'sede'] },
  tax_period: {
    keywords: ['periodo d imposta', 'anno d imposta', 'anno di riferimento', 'periodo imposta']
  },
  payment_reference: {
    keywords: ['riferimento pagamento', 'identificativo pagamento', 'causale', 'cro', 'trn']
  },
  consumption: { keywords: ['consumo', 'consumi', 'lettura'] },
  package_count: { keywords: ['numero colli', 'quantita colli', 'colli'] },
  goods_description: {
    keywords: ['descrizione delle merci', 'descrizione merce', 'natura della merce', 'merce']
  },
  hazard_or_activity: { keywords: ['mansione a rischio', 'attivita', 'pericolo', 'rischio'] },
  legal_basis: {
    keywords: ['fondamento giuridico', 'riferimento normativo', 'base giuridica', 'ai sensi']
  },
  processing_purpose: {
    keywords: ['finalita del trattamento', 'scopo del trattamento', 'finalita']
  },
  recovery_target: { keywords: ['obiettivo di ripristino', 'tempo di ripristino', 'rto', 'rpo'] },
  severity: { keywords: ['livello di gravita', 'criticita', 'gravita', 'severita'] },
  system_or_service: { keywords: ['sistema', 'servizio', 'applicazione', 'piattaforma'] }
}

// ---------------------------------------------------------------------------
// Precompilazione
// ---------------------------------------------------------------------------

function containsKeyword(foldedLine: string, keyword: string): boolean {
  return ` ${foldedLine} `.includes(` ${keyword} `)
}

/**
 * La keyword compare sulla riga fuori da una citazione.
 *
 * Le keyword di `issue_date` e `document_number` finiscono per essere «del» e «n», che
 * dentro «ai sensi del D.Lgs. 9 aprile 2008, n. 81» leggono la norma invece del documento.
 * Basta un'occorrenza buona: la stessa riga può citare e poi dire la sua.
 */
function keywordOutsideReference(foldedLine: string, keyword: string): boolean {
  const padded = ` ${foldedLine} `
  const needle = ` ${keyword} `
  for (let at = padded.indexOf(needle); at !== -1; at = padded.indexOf(needle, at + 1)) {
    if (!precededByReference(foldedLine, at, keyword)) return true
  }
  return false
}

function extractValue(
  name: RegistryFieldName,
  line: string,
  keyword: string | null
): string | null {
  const semantic = fieldSemanticType(name)

  if (semantic === 'date') return findDate(line)?.value ?? null
  if (semantic === 'money') return findMoney(line)?.value ?? null

  if (name === 'tax_code') return findTaxCode(line, keyword !== null)?.value ?? null
  if (name === 'document_number') return findNumber(line, 'document')?.value ?? null
  if (name === 'protocol_number') return findNumber(line, 'protocol')?.value ?? null
  if (keyword === null) return null
  return findLabeledValue(line, keyword)
}

/**
 * Cerca un valore per ogni campo richiesto.
 *
 * Le keyword di un campo sono provate dalla più lunga alla più corta: «totale
 * imponibile» deve vincere su «totale», altrimenti l'imponibile finirebbe nel totale.
 *
 * La penalità dell'OCR è per pagina, non per documento: un allegato scansionato in fondo
 * a un PDF non rende meno affidabile quello che si legge dal text layer delle altre
 * pagine.
 */
export function prefillFields(input: {
  fields: RegistryFieldName[]
  pages: ExtractedPage[]
  /** Pagine il cui testo viene da OCR: solo i loro campi pagano la penalità. */
  ocrPages: number[]
}): FieldCandidate[] {
  const fromOcr = new Set(input.ocrPages)
  const penaltyOn = (page: number) => (fromOcr.has(page) ? OCR_PENALTY : 0)
  const candidates: FieldCandidate[] = []

  const foldedPages = input.pages.map((page) => ({
    page: page.page,
    lines: page.lines.map((line) => ({ line, folded: fold(line.text) }))
  }))

  for (const name of input.fields) {
    const spec = FIELD_SPECS[name]
    const keywords = [...spec.keywords].sort((a, b) => b.length - a.length)
    let found: FieldCandidate | null = null

    // Le keyword stanno nel ciclo esterno, le righe in quello interno: «totale
    // documento» deve essere cercata in tutto il documento prima di ripiegare su
    // «totale», altrimenti la prima riga che contiene «totale» vince comunque e
    // l'imponibile finisce nel totale.
    outer: for (const keyword of keywords) {
      for (const page of foldedPages) {
        for (const { line, folded } of page.lines) {
          if (!keywordOutsideReference(folded, keyword)) continue
          const value = extractValue(name, line.text, keyword)
          if (!value) continue
          found = {
            name,
            value,
            confidence: round(CONFIDENCE_WITH_CONTEXT - penaltyOn(page.page)),
            evidence: evidenceOf(page.page, line)
          }
          break outer
        }
      }
    }

    if (!found && spec.fallback) {
      const firstPage = foldedPages[0]
      if (firstPage) {
        for (const { line, folded } of firstPage.lines) {
          // Senza keyword non c'è niente su cui ancorarsi: se la riga cita qualcosa, il
          // primo numero o la prima data che ci trovi sono di quella citazione.
          if (mentionsReference(folded)) continue
          const value = extractValue(name, line.text, null)
          if (!value) continue
          found = {
            name,
            value,
            confidence: round(CONFIDENCE_REGEX_ONLY - penaltyOn(firstPage.page)),
            evidence: evidenceOf(firstPage.page, line)
          }
          break
        }
      }
    }

    if (found) candidates.push(found)
  }

  return candidates
}

function evidenceOf(page: number, line: TextLine): FieldCandidate['evidence'] {
  return { page, text: line.text, ...(line.bbox ? { bbox: line.bbox } : {}) }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
