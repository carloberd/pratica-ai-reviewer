import { unionRect } from '@shared/evidence-locate'
import type { BoundingBox } from '@shared/types'

/** Quanto serve di un `DOMRect`: così la geometria si prova senza un DOM. */
export interface ClientRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Il riquadro di una selezione in coordinate di pagina pdf.js a scala 1, con origine in
 * alto a sinistra: le stesse delle evidenze del motore e delle righe salvate
 * dall'elaborazione, su cui il main ritroverà la selezione.
 *
 * Contano solo i rettangoli che cadono nella pagina: una selezione trascinata oltre il
 * bordo porta con sé frammenti della pagina accanto, e il valore si attribuisce alla
 * pagina dove comincia. `null` se non resta niente.
 */
export function selectionBox(
  rects: ClientRect[],
  page: ClientRect,
  scale: number
): BoundingBox | null {
  const inside = rects.filter(
    (rect) =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.left < page.left + page.width &&
      rect.left + rect.width > page.left &&
      rect.top < page.top + page.height &&
      rect.top + rect.height > page.top
  )
  const union = unionRect(
    inside.map((rect) => ({
      x: (rect.left - page.left) / scale,
      y: (rect.top - page.top) / scale,
      w: rect.width / scale,
      h: rect.height / scale
    }))
  )
  if (!union) return null
  // Un frammento che sborda di un pixel non deve dare coordinate negative.
  const x = Math.max(0, union.x)
  const y = Math.max(0, union.y)
  return { x, y, w: union.w - (x - union.x), h: union.h - (y - union.y) }
}
