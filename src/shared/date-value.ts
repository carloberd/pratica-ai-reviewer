/**
 * La forma canonica di una data: `yyyy-mm-dd`.
 *
 * Il motore le scrive già così — `readDate` normalizza quello che legge — ma il revisore
 * no: ricopia la stringa dal documento. Nell'export del 18/09/2026, su 57 valori data 45
 * erano in formato libero e 12 in ISO, e la divisione seguiva esattamente l'origine:
 *
 * ```
 * ENGINE    yyyy-mm-dd   12
 * REVIEWER  dd/mm/yyyy   25
 * REVIEWER  dd.mm.yyyy    9
 * REVIEWER  altro         8   («31 Maggio 2022», «29 07 2026», «10 11 1994»)
 * REVIEWER  yyyy-mm-dd    3
 * ```
 *
 * Un dataset così non serve a misurare l'estrazione delle date: ogni confronto fra la
 * proposta del motore e quella del revisore dà un falso negativo, anche quando dicono la
 * stessa cosa.
 *
 * Qui non c'è né database né filesystem: entra il testo, esce la data o `null`.
 */

/** I mesi come si scrivono in italiano, per le date testuali. */
export const MONTHS = [
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

/**
 * Anno a due cifre: il pivot a 69 è quello di POSIX, «26» è il 2026.
 */
const TWO_DIGIT_PIVOT = 69

/** `31/12/2025`, `31.12.2025`, `31-12-2025`, e con l'anno a due cifre. */
export const DATE_DMY = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/

/** `2025-12-31`. */
export const DATE_ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/

/** `31 dicembre 2025`. */
export const DATE_TEXT = new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS.join('|')})\\s+(\\d{4})\\b`, 'i')

/**
 * `31 12 2025`: i separatori sono spazi.
 *
 * Solo per il valore scritto dal revisore, dove tutta la stringa è la data. Dentro una
 * riga di documento tre numeri di seguito sono quasi sempre altro — una riga merce, un
 * codice — e questa forma non si cerca.
 */
const DATE_SPACED = /^(\d{1,2})\s+(\d{1,2})\s+(\d{4}|\d{2})$/

export function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0')
}

function iso(year: number, month: number, day: number): string | null {
  return isRealDate(year, month, day) ? `${pad(year, 4)}-${pad(month)}-${pad(day)}` : null
}

function fullYear(raw: string): number {
  const year = Number(raw)
  if (raw.length !== 2) return year
  return year <= TWO_DIGIT_PIVOT ? 2000 + year : 1900 + year
}

/** Prima data della riga, normalizzata. `raw` è il testo che occupava. */
export function findDate(line: string): { raw: string; value: string } | null {
  const isoMatch = DATE_ISO.exec(line)
  if (isoMatch) {
    const value = iso(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]))
    if (value) return { raw: isoMatch[0], value }
  }

  const dmy = DATE_DMY.exec(line)
  if (dmy) {
    const value = iso(fullYear(dmy[3] ?? ''), Number(dmy[2]), Number(dmy[1]))
    if (value) return { raw: dmy[0], value }
  }

  return null
}

/** Prima data testuale della riga: `31 dicembre 2025`. */
export function findTextualDate(
  line: string
): { raw: string; value: string; index: number } | null {
  const match = DATE_TEXT.exec(line)
  if (!match) return null
  const month = MONTHS.indexOf((match[2] ?? '').toLowerCase()) + 1
  const value = iso(Number(match[3]), month, Number(match[1]))
  return value ? { raw: match[0], value, index: match.index } : null
}

/**
 * La data che il revisore ha scritto, in forma canonica, o `null` se quello che ha scritto
 * non è **tutto** una data.
 *
 * Deve essere tutta la stringa: «Contratto del 5» o «03/05/2021 (8 ore), 04/05/2021
 * (8 ore)» restano come sono, perché normalizzarli vorrebbe dire buttare via metà di
 * quello che il revisore ha scritto. Così resta a vista, invece di sparire in silenzio.
 */
export function normalizeDateValue(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed === '') return null

  const spaced = DATE_SPACED.exec(trimmed)
  if (spaced) return iso(fullYear(spaced[3] ?? ''), Number(spaced[2]), Number(spaced[1]))

  const textual = findTextualDate(trimmed)
  if (textual && textual.raw.length === trimmed.length) return textual.value

  const numeric = findDate(trimmed)
  return numeric && numeric.raw.length === trimmed.length ? numeric.value : null
}
