import type { DocumentPick, EvidenceItem } from './types'

/**
 * Quando un valore scritto a mano è la **ripulitura** di una lettura sbagliata, e non un
 * valore diverso.
 *
 * Su una scansione l'OCR legge male — `FRAITA (MAB)` per `FRAITA (MAR)`, `29 O7 2026` per
 * `29 07 2026` — e il revisore sistema la parola. Fino alla 1.5.3 correggendola perdeva la
 * selezione: il valore salvato non era più carattere per carattere il testo letto, e per
 * l'app diventava indistinguibile da «l'ho riscritto a mano». Sono i documenti su cui il
 * motore lavora peggio, quindi quelli su cui imparare servirebbe di più.
 *
 * Il controllo carattere per carattere resta per tutto il resto. La ripulitura vale solo
 * dove il testo l'ha letto una macchina, cioè su un'area passata dall'OCR: il testo di una
 * selezione e quello di un'area su pagina nativa vengono dal documento, quindi un valore
 * che non coincide è un valore **diverso**, e la selezione non ne è più l'origine.
 */

/**
 * Oltre un quarto di caratteri cambiati non è più la stessa lettura, è un altro valore:
 * un OCR sbaglia una lettera qui e una là — `MAB` per `MAR`, `O` per `0` — non riscrive.
 */
const MAX_CLEANUP_SHARE = 1 / 4

/** Un carattere sistemato è sempre una ripulitura, anche su un valore cortissimo. */
const MIN_CLEANUP_DISTANCE = 1

/** Maiuscole, accenti e spazi non distinguono due letture della stessa cosa. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Distanza di edit, con la sola riga precedente in memoria. */
function distance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0 || b.length === 0) return Math.max(a.length, b.length)
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current.push(Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost))
    }
    previous = current
  }
  return previous[b.length]!
}

/** Il valore è la stessa lettura sistemata, non un'altra. */
export function isCleanup(read: string, value: string): boolean {
  const from = fold(read)
  const to = fold(value)
  if (from.length === 0 || to.length === 0) return false
  const allowed = Math.max(
    MIN_CLEANUP_DISTANCE,
    Math.floor(MAX_CLEANUP_SHARE * Math.max(from.length, to.length))
  )
  return distance(from, to) <= allowed
}

/**
 * La selezione resta l'origine di un valore che non le somiglia carattere per carattere:
 * solo per un'area letta con l'OCR, e solo se il valore è quella lettura sistemata.
 */
export function keepsPick(pick: DocumentPick, read: string, value: string): boolean {
  return pick.method === 'AREA_OCR' && isCleanup(read, value)
}

/**
 * La selezione già registrata su un valore, nella forma in cui il renderer la rimanda al
 * main quando il revisore ne sistema il testo a mano. `null` se il valore non viene da una
 * selezione: una lettura del motore non è una selezione del revisore.
 */
export function pickOfEvidence(evidence: EvidenceItem | undefined): DocumentPick | undefined {
  if (evidence?.origin !== 'REVIEWER' || !evidence.method) return undefined
  return {
    method: evidence.method,
    page: evidence.page,
    text: evidence.text,
    ...(evidence.bbox ? { bbox: evidence.bbox } : {})
  }
}
