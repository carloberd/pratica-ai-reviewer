import { describe, expect, it } from 'vitest'
import {
  anchorRuleInputs,
  candidateLabels,
  deriveAnchor,
  learnedLabelsFor
} from '../src/main/learning-anchors'
import {
  anchorRuleKey,
  DEFAULT_LEARNING_POLICY,
  documentKey,
  type LearningRule,
  nextRuleStatus
} from '../src/shared/local-learning'
import { type PageLine, pageText } from '../src/shared/pick-locate'
import type { PickLocation } from '../src/shared/types'
import { testRegistryV2 } from './helpers/registry'

const registry = testRegistryV2()
const spec = (fieldId: string) => registry.field(fieldId)!

/** La posizione di `value` sulla riga `line`, come la salverebbe una selezione. */
function locate(lines: PageLine[], line: number, value: string): PickLocation {
  const offset = lines.slice(0, line).reduce((sum, previous) => sum + previous.text.length + 1, 0)
  const charStart = offset + lines[line]!.text.indexOf(value)
  return { lineStart: line, lineEnd: line, charStart, charEnd: charStart + value.length }
}

const MEMO: PageLine[] = [
  { text: 'Promemoria interno' },
  { text: 'Riepilogo delle spese sostenute nel mese' },
  { text: 'Importo complessivo EUR 1.250,00' },
  { text: 'Data: 12/09/2026' },
  { text: 'Da archiviare a cura della segreteria.' }
]

describe('etichette candidate', () => {
  it('le ultime parole prima del valore, senza cifre, dalla più corta', () => {
    expect(candidateLabels('Importo complessivo EUR ')).toEqual([
      'eur',
      'complessivo eur',
      'importo complessivo eur'
    ])
    expect(candidateLabels('Data: ')).toEqual(['data'])
  })

  it('si fermano alle cifre, a un’altra etichetta e a tre parole', () => {
    expect(candidateLabels('FATTURA n. 27/2026 del ')).toEqual(['del'])
    expect(candidateLabels('Emittente: Beta Costruzioni S.p.A. P.IVA ')).toEqual([
      'p iva',
      's p a p iva',
      'costruzioni s p a p iva'
    ])
    expect(candidateLabels('Rif. mario.rossi@example.com codice ')).toEqual(['codice'])
    expect(candidateLabels('Totale: ')).toEqual(['totale'])
  })

  it('niente etichette troppo corte', () => {
    expect(candidateLabels('n. ')).toEqual([])
    expect(candidateLabels('12 ')).toEqual([])
  })
})

describe('etichetta di una selezione', () => {
  it('sulla stessa riga: «Data: 12/09/2026» insegna «data»', () => {
    expect(
      deriveAnchor({
        lines: MEMO,
        location: locate(MEMO, 3, '12/09/2026'),
        fieldId: 'document.issue_date',
        spec: spec('document.issue_date')
      })
    ).toEqual({ label: 'data', relation: 'same-line' })
  })

  it('vince la più corta che legge solo il valore selezionato', () => {
    const lines: PageLine[] = [
      { text: 'Totale imponibile EUR 5.500,00' },
      { text: 'Totale documento EUR 6.710,00' }
    ]
    // «eur» legge due importi, «documento eur» uno solo: il suo.
    expect(
      deriveAnchor({
        lines,
        location: locate(lines, 1, '6.710,00'),
        fieldId: 'money.total',
        spec: spec('money.total')
      })
    ).toEqual({ label: 'documento eur', relation: 'same-line' })
  })

  it('in testa alla riga: l’etichetta è la fine della riga sopra', () => {
    const lines: PageLine[] = [{ text: 'Scadenza pagamento' }, { text: '30/10/2026' }]
    expect(
      deriveAnchor({
        lines,
        location: locate(lines, 1, '30/10/2026'),
        fieldId: 'payment.due_date',
        spec: spec('payment.due_date')
      })
    ).toEqual({ label: 'pagamento', relation: 'next-line' })
  })

  it('nessuna etichetta sicura: meglio niente che una indovinata', () => {
    const repeated: PageLine[] = [{ text: 'EUR 10,00' }, { text: 'EUR 20,00' }]
    const input = (lines: PageLine[], location: PickLocation) => ({
      lines,
      location,
      fieldId: 'money.total',
      spec: spec('money.total')
    })
    // «eur» legge due valori, e non c'è altro prima.
    expect(deriveAnchor(input(repeated, locate(repeated, 1, '20,00')))).toBeNull()
    // La selezione senza offset, o su più righe.
    expect(
      deriveAnchor(input(MEMO, { ...locate(MEMO, 2, '1.250,00'), charStart: null, charEnd: null }))
    ).toBeNull()
    expect(deriveAnchor(input(MEMO, { ...locate(MEMO, 2, '1.250,00'), lineEnd: 3 }))).toBeNull()
    // Il valore in testa alla prima riga non ha una riga sopra.
    const first: PageLine[] = [{ text: '10,00' }]
    expect(deriveAnchor(input(first, locate(first, 0, '10,00')))).toBeNull()
    // Il lettore del campo non legge quello che il revisore ha selezionato.
    expect(
      deriveAnchor({
        lines: MEMO,
        location: locate(MEMO, 1, 'spese'),
        fieldId: 'money.total',
        spec: spec('money.total')
      })
    ).toBeNull()
  })

  it('l’etichetta deve precedere il valore selezionato, non un altro sulla stessa riga', () => {
    const lines: PageLine[] = [{ text: 'Data 01/09/2026 Data 12/09/2026' }]
    expect(
      deriveAnchor({
        lines,
        location: { lineStart: 0, lineEnd: 0, charStart: 21, charEnd: 31 },
        fieldId: 'document.issue_date',
        spec: spec('document.issue_date')
      })
    ).toBeNull()
    expect(pageText(lines).slice(21, 31)).toBe('12/09/2026')
  })
})

