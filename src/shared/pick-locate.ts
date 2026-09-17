import type { BoundingBox, DocumentPick, PickLocation } from './types'

/**
 * Dove cade un valore preso dal documento fra le righe che l'elaborazione ha salvato.
 *
 * Le righe sono quelle del motore di estrazione, non quelle del text layer del renderer:
 * una regola imparata da una selezione verrà applicata su queste righe, quindi è su queste
 * che la selezione va ritrovata. Qui non c'è né database né DOM: entrano righe e selezione,
 * esce la posizione.
 *
 * La regola che governa tutto: meglio nessuna posizione che una indovinata. Un valore che
 * compare due volte e che il riquadro non basta a distinguere resta senza offset.
 */

/** Una riga come la salva l'elaborazione: il testo e, quando ci sono, le coordinate. */
export interface PageLine {
  text: string
  bbox?: BoundingBox
}

/** Il valore del campo che corrisponde a una selezione: spazi e a capo ripiegati in uno. */
export function pickValue(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Il testo della pagina a cui si riferiscono gli offset: le righe unite da `\n`. */
export function pageText(lines: PageLine[]): string {
  return lines.map((line) => line.text).join('\n')
}

/** Frazione minima dell'altezza della riga più bassa che due riquadri devono condividere. */
const VERTICAL_OVERLAP = 0.5

function overlaps(line: BoundingBox, pick: BoundingBox): boolean {
  const vertical = Math.min(line.y + line.h, pick.y + pick.h) - Math.max(line.y, pick.y)
  const horizontal = Math.min(line.x + line.w, pick.x + pick.w) - Math.max(line.x, pick.x)
  return horizontal > 0 && vertical >= VERTICAL_OVERLAP * Math.min(line.h, pick.h)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface Occurrence {
  charStart: number
  charEnd: number
  lineStart: number
  lineEnd: number
}

/**
 * Le occorrenze del testo selezionato nella pagina, tollerando spazi e a capo diversi: la
 * selezione del renderer e le righe dell'estrazione non spezzano il testo negli stessi
 * punti. Prima il confronto esatto, poi senza maiuscole.
 */
function occurrences(lines: PageLine[], text: string): Occurrence[] {
  const tokens = text.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  const source = tokens.map(escapeRegExp).join('\\s+')
  const page = pageText(lines)

  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.text.length + 1
  }
  const lineAt = (char: number) => {
    let index = 0
    while (index + 1 < starts.length && starts[index + 1]! <= char) index += 1
    return index
  }

  for (const flags of ['g', 'gi']) {
    const found: Occurrence[] = []
    for (const match of page.matchAll(new RegExp(source, flags))) {
      const charStart = match.index
      const charEnd = charStart + match[0].length
      found.push({ charStart, charEnd, lineStart: lineAt(charStart), lineEnd: lineAt(charEnd - 1) })
    }
    if (found.length > 0) return found
  }
  return []
}

function toLocation(occurrence: Occurrence): PickLocation {
  return { ...occurrence }
}

/**
 * Stima orizzontale di dove comincia un'occorrenza, dalla proporzione dei caratteri sulla
 * riga. Serve solo a scegliere fra due occorrenze sulla stessa riga: «2026» nella data e
 * nel numero di protocollo.
 */
function estimatedX(lines: PageLine[], occurrence: Occurrence): number | null {
  const line = lines[occurrence.lineStart]
  if (!line?.bbox || line.text.length === 0) return null
  const lineStart = lines
    .slice(0, occurrence.lineStart)
    .reduce((offset, previous) => offset + previous.text.length + 1, 0)
  const column = occurrence.charStart - lineStart
  return line.bbox.x + (line.bbox.w * column) / line.text.length
}

/** Lo scarto oltre il quale due occorrenze sulla stessa riga si considerano distinguibili. */
const MIN_X_SEPARATION = 1

/**
 * La posizione della selezione, o `null` quando non si ritrova con certezza.
 *
 * - Con un riquadro e righe con coordinate, contano solo le righe che il riquadro tocca: fra
 *   le occorrenze del testo su quelle righe resta quella più vicina al bordo sinistro della
 *   selezione. Se il testo non si ritrova — un'area letta con OCR non coincide col text
 *   layer — o le occorrenze non si distinguono, restano le righe, senza offset.
 * - Senza coordinate (DOCX, pagine lette con OCR) decide il testo, e solo se compare una
 *   volta.
 */
export function locatePick(lines: PageLine[], pick: DocumentPick): PickLocation | null {
  if (lines.length === 0) return null
  const found = occurrences(lines, pick.text)

  const touched = pick.bbox
    ? lines.flatMap((line, index) => (line.bbox && overlaps(line.bbox, pick.bbox!) ? [index] : []))
    : []

  if (touched.length === 0) {
    return found.length === 1 ? toLocation(found[0]!) : null
  }

  const touchedSet = new Set(touched)
  const onTouched = found.filter((occurrence) => {
    for (let line = occurrence.lineStart; line <= occurrence.lineEnd; line += 1) {
      if (touchedSet.has(line)) return true
    }
    return false
  })

  if (onTouched.length === 1) return toLocation(onTouched[0]!)
  if (onTouched.length > 1) {
    const left = pick.bbox!.x
    const ranked = onTouched
      .map((occurrence) => ({ occurrence, x: estimatedX(lines, occurrence) }))
      .filter((entry): entry is { occurrence: Occurrence; x: number } => entry.x !== null)
      .map((entry) => ({ ...entry, distance: Math.abs(entry.x - left) }))
      .sort((a, b) => a.distance - b.distance)
    const [best, second] = ranked
    if (
      best &&
      ranked.length === onTouched.length &&
      (!second || second.distance - best.distance >= MIN_X_SEPARATION)
    ) {
      return toLocation(best.occurrence)
    }
  }

  // Le righe sono certe anche quando il punto esatto non lo è.
  return {
    lineStart: Math.min(...touched),
    lineEnd: Math.max(...touched),
    charStart: null,
    charEnd: null
  }
}
