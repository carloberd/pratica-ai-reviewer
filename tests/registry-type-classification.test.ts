import { describe, expect, it } from 'vitest'
import { matchDocumentTypeV2 } from '../src/main/registry/v2/classify-v2'
import { locatePhrase, toTypeClassification } from '../src/main/registry/v2/type-classification'
import { testClassifierConfigV2 } from './helpers/registry'

const config = testClassifierConfigV2()

const pages = [
  {
    page: 1,
    lines: [
      { text: 'CONTRATTO QUADRO DI FORNITURA BENI', bbox: { x: 56, y: 50, w: 250, h: 11 } },
      { text: 'Contratto quadro di fornitura lavori' }
    ]
  },
  { page: 2, lines: [{ text: 'Regolarità contributiva: DURC n. 12' }] }
]

describe('frase del classificatore nel documento', () => {
  it('ritrova la riga con la stessa normalizzazione, con le coordinate se ci sono', () => {
    expect(locatePhrase(pages, 'contratto quadro di fornitura beni')).toEqual({
      page: 1,
      text: 'CONTRATTO QUADRO DI FORNITURA BENI',
      bbox: { x: 56, y: 50, w: 250, h: 11 }
    })
    expect(locatePhrase(pages, 'regolarita contributiva')).toEqual({
      page: 2,
      text: 'Regolarità contributiva: DURC n. 12'
    })
    expect(locatePhrase(pages, 'fattura')).toBeUndefined()
    expect(locatePhrase(pages, '  ')).toBeUndefined()
  })
})

describe('classificazione per la revisione', () => {
  it('v2 UNKNOWN: candidati col punteggio, frasi raggiungibili, soglie del file', () => {
    const match = matchDocumentTypeV2({
      aliases: [
        {
          documentType: 'contracts_general.contratto_fornitura',
          phrase: 'contratto quadro di fornitura beni'
        },
        {
          documentType: 'contracts_general.contratto_quadro',
          phrase: 'contratto quadro di fornitura lavori'
        }
      ],
      pages: pages.map((page) => page.lines.map((line) => line.text).join('\n')),
      filename: 'contratto quadro.pdf',
      config
    })
    const stored = toTypeClassification({
      classification: { engine: 'v2', documentType: null, confidence: null, match },
      pages,
      config
    })

    expect(stored).toMatchObject({
      engine: 'v2',
      version: config.version,
      decision: 'UNKNOWN',
      reason: 'LOW_MARGIN',
      proposedType: null,
      threshold: config.defaults.auto_assign_threshold,
      minimumMargin: config.defaults.minimum_margin
    })
    expect(stored.candidates.map((candidate) => candidate.documentType)).toEqual([
      'contracts_general.contratto_fornitura',
      'contracts_general.contratto_quadro'
    ])
    const [title] = stored.candidates[0]!.signals
    expect(title).toMatchObject({
      source: 'title-zone',
      phrase: 'contratto quadro di fornitura beni',
      location: { page: 1, text: 'CONTRATTO QUADRO DI FORNITURA BENI' }
    })
    // Il bonus di corroborazione non è una frase del documento.
    expect(stored.candidates.flatMap((c) => c.signals).some((s) => s.phrase.startsWith('__'))).toBe(
      false
    )
  })

  it('v2: il nome del file non ha una riga da raggiungere', () => {
    const match = matchDocumentTypeV2({
      aliases: [{ documentType: 'accounting.fattura', phrase: 'fattura' }],
      pages: ['testo senza indizi'],
      filename: 'Fattura 114.pdf',
      config
    })
    const stored = toTypeClassification({
      classification: { engine: 'v2', documentType: null, confidence: null, match },
      pages: [{ page: 1, lines: [{ text: 'testo senza indizi' }] }],
      config
    })
    expect(stored.candidates[0]!.signals).toEqual([
      { source: 'filename', phrase: 'fattura', delta: expect.any(Number) }
    ])
  })

  it('v1: un solo candidato, quello del match', () => {
    const stored = toTypeClassification({
      classification: {
        engine: 'v1',
        documentType: 'payroll_contributions.durc',
        confidence: 0.9,
        match: {
          documentType: 'payroll_contributions.durc',
          confidence: 0.9,
          phrase: 'regolarità contributiva',
          source: 'first-page'
        }
      },
      pages
    })
    expect(stored).toMatchObject({
      engine: 'v1',
      decision: 'ASSIGN',
      proposedType: 'payroll_contributions.durc',
      margin: null,
      candidates: [{ documentType: 'payroll_contributions.durc', score: 0.9 }]
    })
    // Il v1 legge solo la prima pagina: la frase in seconda non si cerca.
    expect(stored.candidates[0]!.signals[0]!.location).toBeUndefined()

    const none = toTypeClassification({
      classification: { engine: 'v1', documentType: null, confidence: null, match: null },
      pages
    })
    expect(none).toMatchObject({ decision: 'UNKNOWN', proposedType: null, candidates: [] })
  })
})
