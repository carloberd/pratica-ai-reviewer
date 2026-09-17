import { createHash } from 'node:crypto'

/**
 * Impronta del layout della prima pagina di un documento.
 *
 * L'idea è togliere i dati e tenere la forma: due fatture dello stesso stampato hanno
 * numeri, date e importi diversi ma le stesse righe negli stessi posti, quindi la stessa
 * impronta. Un altro stampato — altre righe, altre etichette — ne ha una diversa.
 *
 * Non è una firma crittografica di nulla: è una chiave di raggruppamento, e serve
 * all'export per contare quante volte il motore ha visto lo stesso modulo.
 *
 * Qui non c'è né database né filesystem: entrano le righe di testo, esce la stringa.
 */

/** Oltre questa lunghezza la riga trasformata viene troncata. */
export const TEMPLATE_LINE_LENGTH = 120

/** Caratteri esadecimali tenuti dell'hash: abbastanza per non collidere, corti da leggere. */
export const TEMPLATE_FINGERPRINT_LENGTH = 16

/**
 * La riga senza i dati: spazi collassati, ogni sequenza di lettere diventa `A`, ogni
 * sequenza di cifre `9`. «Fattura n. 114/2026» e «Fattura n. 27/2026» diventano
 * entrambe `A A. 9/9`.
 */
export function templateLine(line: string): string {
  return line
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\p{L}+/gu, 'A')
    .replace(/\p{N}+/gu, '9')
    .slice(0, TEMPLATE_LINE_LENGTH)
}

/**
 * Le righe da cui si ricava l'impronta: quelle dell'estrazione, o il testo spezzato a capo
 * quando l'estrazione non le ha. Elaborazione ed export devono leggere le stesse, o lo
 * stesso documento avrebbe due impronte.
 */
export function firstPageLines(
  page: { text: string; lines: Array<{ text: string }> } | undefined
): string[] {
  if (!page) return []
  if (page.lines.length > 0) return page.lines.map((line) => line.text)
  return page.text.split(/\r?\n/)
}

/**
 * L'impronta delle righe della prima pagina, o `null` quando non c'è testo da cui
 * ricavarla: una scansione senza OCR non ha un layout leggibile, e un'impronta uguale
 * per tutte le scansioni raggrupperebbe documenti che non c'entrano niente.
 */
export function templateFingerprint(lines: string[]): string | null {
  const shape = lines.map(templateLine).filter((line) => line !== '')
  if (shape.length === 0) return null
  return createHash('sha256')
    .update(shape.join('\n'), 'utf8')
    .digest('hex')
    .slice(0, TEMPLATE_FINGERPRINT_LENGTH)
}
