import { unionRect } from '@shared/evidence-locate'
import type { BoundingBox } from '@shared/types'

/** Un carattere del text layer col suo riquadro, in coordinate di pagina a scala 1. */
export interface AreaChar {
  char: string
  rect: BoundingBox
}

/** La selezione ad area letta dal testo: quello che c'è dentro, e dove sta. */
export interface AreaSelection {
  text: string
  bbox: BoundingBox
}

/**
 * Il testo che cade dentro l'area evidenziata, preso dal text layer invece che dai pixel.
 *
 * Il riquadro non si ferma ai bordi di uno span — uno span di pdf.js può essere una riga
 * intera — quindi si decide carattere per carattere: dentro è chi ha il centro dentro. Il
 * centro e non la sovrapposizione, perché un carattere sul bordo sta di qua o di là, e
 * mezzo carattere non è un carattere.
 *
 * Le righe si ricostruiscono dal salto verticale fra un carattere e il precedente: il text
 * layer non dice dove finisce una riga, ma due caratteri su righe diverse hanno i centri
 * lontani più di mezza altezza. `null` se nel riquadro non è rimasto niente da leggere.
 */
export function areaText(chars: AreaChar[], box: BoundingBox): AreaSelection | null {
  const inside = chars.filter((entry) => {
    const x = entry.rect.x + entry.rect.w / 2
    const y = entry.rect.y + entry.rect.h / 2
    return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h
  })
  if (inside.length === 0) return null

  const lines: AreaChar[][] = []
  for (const entry of inside) {
    const line = lines.at(-1)
    const previous = line?.at(-1)?.rect
    if (!line || (previous && newLine(previous, entry.rect))) lines.push([entry])
    else line.push(entry)
  }

  // Gli spazi ai bordi del riquadro non fanno parte di quello che è stato evidenziato, e
  // restano fuori anche dal riquadro: il `bbox` è quello del testo, non del gesto.
  const trimmed = lines.map(blankEnds).filter((line) => line.length > 0)
  const text = trimmed.map((line) => line.map((entry) => entry.char).join('')).join('\n')
  const bbox = unionRect(trimmed.flat().map((entry) => entry.rect))
  if (!text || !bbox) return null
  return { text, bbox }
}

/** La riga senza gli spazi in testa e in coda. */
function blankEnds(line: AreaChar[]): AreaChar[] {
  let start = 0
  let end = line.length
  while (start < end && line[start]!.char.trim() === '') start += 1
  while (end > start && line[end - 1]!.char.trim() === '') end -= 1
  return line.slice(start, end)
}

/** Due caratteri stanno su righe diverse quando i centri distano più di mezza altezza. */
function newLine(previous: BoundingBox, current: BoundingBox): boolean {
  const gap = Math.abs(previous.y + previous.h / 2 - (current.y + current.h / 2))
  return gap > Math.min(previous.h, current.h) / 2
}