describe('regole da un’etichetta', () => {
  const pattern = { label: 'data', relation: 'same-line' as const }

  it('una per il template e una per il tipo, con chiavi stabili', () => {
    const rules = anchorRuleInputs({
      pattern,
      documentType: 'payments_treasury.richiesta_pagamento',
      fieldId: 'document.issue_date',
      templateFingerprint: 'f1'
    })
    expect(rules.map((rule) => [rule.scope, rule.templateFingerprint, rule.ruleKey])).toEqual([
      [
        'TEMPLATE',
        'f1',
        'EXTRACTION_ANCHOR|TEMPLATE|payments_treasury.richiesta_pagamento|f1|document.issue_date|same-line|data'
      ],
      [
        'CLASS',
        null,
        'EXTRACTION_ANCHOR|CLASS|payments_treasury.richiesta_pagamento|*|document.issue_date|same-line|data'
      ]
    ])
  })

  it('senza impronta solo la regola di tipo', () => {
    expect(
      anchorRuleInputs({
        pattern,
        documentType: 't',
        fieldId: 'f',
        templateFingerprint: null
      }).map((rule) => rule.scope)
    ).toEqual(['CLASS'])
    expect(
      anchorRuleKey({
        scope: 'CLASS',
        documentType: 't',
        fieldId: 'f',
        templateFingerprint: 'x',
        pattern
      })
    ).toBe('EXTRACTION_ANCHOR|CLASS|t|*|f|same-line|data')
  })

  it('valgono per un documento le attive del suo tipo, di tipo o del suo template', () => {
    const rule = (overrides: Partial<LearningRule>): LearningRule => ({
      id: 'r',
      kind: 'EXTRACTION_ANCHOR',
      scope: 'TEMPLATE',
      documentType: 't',
      fieldId: 'f',
      templateFingerprint: 'f1',
      pattern: { label: 'data', relation: 'same-line' },
      ruleKey: 'k',
      status: 'ACTIVE',
      positiveCount: 2,
      negativeCount: 0,
      lastPositiveAt: null,
      lastNegativeAt: null,
      createdAt: '',
      updatedAt: '',
      learnerVersion: '',
      ...overrides
    })
    const rules = [
      rule({ id: 'template' }),
      rule({ id: 'class', scope: 'CLASS', templateFingerprint: null }),
      rule({ id: 'other-template', templateFingerprint: 'f2' }),
      rule({ id: 'other-type', documentType: 'u' }),
      rule({ id: 'candidate', status: 'CANDIDATE' }),
      rule({ id: 'suspended', status: 'SUSPENDED' }),
      rule({ id: 'broken', pattern: { label: 3 } })
    ]
    expect(learnedLabelsFor(rules, 't', 'f1').map((label) => label.ruleId)).toEqual([
      'template',
      'class'
    ])
    expect(learnedLabelsFor(rules, 't', null).map((label) => label.ruleId)).toEqual(['class'])
  })
})

