import { describe, expect, it } from 'vitest'
import { describeLearnedReview, reviewLearningEvents } from '../src/shared/review-learning'
import type { EvidenceItem, TypeClassification } from '../src/shared/types'
import { item, listField, reviewDocument, scalarField } from './helpers/review-document'

const CONTEXT = {
  at: '2026-09-17T10:00:00.000Z',
  actor: 'revisore@example.com',
  templateFingerprint: '4f0e2912bff50e67'
}

function classification(proposedType: string | null, confidence = 0.83): TypeClassification {
  return {
    engine: 'v2',
    version: '2.0.0',
    decision: proposedType ? 'ASSIGN' : 'UNKNOWN',
    reason: proposedType ? 'OK' : 'BELOW_THRESHOLD',
    proposedType,
    confidence,
    margin: 0.2,
    threshold: 0.6,
    minimumMargin: 0.08,
    candidates: []
  }
}

const PICKED: EvidenceItem = {
  id: 'ev-picked',
  label: 'Numero documento · selezionato dal revisore',
  page: 1,
  text: '114/2026-bis',
  confidence: 1,
  bbox: { x: 56, y: 111, w: 60, h: 11 },
  origin: 'REVIEWER',
  method: 'TEXT_SELECTION',
  location: { lineStart: 2, lineEnd: 2, charStart: 51, charEnd: 63 }
}

/** Le sole decisioni sui campi: il tipo ha i suoi test poco sopra. */
function fieldDecisions(document: ReturnType<typeof reviewDocument>) {
  return decisions(document).filter((decision) => decision.kind === 'FIELD_VALUE')
}

/** Solo le decisioni, per leggere i test senza il contesto ripetuto. */
function decisions(document: ReturnType<typeof reviewDocument>) {
  return reviewLearningEvents(document, CONTEXT).map(
    ({ kind, outcome, fieldId, itemIndex, engineConfidence, predictedType, pick }) => ({
      kind,
      outcome,
      fieldId,
      itemIndex,
      engineConfidence,
      predictedType,
      picked: pick !== null
    })
  )
}

describe('il tipo del documento', () => {
  it.each([
    ['accounting.fattura', 'accounting.fattura', 'CONFIRMED'],
    ['accounting.nota_di_credito', 'accounting.fattura', 'CHANGED'],
    [null, 'accounting.fattura', 'FILLED'],
    ['accounting.fattura', null, 'CLEARED']
  ] as const)('proposto %s, scelto %s: %s', (proposed, chosen, outcome) => {
    const [type] = reviewLearningEvents(
      reviewDocument({ documentType: chosen, classification: classification(proposed) }),
      CONTEXT
    )
    expect(type).toMatchObject({
      kind: 'DOCUMENT_TYPE',
      outcome,
      documentType: chosen,
      predictedType: proposed,
      predictedConfidence: proposed ? 0.83 : null,
      fieldId: null,
      pick: null
    })
  })

  it('senza classificazione salvata la proposta si riconosce dalla confidenza', () => {
    // Col tipo proposto dalla memoria di un modulo: confermarlo è una conferma.
    expect(
      decisions(reviewDocument({ classification: null, typeConfidence: 0.9 }))[0]
    ).toMatchObject({
      kind: 'DOCUMENT_TYPE',
      outcome: 'CONFIRMED',
      predictedType: 'accounting.fattura'
    })
    // Scelto a mano: nessuno l'aveva proposto, ed è comunque la decisione che insegna
    // alla memoria del modulo qual è il tipo di questo stampato.
    expect(
      decisions(reviewDocument({ classification: null, typeConfidence: null }))[0]
    ).toMatchObject({
      kind: 'DOCUMENT_TYPE',
      outcome: 'FILLED',
      predictedType: null
    })
    expect(
      decisions(reviewDocument({ classification: null, typeConfidence: null, documentType: null }))
    ).toEqual([])
  })

  it('nessun tipo proposto e nessuno scelto non è una decisione', () => {
    expect(
      decisions(reviewDocument({ documentType: null, classification: classification(null) }))
    ).toEqual([])
  })
})

