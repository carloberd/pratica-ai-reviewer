import { describe, expect, it } from 'vitest'
import { locatePick, type PageLine, pageText, pickValue } from '../src/shared/pick-locate'
import type { DocumentPick } from '../src/shared/types'

/** Le righe di `fattura-righe.pdf` come le salva l'elaborazione (prima pagina, estratto). */
const INVOICE: PageLine[] = [
  { text: 'BETA COSTRUZIONI S.P.A.', bbox: { x: 56, y: 51, w: 141.81, h: 11 } },
  { text: 'FATTURA n. 27/2026 del 14/09/2026', bbox: { x: 56, y: 91, w: 181.6, h: 11 } },
  { text: 'Valuta: EUR', bbox: { x: 56, y: 171, w: 60.52, h: 11 } },
  { text: 'Totale imponibile EUR 5.500,00', bbox: { x: 56, y: 291, w: 158.34, h: 11 } },
  { text: 'Totale documento EUR 6.710,00', bbox: { x: 56, y: 331, w: 166.31, h: 11 } }
]

const selection = (text: string, bbox?: DocumentPick['bbox']): DocumentPick => ({
  method: 'TEXT_SELECTION',
  page: 1,
  text,
  ...(bbox ? { bbox } : {})
})

/** Il testo che la posizione indica, per leggere i test senza contare caratteri. */
function textAt(lines: PageLine[], pick: DocumentPick) {
  const location = locatePick(lines, pick)
  if (!location || location.charStart === null || location.charEnd === null) return location
  return pageText(lines).slice(location.charStart, location.charEnd)
}

describe('valore di una selezione', () => {
  it('ripiega spazi e a capo come fa il renderer', () => {
    expect(pickValue('  Beta Costruzioni\n S.p.A. ')).toBe('Beta Costruzioni S.p.A.')
  })
})

describe('posizione di una selezione fra le righe salvate', () => {
  it('il testo della pagina è fatto delle righe unite da a capo', () => {
    expect(pageText(INVOICE.slice(0, 2))).toBe(
      'BETA COSTRUZIONI S.P.A.\nFATTURA n. 27/2026 del 14/09/2026'
    )
  })

  it('senza coordinate un testo che compare una volta sola si ritrova', () => {
    expect(locatePick(INVOICE, selection('6.710,00'))).toEqual({
      lineStart: 4,
      lineEnd: 4,
      charStart: pageText(INVOICE).indexOf('6.710,00'),
      charEnd: pageText(INVOICE).indexOf('6.710,00') + 8
    })
  })

  it('senza coordinate un testo ripetuto non si indovina', () => {
    expect(locatePick(INVOICE, selection('EUR'))).toBeNull()
  })

  it('il riquadro sceglie la riga fra le occorrenze ripetute', () => {
    const location = locatePick(INVOICE, selection('EUR', { x: 180, y: 331, w: 20, h: 11 }))
    expect(location).toMatchObject({ lineStart: 4, lineEnd: 4 })
    expect(pageText(INVOICE).slice(location!.charStart!, location!.charEnd!)).toBe('EUR')
  })

  it('sulla stessa riga decide il bordo sinistro della selezione', () => {
    const line: PageLine[] = [{ text: 'Prot. 2026 del 2026', bbox: { x: 0, y: 0, w: 190, h: 10 } }]
    // Ogni carattere è largo 10: il secondo «2026» comincia a x = 150.
    expect(locatePick(line, selection('2026', { x: 150, y: 0, w: 40, h: 10 }))).toEqual({
      lineStart: 0,
      lineEnd: 0,
      charStart: 15,
      charEnd: 19
    })
    expect(locatePick(line, selection('2026', { x: 60, y: 0, w: 40, h: 10 }))).toMatchObject({
      charStart: 6
    })
  })

  it('due occorrenze che il riquadro non distingue lasciano solo le righe', () => {
    const line: PageLine[] = [{ text: 'EUR EUR', bbox: { x: 0, y: 0, w: 70, h: 10 } }]
    // Il bordo sinistro sta esattamente a metà fra le due.
    expect(locatePick(line, selection('EUR', { x: 20, y: 0, w: 10, h: 10 }))).toEqual({
      lineStart: 0,
      lineEnd: 0,
      charStart: null,
      charEnd: null
    })
  })

  it('una selezione su due righe le copre entrambe, qualunque sia lo spazio fra le parole', () => {
    const across = selection('S.P.A.   FATTURA n.', { x: 56, y: 51, w: 181, h: 51 })
    expect(textAt(INVOICE, across)).toBe('S.P.A.\nFATTURA n.')
    expect(locatePick(INVOICE, across)).toMatchObject({ lineStart: 0, lineEnd: 1 })
  })

  it('senza corrispondenza esatta prova senza maiuscole', () => {
    expect(textAt(INVOICE, selection('beta costruzioni'))).toBe('BETA COSTRUZIONI')
  })

  it('un’area letta con OCR che non coincide col testo lascia le righe toccate', () => {
    const area: DocumentPick = {
      method: 'AREA_OCR',
      page: 1,
      text: 'Tota1e documento EUR 6.71O,OO',
      bbox: { x: 50, y: 285, w: 200, h: 60 }
    }
    expect(locatePick(INVOICE, area)).toEqual({
      lineStart: 3,
      lineEnd: 4,
      charStart: null,
      charEnd: null
    })
  })

  it('senza righe salvate non c’è posizione', () => {
    expect(locatePick([], selection('27/2026'))).toBeNull()
  })

  it('su righe senza coordinate (DOCX, OCR) il riquadro non conta e decide il testo', () => {
    const docx: PageLine[] = [
      { text: 'Contratto n. CC-2026-018' },
      { text: 'Compenso EUR 2.000,00' }
    ]
    expect(locatePick(docx, selection('CC-2026-018', { x: 0, y: 0, w: 10, h: 10 }))).toMatchObject({
      lineStart: 0,
      charStart: 13,
      charEnd: 24
    })
  })
})
