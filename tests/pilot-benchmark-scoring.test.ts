import type { ExtractedFactV2, ExtractionResultV2 } from '@shared/extraction-v2'
import { buildLearningBundle } from '@shared/learning-workspace'
import { DEFAULT_LEARNING_POLICY, type LearningRule } from '@shared/local-learning'
import { describe, expect, it } from 'vitest'
import { learnedLabelsFor } from '../src/main/learning-anchors'
import {
  addClassification,
  emptyClassificationTally,
  fieldOutcomes,
  filledDespiteAbsent,
  learnedRulesFromBundle,
  normalizeValue,
  outsideProfile,
  parseManifest,
  reviewCounts,
  sameValue,
  summarizeClassification,
  summarizeScore,
  tally,
  type ValueSpec,
  valuesOf
} from './helpers/pilot-benchmark'

/**
 * Il conto del benchmark su corpus reale, su dati scritti a mano. L'harness
 * (`pilot-corpus-benchmark.test.ts`) gira solo con un corpus vero; quello che decide se un
 * valore è giusto, sbagliato o mancante si prova qui, a ogni `pnpm test`.
 */

const SHA = 'a'.repeat(64)
const TYPE = 'accounting.fattura'

const specs: Record<string, ValueSpec> = {
  'document.issue_date': { type: 'date' },
  'money.total': { type: 'money' },
  'issuer.iban': { type: 'identifier', format: 'iban' },
  'issuer.name': { type: 'string' },
  'line.description': { type: 'string' },
  'flag.paid': { type: 'boolean' }
}
const specOf = (fieldId: string) => specs[fieldId]

function fact(fieldId: string, value: unknown, status: ExtractedFactV2['reviewStatus']) {
  return {
    fieldId,
    role: 'core',
    cardinality: Array.isArray(value) ? 'many' : 'one',
    value,
    confidence: 0.85,
    evidence: [],
    reviewStatus: status,
    validationErrors: []
  } satisfies ExtractedFactV2
}

function result(facts: ExtractedFactV2[]): ExtractionResultV2 {
  return {
    documentType: TYPE,
    schemaState: 'draft',
    facts,
    missingRequired: [],
    conflicts: [],
    coverage: 0,
    confidence: 0
  }
}

interface RawManifest {
  version: string
  documents: Array<{
    file: string
    sha256: string
    documentType: string | null
    fields: Record<string, unknown>
    expectedAbsent?: string[]
  }>
}

describe('manifest del benchmark', () => {
  const valid: RawManifest = {
    version: '1',
    documents: [
      {
        file: 'fattura.pdf',
        sha256: SHA,
        documentType: TYPE,
        fields: { 'money.total': '1234.56', 'line.description': ['Viti', 'Bulloni'] },
        expectedAbsent: ['issuer.iban']
      },
      { file: 'domanda.pdf', sha256: SHA.toUpperCase(), documentType: null, fields: {} }
    ]
  }

  it('legge un manifest scritto bene', () => {
    const manifest = parseManifest(valid)
    expect(manifest.documents).toHaveLength(2)
    expect(manifest.documents[1]?.documentType).toBeNull()
  })

  it('dice dove sta l’errore di forma', () => {
    const badSha = structuredClone(valid)
    badSha.documents[0]!.sha256 = 'abc'
    expect(() => parseManifest(badSha)).toThrow(/documents\.0\.sha256/)
  })

  it('rifiuta una chiave che non conosce, invece di perderla', () => {
    const typo = structuredClone(valid)
    Object.assign(typo.documents[0]!, { expectedAbsents: ['issuer.name'] })
    expect(() => parseManifest(typo)).toThrow(/documents\.0/)
  })

  it('rifiuta un valore atteso vuoto: l’assenza si dichiara in expectedAbsent', () => {
    const empty = structuredClone(valid)
    empty.documents[0]!.fields['money.total'] = '  '
    expect(() => parseManifest(empty)).toThrow(/money\.total/)
  })

  it('rifiuta lo stesso file due volte', () => {
    const twice = structuredClone(valid)
    twice.documents[1]!.file = 'fattura.pdf'
    expect(() => parseManifest(twice)).toThrow(/due volte/)
  })

  it('rifiuta campi su un documento atteso senza tipo', () => {
    const unknown = structuredClone(valid)
    unknown.documents[1]!.fields = { 'money.total': '10' }
    expect(() => parseManifest(unknown)).toThrow(/senza tipo/)
  })

  it('rifiuta un campo atteso e insieme atteso assente', () => {
    const both = structuredClone(valid)
    both.documents[0]!.expectedAbsent = ['money.total']
    expect(() => parseManifest(both)).toThrow(/atteso assente/)
  })
})

