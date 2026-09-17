import { describe, expect, it } from 'vitest'
import { templateMemoryFor, templateTypeRuleInput } from '../src/main/learning-templates'
import { type LearningRule, nextRuleStatus } from '../src/shared/local-learning'

const memoryRule = (overrides: Partial<LearningRule>): LearningRule => ({
  ...templateTypeRuleInput('accounting.fattura', 'f1'),
  id: 'r',
  status: 'ACTIVE',
  positiveCount: 3,
  negativeCount: 0,
  lastPositiveAt: null,
  lastNegativeAt: null,
  createdAt: '',
  updatedAt: '',
  learnerVersion: '',
  ...overrides
})

describe('memoria dei moduli', () => {
  it('una regola per modulo e tipo, senza campo né forma', () => {
    expect(templateTypeRuleInput('accounting.fattura', 'f1')).toEqual({
      kind: 'TEMPLATE_TYPE',
      scope: 'TEMPLATE',
      documentType: 'accounting.fattura',
      fieldId: null,
      templateFingerprint: 'f1',
      pattern: {},
      ruleKey: 'TEMPLATE_TYPE|TEMPLATE|accounting.fattura|f1'
    })
  })

  it('valgono le memorie attive della sola impronta del documento', () => {
    const rules = [
      memoryRule({ id: 'attiva' }),
      memoryRule({ id: 'altro-modulo', templateFingerprint: 'f2' }),
      memoryRule({ id: 'candidata', status: 'CANDIDATE' }),
      memoryRule({ id: 'etichetta', kind: 'EXTRACTION_ANCHOR' })
    ]
    expect(templateMemoryFor(rules, 'f1')).toEqual([
      { ruleId: 'attiva', documentType: 'accounting.fattura', templateFingerprint: 'f1' }
    ])
    expect(templateMemoryFor(rules, null)).toEqual([])
  })

  it('si attiva con tre revisioni concordi e nessun conflitto, mai prima', () => {
    const rule = (positiveCount: number, negativeCount = 0) => ({
      kind: 'TEMPLATE_TYPE' as const,
      scope: 'TEMPLATE' as const,
      status: 'CANDIDATE' as const,
      positiveCount,
      negativeCount
    })
    expect(nextRuleStatus(rule(2), [])).toBe('CANDIDATE')
    expect(nextRuleStatus(rule(3), [])).toBe('ACTIVE')
    expect(nextRuleStatus(rule(30, 1), [])).toBe('CANDIDATE')
  })

  it('un conflitto dall’attivazione la sospende, e non torna da sola', () => {
    const active = { kind: 'TEMPLATE_TYPE' as const, scope: 'TEMPLATE' as const, positiveCount: 30 }
    expect(nextRuleStatus({ ...active, status: 'ACTIVE', negativeCount: 0 }, [])).toBe('ACTIVE')
    expect(
      nextRuleStatus({ ...active, status: 'ACTIVE', negativeCount: 1 }, ['POSITIVE', 'NEGATIVE'])
    ).toBe('SUSPENDED')
    // Riattivata a mano dopo un conflitto: il conflitto di prima non la risospende.
    expect(nextRuleStatus({ ...active, status: 'ACTIVE', negativeCount: 1 }, ['POSITIVE'])).toBe(
      'ACTIVE'
    )
    expect(nextRuleStatus({ ...active, status: 'SUSPENDED', negativeCount: 1 }, [])).toBe(
      'SUSPENDED'
    )
  })
})
