import { describe, expect, it } from 'vitest'
import {
  TEMPLATE_FINGERPRINT_LENGTH,
  TEMPLATE_LINE_LENGTH,
  templateFingerprint,
  templateLine
} from '../src/shared/template-fingerprint'

/** Lo stesso stampato, compilato due volte con dati diversi. */
const PRIMA = [
  'ALFA COSTRUZIONI S.R.L.',
  'Via Garibaldi 12 - 40100 Bologna',
  'FATTURA n. 114/2026 del 08/09/2026',
  'Cliente: Beta Immobiliare S.p.A.',
  'Totale documento EUR 86.420,00'
]

const SECONDA = [
  'ALFA COSTRUZIONI S.R.L.',
  'Via Garibaldi 12 - 40100 Bologna',
  'FATTURA n. 27/2026 del 14/09/2026',
  'Cliente: Gamma Immobiliare S.r.l.',
  'Totale documento EUR 4.900,50'
]

/** Un altro stampato: altre righe, altre etichette. */
const ALTRO_STAMPATO = [
  'COMUNE DI BOLOGNA',
  'CERTIFICATO DI DESTINAZIONE URBANISTICA',
  'Protocollo 2026/0004512 del 08/09/2026',
  'Foglio 12 particella 340'
]

describe('impronta del layout', () => {
  it('toglie i dati e tiene la forma della riga', () => {
    expect(templateLine('FATTURA n. 114/2026 del 08/09/2026')).toBe('A A. 9/9 A 9/9/9')
    expect(templateLine('  Totale   documento   EUR 86.420,00  ')).toBe('A A A 9.9,9')
  })

  it('tronca le righe lunghe alla lunghezza fissa', () => {
    expect(templateLine('parola '.repeat(80))).toHaveLength(TEMPLATE_LINE_LENGTH)
  })

  it('stesso stampato con dati diversi: stessa impronta', () => {
    expect(templateFingerprint(SECONDA)).toBe(templateFingerprint(PRIMA))
  })

  it('layout diverso: impronta diversa', () => {
    expect(templateFingerprint(ALTRO_STAMPATO)).not.toBe(templateFingerprint(PRIMA))
  })

  it('una riga in più cambia il layout, e quindi l’impronta', () => {
    expect(templateFingerprint([...PRIMA, 'Pagamento a 30 giorni'])).not.toBe(
      templateFingerprint(PRIMA)
    )
  })

  it('spazi e righe vuote non contano', () => {
    expect(templateFingerprint(['', '   ', ...PRIMA, ''])).toBe(templateFingerprint(PRIMA))
  })

  it('è stabile: sedici caratteri esadecimali, sempre gli stessi', () => {
    const fingerprint = templateFingerprint(PRIMA)!
    expect(fingerprint).toMatch(new RegExp(`^[0-9a-f]{${TEMPLATE_FINGERPRINT_LENGTH}}$`))
    expect(templateFingerprint(PRIMA)).toBe(fingerprint)
  })

  it('senza testo non c’è impronta: le scansioni non si raggruppano fra loro', () => {
    expect(templateFingerprint([])).toBeNull()
    expect(templateFingerprint(['', '  ', '\n'])).toBeNull()
  })
})
