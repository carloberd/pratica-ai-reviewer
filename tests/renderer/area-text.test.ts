import { describe, expect, it } from 'vitest'
import { type AreaChar, areaText } from '../../src/renderer/src/lib/area-text'

/**
 * Una riga di testo come la misurerebbe il text layer: caratteri larghi 6 e alti 11, in
 * coordinate di pagina a scala 1.
 */
function line(text: string, x: number, y: number): AreaChar[] {
  return Array.from(text).map((char, index) => ({
    char,
    rect: { x: x + index * 6, y, w: 6, h: 11 }
  }))
}

const FATTURA = line('FATTURA n. 114/2026 del 08/09/2026', 56, 111)

describe('testo dentro un’area evidenziata', () => {
  it('prende i caratteri col centro dentro il riquadro, non lo span intero', () => {
    // Uno span di pdf.js può essere tutta la riga: il riquadro attorno al solo numero
    // deve dare il numero, o il valore arriverebbe nel campo con tutta la riga dietro.
    const picked = areaText(FATTURA, { x: 120, y: 108, w: 54, h: 17 })
    expect(picked?.text).toBe('114/2026')
    expect(picked?.bbox).toEqual({ x: 122, y: 111, w: 48, h: 11 })
  })

  it('un carattere a metà sul bordo sta di là: mezzo carattere non è un carattere', () => {
    // Il primo «1» va da 122 a 128, col centro a 125: un riquadro che comincia a 126 lo
    // lascia fuori, e la lettura parte dal secondo.
    expect(areaText(FATTURA, { x: 126, y: 108, w: 48, h: 17 })?.text).toBe('14/2026')
  })

  it('l’area che prende più righe le tiene separate', () => {
    const chars = [...line('Emittente', 56, 111), ...line('FIDITALIA S.P.A.', 56, 125)]
    expect(areaText(chars, { x: 50, y: 105, w: 120, h: 40 })?.text).toBe(
      'Emittente\nFIDITALIA S.P.A.'
    )
  })

  it('gli spazi ai bordi non entrano nel valore', () => {
    expect(areaText(FATTURA, { x: 105, y: 108, w: 65, h: 17 })?.text).toBe('n. 114/2026')
  })

  it('un riquadro dove non cade nessun carattere non è una selezione', () => {
    // È il caso della scansione, dove il text layer non c'è: si passa all'OCR.
    expect(areaText(FATTURA, { x: 56, y: 400, w: 200, h: 30 })).toBeNull()
    expect(areaText([], { x: 56, y: 111, w: 200, h: 30 })).toBeNull()
  })

  it('un riquadro che prende solo spazi non è una selezione', () => {
    expect(areaText(line('    ', 56, 111), { x: 50, y: 105, w: 40, h: 20 })).toBeNull()
  })
})