describe('quando una regola vale', () => {
  const rule = (
    status: LearningRule['status'],
    scope: LearningRule['scope'],
    positiveCount: number,
    negativeCount = 0
  ) => ({ status, scope, positiveCount, negativeCount })

  it('una regola di template vale dopo due conferme senza smentite', () => {
    expect(nextRuleStatus(rule('CANDIDATE', 'TEMPLATE', 1), [])).toBe('CANDIDATE')
    expect(nextRuleStatus(rule('CANDIDATE', 'TEMPLATE', 2), [])).toBe('ACTIVE')
    expect(nextRuleStatus(rule('CANDIDATE', 'TEMPLATE', 5, 1), [])).toBe('CANDIDATE')
  })

  it('una regola di tipo chiede tre conferme e il 90%', () => {
    expect(nextRuleStatus(rule('CANDIDATE', 'CLASS', 2), [])).toBe('CANDIDATE')
    expect(nextRuleStatus(rule('CANDIDATE', 'CLASS', 3), [])).toBe('ACTIVE')
    expect(nextRuleStatus(rule('CANDIDATE', 'CLASS', 9, 1), [])).toBe('ACTIVE')
    expect(nextRuleStatus(rule('CANDIDATE', 'CLASS', 8, 1), [])).toBe('CANDIDATE')
  })

  it('una regola attiva si sospende dopo due smentite di fila, o sotto il 70% dall’attivazione', () => {
    const active = rule('ACTIVE', 'TEMPLATE', 10, 2)
    expect(nextRuleStatus(active, ['NEGATIVE', 'POSITIVE'])).toBe('ACTIVE')
    expect(nextRuleStatus(active, ['NEGATIVE', 'NEGATIVE'])).toBe('SUSPENDED')
    const window = ['POSITIVE', 'NEGATIVE', 'POSITIVE', 'NEGATIVE', 'NEGATIVE'] as const
    expect(nextRuleStatus(rule('ACTIVE', 'CLASS', 30, 0), [...window])).toBe('SUSPENDED')
    expect(
      nextRuleStatus(rule('ACTIVE', 'CLASS', 30, 0), [
        'POSITIVE',
        'POSITIVE',
        'NEGATIVE',
        'POSITIVE',
        'POSITIVE'
      ])
    ).toBe('ACTIVE')
  })

  it('le smentite di prima dell’attivazione non contano: una regola riattivata riparte', () => {
    // Storia pessima, ma dall'ultima attivazione solo conferme.
    expect(nextRuleStatus(rule('ACTIVE', 'TEMPLATE', 2, 8), ['POSITIVE'])).toBe('ACTIVE')
  })

  it('con poche prove la precisione non basta a sospendere: decidono le smentite di fila', () => {
    // Due conferme e una smentita fanno il 67%, ma sono tre prove.
    expect(nextRuleStatus(rule('ACTIVE', 'TEMPLATE', 2, 1), ['NEGATIVE', 'POSITIVE'])).toBe(
      'ACTIVE'
    )
  })

  it('il learner non riattiva e non scarta: lo decide una persona', () => {
    expect(nextRuleStatus(rule('SUSPENDED', 'TEMPLATE', 20), ['POSITIVE'])).toBe('SUSPENDED')
    expect(nextRuleStatus(rule('REJECTED', 'TEMPLATE', 20), ['POSITIVE'])).toBe('REJECTED')
  })

  it('le soglie sono configurabili', () => {
    expect(
      nextRuleStatus(rule('CANDIDATE', 'TEMPLATE', 1), [], {
        ...DEFAULT_LEARNING_POLICY,
        minTemplateSupport: 1
      })
    ).toBe('ACTIVE')
  })

  it('una prova si lega ai byte del documento, o al documento senza hash', () => {
    expect(documentKey({ contentSha256: 'abc', documentId: 'd' })).toBe('abc')
    expect(documentKey({ contentSha256: null, documentId: 'd' })).toBe('document:d')
  })
})
