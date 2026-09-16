import { describe, expect, it } from 'vitest'
import TypeCandidates from '../../src/renderer/src/components/type-candidates'
import type { TypeClassification } from '../../src/shared/types'
import { count, html, text } from './render'

const classification: TypeClassification = {
  engine: 'v2',
  version: '2.0.0-draft.1',
  decision: 'UNKNOWN',
  reason: 'LOW_MARGIN',
  proposedType: null,
  confidence: 0.82,
  margin: 0.02,
  threshold: 0.74,
  minimumMargin: 0.08,
  candidates: [
    {
      documentType: 'contracts_general.contratto_fornitura',
      label: 'contratto fornitura',
      score: 0.82,
      signals: [
        {
          source: 'title-zone',
          phrase: 'contratto quadro di fornitura beni',
          delta: 0.8,
          location: { page: 1, text: 'CONTRATTO QUADRO DI FORNITURA BENI' }
        },
        { source: 'negative-signal', phrase: 'lavori', delta: -0.28 }
      ]
    },
    {
      documentType: 'contracts_general.contratto_quadro',
      label: null,
      score: 0.8,
      signals: []
    }
  ]
}

const props = { disabled: false, onAssign: () => {}, onFocusEvidence: () => {} }

describe('TypeCandidates', () => {
  it('tipo UNKNOWN: candidati in vista col punteggio, il motivo e le frasi del documento', () => {
    const document = { documentType: null, typeConfidence: null, classification }
    const markup = html(<TypeCandidates {...props} document={document} />)
    const view = text(<TypeCandidates {...props} document={document} />)

    expect(markup).toContain('data-suggested="true"')
    expect(view).toContain('il margine sul secondo candidato è troppo stretto')
    expect(view).toContain('contratto fornitura contracts_general.contratto_fornitura 82%')
    expect(view).toContain('+ «contratto quadro di fornitura beni» nel titolo')
    expect(view).toContain('− «lavori» segnale contrario')
    // Senza etichetta nel registry si vede l'id.
    expect(view).toContain('contracts_general.contratto_quadro 80%')
    expect(count(markup, 'Assegna questo tipo')).toBe(2)
    expect(count(markup, 'Mostra nel documento')).toBe(1)
  })

  it('tipo assegnato con margine ampio: candidati chiusi, il tipo attuale non si riassegna', () => {
    const document = {
      documentType: 'contracts_general.contratto_fornitura',
      typeConfidence: 0.82,
      classification: {
        ...classification,
        decision: 'ASSIGN' as const,
        reason: 'OK' as const,
        margin: 0.3
      }
    }
    const markup = html(<TypeCandidates {...props} document={document} />)
    expect(markup).toContain('<details')
    expect(markup).toContain('Candidati del classificatore (2)')
    expect(markup).toContain('Tipo attuale')
    expect(count(markup, 'Assegna questo tipo')).toBe(1)
  })

  it('senza classificazione non mostra niente; senza candidati spiega e rimanda alla ricerca', () => {
    expect(
      html(
        <TypeCandidates
          {...props}
          document={{ documentType: null, typeConfidence: null, classification: null }}
        />
      )
    ).toBe('')
    const view = text(
      <TypeCandidates
        {...props}
        document={{
          documentType: null,
          typeConfidence: null,
          classification: { ...classification, reason: 'NO_SIGNAL', candidates: [] }
        }}
      />
    )
    expect(view).toContain('nessun alias o segnale del registry compare nel testo')
    expect(view).toContain('Cerca il tipo fra quelli del registry')
  })
})
