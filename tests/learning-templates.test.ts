import { describe, expect, it } from 'vitest'
import { templateMemoryFor, templateTypeRuleInput } from '../src/main/learning-templates'
import { type LearningRule, nextRuleStatus } from '../src/shared/local-learning'
import { normalizedTemplateSignature } from '../src/shared/template-fingerprint'

/** Due esemplari dello stesso stampato: una riga in più sul secondo, testata uguale. */
const TESTATA = [
  'FATTURA IMMEDIATA',
  'Cliente: Alfa S.r.l.',
  'Indirizzo Sede legale   ROVIGO (RO)',
  'Partita IVA: 01234567890',
  'Data documento: 08/09/2026'
]
const firma = normalizedTemplateSignature(TESTATA)!
const firmaSimile = normalizedTemplateSignature([...TESTATA, 'Copia per archivio'])!
const firmaAltroModulo = normalizedTemplateSignature([
  'VISURA CAMERALE',
  'Numero REA: RO-123456',
  'Forma giuridica: societa a responsabilita limitata',
  'Data iscrizione: 01/02/2020'
])!

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
      {
        ruleId: 'attiva',
        documentType: 'accounting.fattura',
        templateFingerprint: 'f1',
        similarity: 1
      }
    ])
    expect(templateMemoryFor(rules, null)).toEqual([])
  })

  it('vale su un esemplare che l’impronta esatta separava, e pesa meno di uno identico', () => {
    const rules = [
      memoryRule({ id: 'attiva', ...templateTypeRuleInput('accounting.fattura', 'f1', firma) })
    ]

    // È il caso per cui la firma esiste: stesso stampato, impronta diversa. Prima di qui
    // questa memoria non valeva, e con supporto 1 per impronta non si attivava mai.
    const [simile] = templateMemoryFor(rules, 'f-diversa', firmaSimile)
    expect(simile?.ruleId).toBe('attiva')
    expect(simile?.similarity).toBeGreaterThanOrEqual(0.68)
    expect(simile?.similarity).toBeLessThan(1)

    // Lo stesso esemplare da cui la regola viene resta esatto, e vale pieno.
    expect(templateMemoryFor(rules, 'f1', firma)[0]?.similarity).toBe(1)

    // Un altro stampato non è lo stesso modulo, per quanto la soglia sia permissiva.
    expect(templateMemoryFor(rules, 'f-diversa', firmaAltroModulo)).toEqual([])
  })

  it('una regola senza firma vale ancora, ma solo per impronta identica', () => {
    const rules = [memoryRule({ id: 'vecchia' })]
    expect(templateMemoryFor(rules, 'f1', firma)).toHaveLength(1)
    expect(templateMemoryFor(rules, 'f-diversa', firmaSimile)).toEqual([])
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
