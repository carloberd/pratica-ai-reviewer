import { describe, expect, it } from 'vitest'
import { selectionBox } from '../../src/renderer/src/lib/selection'

/** Una pagina resa a scala 2, a 100 px dal bordo sinistro e 40 dall'alto della finestra. */
const PAGE = { left: 100, top: 40, width: 1190, height: 1684 }

describe('riquadro di una selezione nel text layer', () => {
  it('unisce i frammenti e li riporta in coordinate di pagina a scala 1', () => {
    const rects = [
      { left: 212, top: 222, width: 60, height: 22 },
      { left: 280, top: 222, width: 90, height: 22 }
    ]
    expect(selectionBox(rects, PAGE, 2)).toEqual({ x: 56, y: 91, w: 79, h: 11 })
  })

  it('ignora i frammenti vuoti e quelli della pagina accanto', () => {
    const rects = [
      { left: 212, top: 222, width: 60, height: 22 },
      { left: 212, top: 222, width: 0, height: 22 },
      { left: 212, top: 1800, width: 60, height: 22 }
    ]
    expect(selectionBox(rects, PAGE, 2)).toEqual({ x: 56, y: 91, w: 30, h: 11 })
  })

  it('non dà coordinate negative a un frammento che sborda', () => {
    expect(selectionBox([{ left: 96, top: 36, width: 20, height: 20 }], PAGE, 2)).toEqual({
      x: 0,
      y: 0,
      w: 8,
      h: 8
    })
  })

  it('senza frammenti nella pagina non c’è riquadro', () => {
    expect(selectionBox([], PAGE, 2)).toBeNull()
  })
})
