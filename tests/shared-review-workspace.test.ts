import { describe, expect, it } from 'vitest'
import {
  groupFieldsForReview,
  hasEngineProposal,
  isFieldEmpty,
  shouldSuggestCandidates
} from '../src/shared/review-workspace'
import type { TypeClassification } from '../src/shared/types'
import { item, listField, reviewDocument, scalarField } from './helpers/review-document'

describe('campi da compilare a mano', () => {
  const fields = [
    scalarField({ id: 'number', value: '114/2026' }),
    scalarField({ id: 'iban', value: '', role: 'conditional', required: false }),
    scalarField({ id: 'tax', value: '', role: 'core', required: false }),
    scalarField({ id: 'total', value: '', role: 'required', correctedValue: '86420.00' }),
    listField([], { id: 'lines' }),
    listField([item()], { id: 'lines-proposed' })
  ]

  it('il gruppo dipende dalla proposta del motore, non dal valore attuale', () => {
    expect(hasEngineProposal(fields[0]!)).toBe(true)
    expect(hasEngineProposal(fields[3]!)).toBe(false)
    expect(isFieldEmpty(fields[3]!)).toBe(false)
    // Una riga aggiunta a mano non è una proposta.
    expect(
      hasEngineProposal(listField([item({ origin: 'MANUAL', value: '', correctedValue: 'x' })]))
    ).toBe(false)
  })

  it('in cima gli obbligatori, col contatore di quelli ancora vuoti; nessun campo sparisce', () => {
    const groups = groupFieldsForReview(fields)
    expect(groups.toFill.map((field) => field.id)).toEqual(['total', 'tax', 'lines', 'iban'])
    expect(groups.proposed.map((field) => field.id)).toEqual(['number', 'lines-proposed'])
    expect(groups.stillEmpty).toBe(3)
    expect(groups.toFill.length + groups.proposed.length).toBe(fields.length)
  })

  it('un campo v1 senza ruolo usa il flag obbligatorio', () => {
    const groups = groupFieldsForReview([
      scalarField({ id: 'a', value: '', role: null, required: false }),
      scalarField({ id: 'b', value: '', role: null, required: true })
    ])
    expect(groups.toFill.map((field) => field.id)).toEqual(['b', 'a'])
  })
})

describe('quando proporre i candidati di tipo', () => {
  const classification = (overrides: Partial<TypeClassification> = {}): TypeClassification => ({
    engine: 'v2',
    version: '2.0.0-draft.1',
    decision: 'ASSIGN',
    reason: 'OK',
    proposedType: 'accounting.fattura',
    confidence: 0.83,
    margin: 0.3,
    threshold: 0.74,
    minimumMargin: 0.08,
    candidates: [
      { documentType: 'accounting.fattura', label: 'fattura', score: 0.83, signals: [] }
    ],
    ...overrides
  })

  it('tipo da assegnare: sì', () => {
    const document = reviewDocument({
      documentType: null,
      typeConfidence: null,
      classification: classification({ decision: 'UNKNOWN', reason: 'LOW_MARGIN' })
    })
    expect(shouldSuggestCandidates(document)).toBe(true)
  })

  it('assegnato dal motore: solo se il margine è basso', () => {
    expect(shouldSuggestCandidates(reviewDocument({ classification: classification() }))).toBe(
      false
    )
    expect(
      shouldSuggestCandidates(reviewDocument({ classification: classification({ margin: 0.12 }) }))
    ).toBe(true)
  })

  it('scelto dal revisore, o senza candidati: no', () => {
    expect(
      shouldSuggestCandidates(
        reviewDocument({ typeConfidence: null, classification: classification({ margin: 0.01 }) })
      )
    ).toBe(false)
    expect(
      shouldSuggestCandidates(
        reviewDocument({
          documentType: null,
          classification: classification({ candidates: [], reason: 'NO_SIGNAL' })
        })
      )
    ).toBe(false)
    expect(shouldSuggestCandidates(reviewDocument({ documentType: null }))).toBe(false)
  })
})
