import { describe, expect, it } from 'vitest'
import { compose, imageToPage, type Matrix, pageBox } from '../src/main/extract/page-placement'

/** Una A4 a scala 1 in pdf.js: l'asse y si ribalta e l'origine va in alto a sinistra. */
const VIEWPORT: Matrix = [1, 0, 0, -1, 0, 842]

/** La scansione di una A4: l'immagine copre tutta la pagina (`cm 595 0 0 842 0 0`). */
const FULL_PAGE: Matrix = [595, 0, 0, 842, 0, 0]
const WIDTH = 1240
const HEIGHT = 1754

describe('dai pixel della scansione alle unità di pagina', () => {
  const matrix = imageToPage(FULL_PAGE, VIEWPORT, WIDTH, HEIGHT)!

  it('il primo pixel in alto a sinistra è l’origine della pagina', () => {
    expect(pageBox(matrix, { x0: 0, y0: 0, x1: 4, y1: 4 })).toMatchObject({ x: 0, y: 0 })
  })

  it('l’immagine intera è la pagina intera', () => {
    const box = pageBox(matrix, { x0: 0, y0: 0, x1: WIDTH, y1: HEIGHT })
    expect(box?.x).toBeCloseTo(0, 6)
    expect(box?.y).toBeCloseTo(0, 6)
    expect(box?.w).toBeCloseTo(595, 6)
    expect(box?.h).toBeCloseTo(842, 6)
  })

  it('una riga a metà foglio cade a metà pagina, e la y cresce verso il basso', () => {
    const first = pageBox(matrix, { x0: 124, y0: 100, x1: 800, y1: 140 })!
    const second = pageBox(matrix, { x0: 124, y0: 877, x1: 800, y1: 917 })!
    expect(first.x).toBeCloseTo(59.5, 6)
    expect(first.y).toBeCloseTo((100 / HEIGHT) * 842, 6)
    expect(second.y).toBeCloseTo(421, 6)
    expect(second.y).toBeGreaterThan(first.y)
  })

  it('una scansione messa a metà pagina resta a metà pagina', () => {
    // `cm 297.5 0 0 421 297.5 421`: l'immagine occupa il quarto in alto a destra.
    const quarter = imageToPage([297.5, 0, 0, 421, 297.5, 421], VIEWPORT, WIDTH, HEIGHT)!
    const box = pageBox(quarter, { x0: 0, y0: 0, x1: WIDTH, y1: HEIGHT })
    expect(box?.x).toBeCloseTo(297.5, 6)
    expect(box?.y).toBeCloseTo(0, 6)
    expect(box?.w).toBeCloseTo(297.5, 6)
    expect(box?.h).toBeCloseTo(421, 6)
  })

  it('una scansione girata di 90° dà comunque un riquadro allineato agli assi', () => {
    // Tutti e quattro gli angoli, non due: con gli assi scambiati due soli darebbero un
    // rettangolo al contrario, cioè largo e alto negativi.
    const turned = imageToPage([0, 842, 595, 0, 0, 0], VIEWPORT, WIDTH, HEIGHT)!
    const box = pageBox(turned, { x0: 0, y0: 0, x1: WIDTH / 2, y1: HEIGHT })!
    expect(box.w).toBeGreaterThan(0)
    expect(box.h).toBeGreaterThan(0)
  })

  it('senza dimensioni non c’è collocazione, e un riquadro schiacciato non è un riquadro', () => {
    expect(imageToPage(FULL_PAGE, VIEWPORT, 0, HEIGHT)).toBeNull()
    expect(pageBox(matrix, { x0: 10, y0: 10, x1: 10, y1: 40 })).toBeNull()
  })

  it('comporre due matrici è applicarle nell’ordine giusto', () => {
    // Prima raddoppia, poi sposta di 10: il punto 1 finisce a 12, non a 21.
    const scaled: Matrix = [2, 0, 0, 2, 0, 0]
    const moved: Matrix = [1, 0, 0, 1, 10, 0]
    expect(compose(moved, scaled)).toEqual([2, 0, 0, 2, 10, 0])
    expect(compose(scaled, moved)).toEqual([2, 0, 0, 2, 20, 0])
  })
})
