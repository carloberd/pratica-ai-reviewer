import { describe, expect, it } from 'vitest'
import { toDatasetDocument } from '../src/shared/dataset'
import type { TypeCandidate, TypeClassification } from '../src/shared/types'
import { reviewDocument } from './helpers/review-document'

/**
 * Quello che il classificatore ha deciso, nel dataset.
 *
 * Fino alla 1.3.0 un `UNKNOWN` usciva come `proposed: null` e basta: non si distingueva
 * «non ha trovato niente» da «aveva ragione ma sotto soglia», ed erano 27 documenti su 41
 * nell'export del 18/09/2026. Le soglie non si tarano su un export che non dice quale dei
 * due è successo.
 */

const candidate = (documentType: string, score: number): TypeCandidate => ({
  documentType,
  label: null,
  score,
  signals: []
})

function classification(overrides: Partial<TypeClassification> = {}): TypeClassification {
  return {
    engine: 'v2',
    version: '2.0.0-draft.1',
    decision: 'UNKNOWN',
    reason: 'BELOW_THRESHOLD',
    proposedType: null,
    confidence: 0.71,
    margin: 0.19,
    threshold: 0.74,
    minimumMargin: 0.08,
    candidates: [],
    ...overrides
  }
}

const documentTypeOf = (document: Parameters<typeof toDatasetDocument>[0]['document']) =>
  toDatasetDocument({ document, extraction: null })!.documentType

describe('la classificazione nel dataset', () => {
  it('sotto soglia col tipo giusto in testa: il classificatore ci aveva preso', () => {
    const exported = documentTypeOf(
      reviewDocument({
        status: 'REVIEWED',
        documentType: 'corporate_registry.visura_camerale',
        typeConfidence: null,
        classification: classification({
          candidates: [
            candidate('corporate_registry.visura_camerale', 0.71),
            candidate('corporate_registry.visura_storica', 0.52)
          ]
        })
      })
    )

    expect(exported.proposed).toBeNull()
    expect(exported.decision).toBe('UNKNOWN')
    expect(exported.reason).toBe('BELOW_THRESHOLD')
    expect(exported.threshold).toBe(0.74)
    expect(exported.minimumMargin).toBe(0.08)
    expect(exported.margin).toBe(0.19)
    // Il punto: era primo a 0,71, contro una soglia di 0,74.
    expect(exported.chosen).toEqual({ rank: 1, score: 0.71 })
    expect(exported.candidates).toEqual([
      {
        documentType: 'corporate_registry.visura_camerale',
        registryId: 'corporate_registry.visura_camerale',
        score: 0.71,
        rank: 1
      },
      {
        documentType: 'corporate_registry.visura_storica',
        registryId: 'corporate_registry.visura_storica',
        score: 0.52,
        rank: 2
      }
    ])
  })

  it('senza segnali non ci sono candidati: abbassare le soglie non servirebbe', () => {
    const exported = documentTypeOf(
      reviewDocument({
        status: 'REVIEWED',
        documentType: 'hse_risk.pos',
        typeConfidence: null,
        classification: classification({ reason: 'NO_SIGNAL', confidence: 0, margin: 0 })
      })
    )

    expect(exported.reason).toBe('NO_SIGNAL')
    expect(exported.candidates).toEqual([])
    expect(exported.chosen).toEqual({ rank: null, score: null })
  })

  it('il tipo scelto fuori dai candidati: `rank` nullo, e si vede', () => {
    const exported = documentTypeOf(
      reviewDocument({
        status: 'REVIEWED',
        documentType: 'procurement.ordine_acquisto',
        typeConfidence: null,
        classification: classification({
          decision: 'ASSIGN',
          reason: 'OK',
          proposedType: 'sales_customers.ordine_cliente',
          confidence: 0.7833,
          candidates: [candidate('sales_customers.ordine_cliente', 0.7833)]
        })
      })
    )

    expect(exported.corrected).toBe(true)
    expect(exported.chosen).toEqual({ rank: null, score: null })
  })

  it('un documento chiuso senza tipo non ha niente da cercare in lista', () => {
    const exported = documentTypeOf(
      reviewDocument({
        status: 'REVIEWED',
        documentType: null,
        documentTypeLabel: null,
        typeConfidence: null,
        classification: classification({ candidates: [candidate('accounting.fattura', 0.71)] })
      })
    )

    expect(exported.chosen).toBeNull()
    expect(exported.candidates).toHaveLength(1)
  })

  it('un documento che il classificatore non ha mai visto non dichiara niente', () => {
    const exported = documentTypeOf(
      reviewDocument({ status: 'REVIEWED', typeConfidence: null, classification: null })
    )

    expect(exported.decision).toBeNull()
    expect(exported.reason).toBeNull()
    expect(exported.threshold).toBeNull()
    expect(exported.candidates).toEqual([])
  })
})
