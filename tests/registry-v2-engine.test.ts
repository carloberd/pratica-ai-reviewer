import { describe, expect, it } from 'vitest'
import { classifyWithSelectedEngine } from '../src/main/registry/v2/engine'
import { testClassifierConfigV2, testRegistry } from './helpers/registry'

const aliases = testRegistry().aliases()
const configV2 = testClassifierConfigV2()
const invoice = ['ALFA S.R.L.\nFATTURA n. 114/2026 del 08/09/2026']

describe('scelta del motore di classificazione', () => {
  it('v1 legge solo la prima pagina e restituisce il match di sempre', () => {
    const result = classifyWithSelectedEngine({
      engine: 'v1',
      aliases,
      pages: ['copertina', ...invoice],
      filename: 'documento.pdf',
      configV2: undefined
    })
    expect(result).toEqual({ engine: 'v1', documentType: null, confidence: null, match: null })

    const firstPage = classifyWithSelectedEngine({
      engine: 'v1',
      aliases,
      pages: invoice,
      filename: 'documento.pdf',
      configV2: undefined
    })
    expect(firstPage).toMatchObject({
      engine: 'v1',
      documentType: 'accounting.fattura',
      confidence: 0.9,
      match: { phrase: 'fattura', source: 'first-page' }
    })
  })

  it('v2 legge anche la seconda pagina', () => {
    const result = classifyWithSelectedEngine({
      engine: 'v2',
      aliases,
      pages: ['copertina', ...invoice],
      filename: 'documento.pdf',
      configV2
    })
    // Fuori dalla zona del titolo la frase pesa meno e da sola non basta ad assegnare,
    // ma il candidato c'è: il v1 qui non vedeva niente.
    if (result.engine !== 'v2') throw new Error('atteso il motore v2')
    expect(result.match.candidates[0]).toMatchObject({ documentType: 'accounting.fattura' })
    expect(result.match.evidence.map((item) => item.source)).toContain('page')
    expect(result.match.reason).toBe('BELOW_THRESHOLD')
  })

  it('un UNKNOWN del v2 non ha confidence di tipo', () => {
    // Una confidence con tipo nullo farebbe credere alla pipeline che il tipo sia manuale.
    const result = classifyWithSelectedEngine({
      engine: 'v2',
      aliases,
      pages: ['testo senza indizi utili'],
      filename: 'Fattura 114.pdf',
      configV2
    })
    expect(result.engine === 'v2' && result.match.reason).toBe('FILENAME_ONLY')
    expect(result.documentType).toBeNull()
    expect(result.confidence).toBeNull()
  })

  it('v2 senza configurazione è un errore esplicito', () => {
    expect(() =>
      classifyWithSelectedEngine({
        engine: 'v2',
        aliases,
        pages: invoice,
        filename: 'documento.pdf',
        configV2: undefined
      })
    ).toThrow(/senza la configurazione/)
  })
})
