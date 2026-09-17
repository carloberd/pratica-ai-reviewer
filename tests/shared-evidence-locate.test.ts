import { describe, expect, it } from 'vitest'
import {
  findTextRange,
  firstLine,
  matchSpans,
  targetOfEvidence,
  targetOfLocation,
  unionRect
} from '../src/shared/evidence-locate'

describe('bersaglio di un’evidenza', () => {
  it('porta pagina, testo e rettangolo quando c’è', () => {
    const bbox = { x: 56, y: 50, w: 200, h: 11 }
    expect(
      targetOfEvidence({
        id: 'e1',
        label: 'Totale',
        page: 2,
        text: 'Totale',
        confidence: 1,
        bbox,
        origin: 'ENGINE'
      })
    ).toEqual({ page: 2, text: 'Totale', bbox, evidenceId: 'e1' })
    expect(targetOfLocation({ page: 1, text: 'FATTURA n. 114' })).toEqual({
      page: 1,
      text: 'FATTURA n. 114'
    })
  })

  it('di un’evidenza su due righe si cerca la prima', () => {
    expect(firstLine('\n  Totale documento\nEUR 86.420,00')).toBe('Totale documento')
  })
})

describe('riga nel testo del DOCX', () => {
  const text = 'CONTRATTO CONSULENZA\n\nDocumento n.  CC-2026-018\nData di emissione: 15/09/2026'

  it('tollera spazi e a capo diversi', () => {
    const range = findTextRange(text, 'Documento n. CC-2026-018')
    expect(range && text.slice(range.start, range.end)).toBe('Documento n.  CC-2026-018')
  })

  it('ripiega sul confronto senza maiuscole, e dice quando non trova', () => {
    const range = findTextRange(text, 'contratto consulenza')
    expect(range).toEqual({ start: 0, end: 20 })
    expect(findTextRange(text, 'Partita IVA')).toBeNull()
    expect(findTextRange(text, '   ')).toBeNull()
  })
})

describe('riga nel text layer del PDF', () => {
  it('trova i frammenti che la compongono ignorando gli spazi', () => {
    const spans = ['ALFA S.R.L.', 'FATTURA n. ', '114/2026', ' del 08/09/2026', 'Emittente:']
    expect(matchSpans(spans, 'FATTURA n. 114/2026 del 08/09/2026')).toEqual([1, 3])
    expect(matchSpans(spans, 'emittente:')).toEqual([4, 4])
    expect(matchSpans(spans, 'Destinatario')).toBeNull()
    expect(matchSpans(spans, '')).toBeNull()
  })

  it('unisce i rettangoli dei frammenti', () => {
    expect(
      unionRect([
        { x: 10, y: 20, w: 30, h: 10 },
        { x: 45, y: 18, w: 20, h: 12 }
      ])
    ).toEqual({ x: 10, y: 18, w: 55, h: 12 })
    expect(unionRect([])).toBeNull()
  })
})
