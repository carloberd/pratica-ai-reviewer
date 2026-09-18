import { describe, expect, it } from 'vitest'
import { isCleanup, keepsPick, pickOfEvidence } from '../src/shared/pick-cleanup'
import type { DocumentPick, EvidenceItem } from '../src/shared/types'

/**
 * I valori sono quelli dell'export del 18/09/2026: i campi che sulle scansioni erano
 * rimasti senza selezione sono OCR ripulito a mano.
 */
describe('una lettura sistemata è la stessa lettura', () => {
  it('riconosce le ripuliture di un OCR che ha letto male', () => {
    expect(isCleanup('29 O7 2026', '29 07 2026')).toBe(true)
    expect(isCleanup('FRAITA (MAB)', 'FRAITA (MAR)')).toBe(true)
    expect(isCleanup('10 Il 1994', '10 11 1994')).toBe(true)
    expect(isCleanup('REPUBBLICA lTALlANA MINISTERO', 'REPUBBLICA ITALIANA MINISTERO')).toBe(true)
  })

  it('maiuscole, accenti e spazi non fanno una lettura diversa', () => {
    expect(isCleanup('COMUNE  DI\nROVIGO', 'Comune di Rovigo')).toBe(true)
    expect(isCleanup('Città', 'Citta')).toBe(true)
  })

  it('un valore diverso non è una ripulitura', () => {
    expect(isCleanup('114/2026', '114/2026-bis')).toBe(false)
    expect(isCleanup('200', 'B/2600143')).toBe(false)
    expect(isCleanup('Fornitura materiali edili', 'Posa in opera')).toBe(false)
    expect(isCleanup('08/09/2026', '')).toBe(false)
  })

  it('su un valore cortissimo un carattere sistemato basta', () => {
    // Un terzo di due caratteri sarebbe zero: nessuna correzione passerebbe mai.
    expect(isCleanup('2O', '20')).toBe(true)
    expect(isCleanup('20', '35')).toBe(false)
  })
})

describe('quando la selezione resta l’origine di un valore diverso dal suo testo', () => {
  const pick = (method: DocumentPick['method']): DocumentPick => ({
    method,
    page: 1,
    text: '29 O7 2026'
  })

  it('solo sull’area letta con l’OCR: lì il testo l’ha letto una macchina', () => {
    expect(keepsPick(pick('AREA_OCR'), '29 O7 2026', '29 07 2026')).toBe(true)
  })

  it('non sul testo selezionato né sull’area letta dal text layer', () => {
    // Quel testo viene dal documento: un valore che non coincide è un valore diverso,
    // e la selezione non ne è più l'origine.
    expect(keepsPick(pick('TEXT_SELECTION'), '29 O7 2026', '29 07 2026')).toBe(false)
    expect(keepsPick(pick('AREA_TEXT'), '29 O7 2026', '29 07 2026')).toBe(false)
  })

  it('e non per un valore che con quella lettura non c’entra', () => {
    expect(keepsPick(pick('AREA_OCR'), '29 O7 2026', 'COMUNE DI ROVIGO')).toBe(false)
  })
})

describe('la selezione che un valore aveva già', () => {
  const evidence = (extra: Partial<EvidenceItem>): EvidenceItem => ({
    id: 'e1',
    label: 'Scadenza',
    page: 2,
    text: '29 O7 2026',
    confidence: 1,
    origin: 'REVIEWER',
    method: 'AREA_OCR',
    ...extra
  })

  it('si rimanda al main come l’ha mandata il renderer, riquadro compreso', () => {
    const bbox = { x: 56, y: 111, w: 90, h: 12 }
    expect(pickOfEvidence(evidence({ bbox }))).toEqual({
      method: 'AREA_OCR',
      page: 2,
      text: '29 O7 2026',
      bbox
    })
  })

  it('una lettura del motore non è una selezione del revisore', () => {
    expect(pickOfEvidence(evidence({ origin: 'ENGINE', method: undefined }))).toBeUndefined()
    expect(pickOfEvidence(undefined)).toBeUndefined()
  })
})