describe('confronto dei valori', () => {
  it('una data scritta come sul documento è la data del motore', () => {
    expect(normalizeValue('16/12/2025', specs['document.issue_date'])).toBe('2025-12-16')
    expect(sameValue('2025-12-16', '16/12/2025', specs['document.issue_date'])).toBe(true)
    // Non tutta una data: resta com'è, e allora non coincide.
    expect(sameValue('2025-12-16', 'del 16/12/2025', specs['document.issue_date'])).toBe(false)
  })

  it('un importo si confronta come numero, all’italiana', () => {
    const money = specs['money.total']
    expect(sameValue('1234.56', '1.234,56', money)).toBe(true)
    expect(sameValue('1234.56', '€ 1.234,56', money)).toBe(true)
    expect(sameValue('1250', '1.250', money)).toBe(true)
    expect(sameValue('1250.00', 1250, money)).toBe(true)
    expect(sameValue('-100', '-100,00', money)).toBe(true)
    // Il segno conta: una nota di credito letta positiva è sbagliata.
    expect(sameValue('100', '-100,00', money)).toBe(false)
    // Un numero del JSON non si rilegge all'italiana.
    expect(normalizeValue(1.125, money)).toBe('1.125')
  })

  it('un identificativo senza spazi e in maiuscolo', () => {
    expect(
      sameValue('IT60X0542811101000000123456', 'it60 x054 2811 1010 0000 0123 456', {
        type: 'identifier',
        format: 'iban'
      })
    ).toBe(true)
  })

  it('il testo libero comprime gli spazi ma tiene le maiuscole', () => {
    const name = specs['issuer.name']
    expect(sameValue('Alfa  Srl ', 'Alfa Srl', name)).toBe(true)
    expect(sameValue('ALFA SRL', 'Alfa Srl', name)).toBe(false)
  })

  it('un campo many è giusto solo con le stesse righe, in qualunque ordine', () => {
    const line = specs['line.description']
    expect(sameValue(['Viti', 'Bulloni'], ['Bulloni', 'Viti'], line)).toBe(true)
    expect(sameValue(['Viti', 'Bulloni', 'Dadi'], ['Bulloni', 'Viti'], line)).toBe(false)
    expect(sameValue(['Viti'], ['Bulloni', 'Viti'], line)).toBe(false)
    // Le righe ripetute contano: due viti non sono una.
    expect(sameValue(['Viti', 'Viti'], ['Viti'], line)).toBe(false)
    // Una riga sola contro un valore singolo è la stessa lettura.
    expect(sameValue(['Viti'], 'Viti', line)).toBe(true)
  })

  it('niente contro niente non è una lettura giusta', () => {
    expect(sameValue(null, null)).toBe(false)
    expect(sameValue([], [])).toBe(false)
  })
})

describe('punteggio dei campi', () => {
  const expected = {
    'document.issue_date': '16/12/2025',
    'money.total': '1.234,56',
    'issuer.name': 'Alfa Srl',
    'line.description': ['Viti', 'Bulloni']
  }

  it('giusto, sbagliato, mancante', () => {
    const outcomes = fieldOutcomes(
      expected,
      {
        'document.issue_date': '2025-12-16',
        'money.total': '1234.65',
        'line.description': ['Bulloni', 'Viti'],
        'issuer.iban': 'IT60X0542811101000000123456'
      },
      specOf
    )
    expect(outcomes).toEqual({
      'document.issue_date': 'CORRECT',
      'money.total': 'WRONG',
      'issuer.name': 'MISSING',
      'line.description': 'CORRECT'
    })
    expect(summarizeScore(tally(outcomes))).toEqual({
      correct: 2,
      wrong: 1,
      missing: 1,
      total: 4,
      accuracy: 0.5,
      errorRate: 0.25,
      missingRate: 0.25
    })
  })

  it('un valore vuoto del motore è mancante, non sbagliato', () => {
    expect(fieldOutcomes({ 'issuer.name': 'Alfa' }, { 'issuer.name': '' }, specOf)).toEqual({
      'issuer.name': 'MISSING'
    })
    expect(
      fieldOutcomes({ 'line.description': ['Viti'] }, { 'line.description': [] }, specOf)
    ).toEqual({ 'line.description': 'MISSING' })
  })

  it('nessun campo atteso, nessuna divisione per zero', () => {
    expect(summarizeScore(tally({}))).toMatchObject({ total: 0, accuracy: 0, errorRate: 0 })
  })

  it('i valori, gli stati di revisione e gli attesi assenti compilati lo stesso', () => {
    const run = result([
      fact('money.total', '10.00', 'AUTO_ACCEPTED'),
      fact('issuer.name', 'Alfa Srl', 'NEEDS_REVIEW'),
      fact('issuer.iban', 'IT60X0542811101000000123456', 'CONFLICT'),
      fact('line.description', [], 'MISSING'),
      fact('document.issue_date', null, 'MISSING')
    ])
    const values = valuesOf(run)
    expect(Object.keys(values).sort()).toEqual(['issuer.iban', 'issuer.name', 'money.total'])
    expect(reviewCounts(run)).toEqual({ autoAccepted: 1, needsReview: 1, conflicts: 1 })
    expect(filledDespiteAbsent(['issuer.iban', 'document.issue_date'], values)).toEqual([
      'issuer.iban'
    ])
    expect(reviewCounts(null)).toEqual({ autoAccepted: 0, needsReview: 0, conflicts: 0 })
    expect(valuesOf(null)).toEqual({})
  })

  it('un campo atteso che il profilo non chiede: mai cercato', () => {
    const run = result([fact('money.total', '10.00', 'AUTO_ACCEPTED')])
    expect(outsideProfile({ 'money.total': '10', 'flag.paid': true }, run)).toEqual(['flag.paid'])
    expect(outsideProfile({ 'money.total': '10' }, null)).toEqual([])
  })
})

