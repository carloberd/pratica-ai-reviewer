import type { LearningPick } from '@shared/local-learning'
import type { PageInput } from './db/dao/pages'

/**
 * Dove stava, sul documento, un valore che il revisore ha **digitato** invece di
 * selezionarlo.
 *
 * ## Perché serve
 *
 * Il learner impara l'etichetta di un campo risalendo dal punto in cui il valore è stato
 * preso (`learning-anchors.ts`). Quel punto lo porta la selezione del revisore, e senza
 * selezione non c'è ancora, quindi non c'è regola: chi scrive il valore a mano non insegna
 * niente. Durante l'annotazione a mano si digita di continuo, ed è il buco più costoso.
 *
 * ## La guardia
 *
 * Il valore finale si cerca nel testo già elaborato, nelle forme verbatim in cui
 * l'estrazione l'avrebbe potuto leggere prima di normalizzarlo, e si accetta **solo se una
 * di quelle forme compare una volta sola in tutto il documento**. Due occorrenze — «10,00»
 * come totale e «10,00» come imponibile — vogliono dire che non si sa quale delle due il
 * revisore avesse davanti, e allora si rinuncia. Rinunciare lascia un campo senza regola,
 * che è un costo visibile; indovinare scrive una regola che poi precompilerà il punto
 * sbagliato su tutti i documenti dello stesso modulo, e quello è un costo che si scopre
 * tardi, dentro il dataset.
 *
 * ## Cosa resta fuori
 *
 * Il valore serve solo alla ricerca e non entra mai nell'evento: il deposito del learner
 * continua a non contenere né testo né valori del documento, e questa funzione non cambia
 * quella promessa. Anche il `bbox` è quello della riga, non del valore: un'inferenza non ha
 * un rettangolo disegnato da nessuno, e `method` dice che il punto è stato ritrovato, non
 * indicato.
 *
 * Gira solo quando la selezione manca davvero, quindi non si sovrappone a `textCorrected`
 * (la selezione che sopravvive alla ripulitura di una lettura OCR, `field-edits.ts`): lì
 * un pick c'è, ed è quello del revisore.
 */
export function inferExactValuePick(pages: PageInput[], value: string): LearningPick | null {
  const variants = valueVariants(value)
  if (variants.length === 0) return null
  const found = new Map<string, Occurrence>()

  for (const page of pages) {
    for (let line = 0; line < page.lines.length; line += 1) {
      const source = page.lines[line]!.text
      const folded = source.toLocaleLowerCase('it')
      for (const variant of variants) {
        const needle = variant.toLocaleLowerCase('it')
        for (let at = folded.indexOf(needle); at !== -1; at = folded.indexOf(needle, at + 1)) {
          const end = at + variant.length
          if (!wordBounded(source, at, end)) continue
          found.set(`${page.page}:${line}:${at}:${end}`, { page: page.page, line, start: at, end })
          // Due punti distinti bastano a rinunciare: non serve finire di contarli.
          if (found.size > 1) return null
        }
      }
    }
  }

  const occurrence = [...found.values()][0]
  if (!occurrence) return null
  const page = pages.find((entry) => entry.page === occurrence.page)!
  const line = page.lines[occurrence.line]!
  // Gli offset sono quelli che `deriveAnchor` si aspetta: contati sulla pagina intera,
  // righe unite da un a capo, come li produce `locatePick` per una selezione vera.
  const prefix = page.lines
    .slice(0, occurrence.line)
    .reduce((length, entry) => length + entry.text.length + 1, 0)
  return {
    method: 'EXACT_VALUE_MATCH',
    page: occurrence.page,
    bbox: line.bbox ?? null,
    location: {
      lineStart: occurrence.line,
      lineEnd: occurrence.line,
      charStart: prefix + occurrence.start,
      charEnd: prefix + occurrence.end
    }
  }
}

interface Occurrence {
  page: number
  line: number
  start: number
  end: number
}

/**
 * Caratteri minimi perché l'unicità di una forma voglia dire qualcosa. «7» che compare una
 * volta sola su una pagina è unico per caso, e l'etichetta che gli sta accanto potrebbe non
 * annunciare niente. Sotto questa soglia si preferisce non imparare.
 */
const MIN_VALUE_CHARS = 3

/**
 * Il valore non confina con lettere o cifre. Serve a non ritrovare «12» dentro «120», o un
 * codice dentro un codice più lungo: la punteggiatura e gli spazi sì, sono i delimitatori
 * normali di una riga.
 */
function wordBounded(text: string, start: number, end: number): boolean {
  const first = text[start]
  const last = text[end - 1]
  const before = text[start - 1]
  const after = text[end]
  if (first && /[\p{L}\p{N}]/u.test(first) && before && /[\p{L}\p{N}]/u.test(before)) return false
  if (last && /[\p{L}\p{N}]/u.test(last) && after && /[\p{L}\p{N}]/u.test(after)) return false
  return true
}

/**
 * Le forme verbatim in cui un valore salvato poteva stare scritto sul documento.
 *
 * Il salvataggio normalizza: una data diventa `yyyy-mm-dd` qualunque cosa il revisore abbia
 * ricopiato (`@shared/field-edits`), e chi digita un importo o un IBAN sceglie una
 * punteggiatura sua. Cercare il valore com'è salvato non lo troverebbe quasi mai.
 *
 * Sono riscritture della stessa cifra, mai valori nuovi: nessuna variante aggiunge o toglie
 * un numero. Dalla più lunga, perché la più specifica è anche quella che sbaglia meno a
 * confinare.
 */
export function valueVariants(value: string): string[] {
  const clean = value.replace(/\s+/g, ' ').trim()
  if (clean.length < MIN_VALUE_CHARS) return []
  const variants = new Set([clean])

  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean)
  if (date) {
    const [, year, month, day] = date
    variants.add(`${day}/${month}/${year}`)
    variants.add(`${day}-${month}-${year}`)
    variants.add(`${day}.${month}.${year}`)
    variants.add(`${Number(day)}/${Number(month)}/${year}`)
  }

  // Un importo salvato col punto decimale: sul documento ha la virgola, e spesso le
  // migliaia separate.
  if (/^-?\d+(?:\.\d{1,2})?$/.test(clean)) {
    const [integer, decimals] = clean.split('.')
    const sign = integer!.startsWith('-') ? '-' : ''
    const digits = integer!.replace('-', '')
    const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
    variants.add(`${sign}${digits}${decimals ? `,${decimals}` : ''}`)
    variants.add(`${sign}${grouped}${decimals ? `,${decimals}` : ''}`)
  }

  // Un IBAN si scrive tutto attaccato o a gruppi di quattro: chi digita sceglie, il
  // documento aveva già scelto.
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/i.test(clean.replace(/\s/g, ''))) {
    const compact = clean.replace(/\s/g, '').toUpperCase()
    variants.add(compact)
    variants.add(compact.replace(/(.{4})/g, '$1 ').trim())
  }
  return [...variants].sort((a, b) => b.length - a.length)
}