describe('i campi singoli', () => {
  const document = (fields: ReturnType<typeof scalarField>[], evidence: EvidenceItem[] = []) =>
    reviewDocument({ classification: null, typeConfidence: null, fields, evidence })

  it('una proposta tenuta è una conferma, con la confidence del motore', () => {
    expect(fieldDecisions(document([scalarField({ confidence: 0.85 })]))).toEqual([
      {
        kind: 'FIELD_VALUE',
        outcome: 'CONFIRMED',
        fieldId: 'document.number',
        itemIndex: null,
        engineConfidence: 0.85,
        predictedType: null,
        picked: false
      }
    ])
  })

  it('riscrivere la proposta non è una correzione: resta una conferma', () => {
    expect(
      fieldDecisions(document([scalarField({ correctedValue: '114/2026' })]))[0]?.outcome
    ).toBe('CONFIRMED')
  })

  it('corretto, compilato e svuotato; la selezione va con il valore del revisore', () => {
    const events = reviewLearningEvents(
      document(
        [
          scalarField({ correctedValue: '114/2026-bis', correctedEvidenceId: 'ev-picked' }),
          scalarField({ id: 'f-tax', name: 'issuer.tax_id', value: '', correctedValue: '0123' }),
          scalarField({ id: 'f-cur', name: 'money.currency', value: 'EUR', correctedValue: '' })
        ],
        [PICKED]
      ),
      CONTEXT
    ).filter((event) => event.kind === 'FIELD_VALUE')
    expect(
      events.map(({ fieldId, outcome, engineConfidence }) => [fieldId, outcome, engineConfidence])
    ).toEqual([
      ['document.number', 'CHANGED', 0.85],
      ['issuer.tax_id', 'FILLED', null],
      ['money.currency', 'CLEARED', 0.85]
    ])
    expect(events[0]?.pick).toEqual({
      method: 'TEXT_SELECTION',
      page: 1,
      bbox: { x: 56, y: 111, w: 60, h: 11 },
      location: { lineStart: 2, lineEnd: 2, charStart: 51, charEnd: 63 }
    })
    expect(events.slice(1).map((event) => event.pick)).toEqual([null, null])
  })

  it('un campo vuoto che nessuno ha toccato non dice niente', () => {
    expect(fieldDecisions(document([scalarField({ value: '' })]))).toEqual([])
  })

  it('un’evidenza del motore non è una selezione', () => {
    const engine: EvidenceItem = { ...PICKED, id: 'ev-engine', origin: 'ENGINE' }
    const [event] = reviewLearningEvents(
      document([scalarField({ correctedValue: 'x', correctedEvidenceId: 'ev-engine' })], [engine]),
      CONTEXT
    )
    expect(event?.pick).toBeNull()
  })
})

describe('i campi ripetuti', () => {
  it('una decisione per riga, in ordine: confermate, corrette, tolte e aggiunte', () => {
    const lines = listField([
      item({ id: 'i0', index: 0, value: 'Fornitura', confidence: 0.8 }),
      item({ id: 'i1', index: 1, value: 'Posa', correctedValue: 'Posa in opera' }),
      item({ id: 'i2', index: 2, value: 'Doppione', removed: true }),
      item({
        id: 'i3',
        index: 3,
        value: '',
        correctedValue: 'Trasporto',
        origin: 'MANUAL',
        correctedEvidenceId: 'ev-picked'
      })
    ])
    const document = reviewDocument({
      classification: null,
      typeConfidence: null,
      fields: [lines],
      evidence: [PICKED]
    })
    expect(
      fieldDecisions(document).map(({ outcome, itemIndex, engineConfidence, picked }) => [
        itemIndex,
        outcome,
        engineConfidence,
        picked
      ])
    ).toEqual([
      [0, 'CONFIRMED', 0.8, false],
      [1, 'CHANGED', 0.85, false],
      [2, 'REMOVED', 0.85, false],
      [3, 'ADDED', null, true]
    ])
  })
})

describe('il contesto', () => {
  it('ogni evento porta chi, quando, quale file e quale modulo, e nessun valore', () => {
    const events = reviewLearningEvents(
      reviewDocument({
        contentSha256: 'a'.repeat(64),
        classification: classification('accounting.fattura'),
        fields: [scalarField({ correctedValue: 'Beta S.p.A. segreta' })]
      }),
      CONTEXT
    )
    for (const event of events) {
      expect(event).toMatchObject({
        at: CONTEXT.at,
        actor: CONTEXT.actor,
        documentId: 'doc-1',
        contentSha256: 'a'.repeat(64),
        templateFingerprint: '4f0e2912bff50e67',
        textSource: 'NATIVE_TEXT',
        documentType: 'accounting.fattura'
      })
    }
    expect(JSON.stringify(events)).not.toContain('114/2026')
    expect(JSON.stringify(events)).not.toContain('segreta')
  })
})

describe('la frase per la timeline', () => {
  const events = (outcomes: Array<[string, boolean]>) =>
    outcomes.map(([outcome, picked]) => ({
      ...reviewLearningEvents(reviewDocument({ fields: [scalarField()] }), CONTEXT)[0]!,
      outcome: outcome as 'CONFIRMED',
      pick: picked
        ? { method: 'TEXT_SELECTION' as const, page: 1, bbox: null, location: null }
        : null
    }))

  it('conta conferme, correzioni e valori presi dal documento', () => {
    expect(describeLearnedReview(events([['CONFIRMED', false]]))).toBe(
      'Apprendimento: 1 decisione registrata (1 conferma, 0 correzioni).'
    )
    expect(
      describeLearnedReview(
        events([
          ['CONFIRMED', false],
          ['CHANGED', true],
          ['FILLED', true]
        ])
      )
    ).toBe(
      'Apprendimento: 3 decisioni registrate (1 conferma, 2 correzioni, 2 prese dal documento).'
    )
    expect(describeLearnedReview([])).toBe('Apprendimento: nessuna decisione da registrare.')
  })
})