describe('punteggio dei tipi', () => {
  it('giusto, astensione, tipo sbagliato, top-1 e UNKNOWN atteso', () => {
    const total = emptyClassificationTally()
    // Assegnato giusto.
    addClassification(total, { expected: 'a', assigned: 'a', top: 'a' })
    // Astenuto, ma il primo candidato era giusto: una soglia, non un segnale mancante.
    addClassification(total, { expected: 'a', assigned: null, top: 'a' })
    // Il tipo plausibile e sbagliato.
    addClassification(total, { expected: 'a', assigned: 'b', top: 'b' })
    // Atteso UNKNOWN, e si astiene: giusto.
    addClassification(total, { expected: null, assigned: null, top: 'c' })
    // Atteso UNKNOWN, e assegna: sbagliato.
    addClassification(total, { expected: null, assigned: 'c', top: 'c' })

    expect(summarizeClassification(total)).toEqual({
      total: 5,
      correct: 2,
      incorrect: 3,
      abstained: 2,
      wrongType: 2,
      expectedUnknown: 2,
      expectedKnown: 3,
      top1Correct: 2,
      accuracy: 0.4,
      // Il top-1 si conta solo dove c'è un tipo da trovare.
      top1Accuracy: 0.6667
    })
  })
})

describe('regole apprese per la misura FROZEN', () => {
  const AT = '2026-09-17T10:00:00.000Z'
  const rule = (id: string, status: LearningRule['status']): LearningRule => ({
    id,
    kind: 'EXTRACTION_ANCHOR',
    scope: 'CLASS',
    status,
    documentType: TYPE,
    fieldId: 'document.issue_date',
    templateFingerprint: null,
    pattern: { label: 'data doc', relation: 'same-line' },
    ruleKey: `k-${id}`,
    positiveCount: 3,
    negativeCount: 0,
    lastPositiveAt: AT,
    lastNegativeAt: null,
    createdAt: AT,
    updatedAt: AT,
    learnerVersion: 'v'
  })

  function exported(rules: LearningRule[]): unknown {
    // Lo stesso file che scrive «Esporta le regole», passato da JSON come su disco.
    const bundle = buildLearningBundle({
      manifest: {
        exportedAt: AT,
        app: { name: 'praticaai-reviewer', version: '1' },
        learnerVersion: 'v',
        mode: 'FROZEN',
        policy: DEFAULT_LEARNING_POLICY,
        counts: { events: 0, rules: { ACTIVE: 1, SUSPENDED: 1, CANDIDATE: 0, REJECTED: 0 } },
        templateFingerprintAlgorithm: 'x'
      },
      rules,
      events: [],
      actions: [],
      registryFieldOf: () => null
    })
    return JSON.parse(JSON.stringify(bundle))
  }

  it('dal file esportato restano le regole attive, e il motore le legge', () => {
    const learned = learnedRulesFromBundle(
      exported([rule('attiva', 'ACTIVE'), rule('sospesa', 'SUSPENDED')])
    )
    expect(learned.rules.map((r) => r.id)).toEqual(['attiva'])
    expect(learned.manifest).toMatchObject({ exportedAt: AT, templateFingerprintAlgorithm: 'x' })
    expect(learnedLabelsFor(learned.rules, TYPE, null, null)).toEqual([
      {
        ruleId: 'attiva',
        fieldId: 'document.issue_date',
        label: 'data doc',
        relation: 'same-line',
        scope: 'CLASS'
      }
    ])
  })

  it('un file che non è un export delle regole si ferma', () => {
    expect(() => learnedRulesFromBundle({ manifest: { format: 'altro' }, rules: [] })).toThrow(
      /manifest\.format/
    )
    expect(() => learnedRulesFromBundle([])).toThrow(/Regole apprese/)
  })
})
