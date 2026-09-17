import { afterEach, describe, expect, it } from 'vitest'
import type { LearningWriter } from '../src/main/db/dao/learning'
import {
  type LearningEventInput,
  type LearningMode,
  type LearningRuleInput,
  rulePrecision,
  ruleSupport
} from '../src/shared/local-learning'
import { createTestRepository, seedDocument } from './helpers/db'

let repo: ReturnType<typeof createTestRepository> | null = null

afterEach(() => {
  repo?.close()
  repo = null
})

function setup() {
  const r = createTestRepository()
  repo = r
  return { r, learning: r.learning, documentId: seedDocument(r) }
}

const AT = '2026-09-17T10:00:00.000Z'

function event(
  documentId: string,
  overrides: Partial<LearningEventInput> = {}
): LearningEventInput {
  return {
    at: AT,
    actor: 'revisore@example.com',
    documentId,
    contentSha256: 'a'.repeat(64),
    templateFingerprint: '4f0e2912bff50e67',
    textSource: 'NATIVE_TEXT',
    kind: 'FIELD_VALUE',
    outcome: 'FILLED',
    documentType: 'payments_treasury.richiesta_pagamento',
    predictedType: null,
    predictedConfidence: null,
    fieldId: 'document.issue_date',
    itemIndex: null,
    engineConfidence: null,
    engineRuleId: null,
    pick: {
      method: 'TEXT_SELECTION',
      page: 1,
      bbox: { x: 87.6, y: 131, w: 52.7, h: 11 },
      location: { lineStart: 3, lineEnd: 3, charStart: 99, charEnd: 109 }
    },
    ...overrides
  }
}

const ANCHOR: LearningRuleInput = {
  kind: 'EXTRACTION_ANCHOR',
  scope: 'TEMPLATE',
  documentType: 'payments_treasury.richiesta_pagamento',
  fieldId: 'document.issue_date',
  templateFingerprint: '4f0e2912bff50e67',
  pattern: { label: 'data', relation: 'same-line', reader: 'date' },
  ruleKey: 'EXTRACTION_ANCHOR|TEMPLATE|4f0e2912bff50e67|document.issue_date|data|same-line'
}

/** Tutto quello che il learner può scrivere, in una volta sola. */
function learnEverything(writer: LearningWriter, documentId: string) {
  const recorded = writer.addEvent(event(documentId))
  const rule = writer.createRule(ANCHOR, AT)
  writer.recordEvidence(rule.id, recorded.id, 'POSITIVE', AT)
  return writer.changeRuleStatus(rule.id, 'ACTIVE', { at: AT, detail: 'promossa' })
}

function snapshot(r: NonNullable<typeof repo>) {
  return {
    counts: r.learning.counts(),
    events: r.learning.listEvents(),
    rules: r.learning.listRules(),
    actions: r.learning.listActions().filter((action) => action.kind !== 'MODE_CHANGED')
  }
}

describe('modalità del learner', () => {
  it('parte in LEARNING, e ogni cambio finisce in cronologia', () => {
    const { learning } = setup()
    expect(learning.mode()).toBe('LEARNING')

    const frozen = learning.setMode('FROZEN', AT)
    expect(frozen).toMatchObject({
      kind: 'MODE_CHANGED',
      before: 'LEARNING',
      after: 'FROZEN',
      detail: 'Apprendimento attivo → Apprendimento congelato.',
      ruleId: null
    })
    expect(learning.mode()).toBe('FROZEN')

    // Chiedere la modalità in cui si è già non è un cambio.
    expect(learning.setMode('FROZEN', AT)).toBeNull()
    learning.setMode('BASELINE', '2026-09-17T11:00:00.000Z')
    expect(learning.listActions().map((action) => [action.before, action.after])).toEqual([
      ['FROZEN', 'BASELINE'],
      ['LEARNING', 'FROZEN']
    ])
  })

  it('la modalità resta a database', () => {
    const { r, learning } = setup()
    learning.setMode('BASELINE', AT)
    expect(r.learning.mode()).toBe('BASELINE')
  })

  it.each<LearningMode>(['FROZEN', 'BASELINE'])(
    'in %s il learner non scrive niente, e il lavoro non parte nemmeno',
    (mode) => {
      const { r, learning, documentId } = setup()
      const before = snapshot(r)
      learning.setMode(mode, AT)

      let called = false
      const result = learning.acquire((writer) => {
        called = true
        return learnEverything(writer, documentId)
      })

      expect(result).toBeNull()
      expect(called).toBe(false)
      expect(snapshot(r)).toEqual(before)
      expect(learning.counts()).toEqual({
        events: 0,
        rules: { CANDIDATE: 0, ACTIVE: 0, SUSPENDED: 0, REJECTED: 0 }
      })
    }
  )

  it('in LEARNING lo stesso lavoro scrive eventi, regole, prove e cronologia', () => {
    const { learning, documentId } = setup()
    const action = learning.acquire((writer) => learnEverything(writer, documentId))

    expect(action).toMatchObject({ kind: 'RULE_PROMOTED', before: 'CANDIDATE', after: 'ACTIVE' })
    expect(learning.counts()).toEqual({
      events: 1,
      rules: { CANDIDATE: 0, ACTIVE: 1, SUSPENDED: 0, REJECTED: 0 }
    })
  })

  it('un errore dentro il lavoro annulla tutto quello che aveva scritto', () => {
    const { r, learning, documentId } = setup()
    const before = snapshot(r)
    expect(() =>
      learning.acquire((writer) => {
        learnEverything(writer, documentId)
        throw new Error('interrotto')
      })
    ).toThrow('interrotto')
    expect(snapshot(r)).toEqual(before)
    expect(learning.activeRules()).toEqual([])
  })
})

describe('eventi', () => {
  it('conservano decisione e posizione della selezione, senza valori', () => {
    const { learning, documentId } = setup()
    const recorded = learning.acquire((writer) => writer.addEvent(event(documentId)))!

    expect(learning.listEvents({ documentId })).toEqual([recorded])
    expect(recorded).toMatchObject({
      learnerVersion: 'local-learner/0.1.0',
      outcome: 'FILLED',
      pick: { location: { lineStart: 3, charStart: 99, charEnd: 109 } }
    })
    expect(Object.keys(recorded)).not.toContain('value')
  })

  it('un evento del tipo non ha campo né selezione, e una selezione senza posizione resta', () => {
    const { learning, documentId } = setup()
    learning.acquire((writer) => {
      writer.addEvent(
        event(documentId, {
          kind: 'DOCUMENT_TYPE',
          outcome: 'CHANGED',
          predictedType: 'accounting.fattura',
          predictedConfidence: 0.62,
          fieldId: null,
          pick: null
        })
      )
      writer.addEvent(
        event(documentId, {
          pick: { method: 'AREA_OCR', page: 2, bbox: null, location: null }
        })
      )
    })
    const [type, area] = learning.listEvents({ documentId })
    expect(type).toMatchObject({
      kind: 'DOCUMENT_TYPE',
      predictedType: 'accounting.fattura',
      pick: null
    })
    expect(area?.pick).toEqual({ method: 'AREA_OCR', page: 2, bbox: null, location: null })
  })

  it('sopravvivono al documento: il registro non si cancella con l’archivio', () => {
    const { r, learning, documentId } = setup()
    learning.acquire((writer) => writer.addEvent(event(documentId)))
    r.documents.delete(documentId)
    expect(learning.listEvents()).toHaveLength(1)
    expect(learning.listEvents({ documentId })[0]?.contentSha256).toBe('a'.repeat(64))
  })
})

describe('regole', () => {
  it('nascono candidate e senza cronologia; la stessa chiave è una regola sola', () => {
    const { learning } = setup()
    const rule = learning.acquire((writer) => writer.createRule(ANCHOR, AT))!
    expect(rule).toMatchObject({
      status: 'CANDIDATE',
      positiveCount: 0,
      negativeCount: 0,
      pattern: { label: 'data', relation: 'same-line', reader: 'date' }
    })
    expect(learning.listActions()).toEqual([])
    expect(learning.acquire((writer) => writer.findRule(ANCHOR.ruleKey))?.id).toBe(rule.id)
    expect(() => learning.acquire((writer) => writer.createRule(ANCHOR, AT))).toThrow(/UNIQUE/)
  })

  it('una regola di tipo non tiene l’impronta del template', () => {
    const { learning } = setup()
    const rule = learning.acquire((writer) =>
      writer.createRule({ ...ANCHOR, scope: 'CLASS', ruleKey: 'class-key' }, AT)
    )!
    expect(rule.templateFingerprint).toBeNull()
  })

  it('le prove contano una volta per documento, e danno supporto e precisione', () => {
    const { learning, documentId } = setup()
    const rule = learning.acquire((writer) => {
      const created = writer.createRule(ANCHOR, AT)
      const first = writer.addEvent(event(documentId, { contentSha256: 'a'.repeat(64) }))
      const again = writer.addEvent(event(documentId, { contentSha256: 'a'.repeat(64) }))
      const second = writer.addEvent(event(documentId, { contentSha256: 'b'.repeat(64) }))
      const wrong = writer.addEvent(event(documentId, { contentSha256: 'c'.repeat(64) }))
      writer.recordEvidence(created.id, first.id, 'POSITIVE', AT)
      // Lo stesso documento non vale due volte.
      writer.recordEvidence(created.id, again.id, 'POSITIVE', AT)
      writer.recordEvidence(created.id, second.id, 'POSITIVE', AT)
      return writer.recordEvidence(created.id, wrong.id, 'NEGATIVE', '2026-09-17T12:00:00.000Z')
    })!

    expect(rule).toMatchObject({
      positiveCount: 2,
      negativeCount: 1,
      lastPositiveAt: AT,
      lastNegativeAt: '2026-09-17T12:00:00.000Z'
    })
    expect(ruleSupport(rule)).toBe(2)
    expect(rulePrecision(rule)).toBeCloseTo(2 / 3, 6)
    expect(rulePrecision({ positiveCount: 0, negativeCount: 0 })).toBeNull()
    expect(learning.ruleEvidence(rule.id).map((entry) => entry.effect)).toEqual([
      'POSITIVE',
      'POSITIVE',
      'NEGATIVE'
    ])
  })

  it('sullo stesso documento la smentita prevale sulla conferma, non il contrario', () => {
    const { learning, documentId } = setup()
    const rule = learning.acquire((writer) => {
      const created = writer.createRule(ANCHOR, AT)
      const row = () => writer.addEvent(event(documentId)).id
      writer.recordEvidence(created.id, row(), 'POSITIVE', AT)
      writer.recordEvidence(created.id, row(), 'NEGATIVE', AT)
      return writer.recordEvidence(created.id, row(), 'POSITIVE', AT)
    })!
    expect(rule).toMatchObject({ positiveCount: 0, negativeCount: 1 })
  })

  it('senza hash la prova si lega all’id del documento', () => {
    const { learning, documentId } = setup()
    const rule = learning.acquire((writer) => {
      const created = writer.createRule(ANCHOR, AT)
      writer.recordEvidence(
        created.id,
        writer.addEvent(event(documentId, { contentSha256: null })).id,
        'POSITIVE',
        AT
      )
      return writer.recordEvidence(
        created.id,
        writer.addEvent(event(documentId, { contentSha256: null })).id,
        'POSITIVE',
        AT
      )
    })!
    expect(rule.positiveCount).toBe(1)
  })

  it('ritirare un documento toglie le sue prove da tutte le regole', () => {
    const { learning, documentId } = setup()
    const [anchor, other] = learning.acquire((writer) => {
      const first = writer.createRule(ANCHOR, AT)
      const second = writer.createRule({ ...ANCHOR, scope: 'CLASS', ruleKey: 'class-key' }, AT)
      const kept = writer.addEvent(event(documentId, { contentSha256: 'b'.repeat(64) }))
      const retracted = writer.addEvent(event(documentId))
      writer.recordEvidence(first.id, kept.id, 'POSITIVE', AT)
      writer.recordEvidence(first.id, retracted.id, 'POSITIVE', AT)
      writer.recordEvidence(second.id, retracted.id, 'NEGATIVE', AT)
      const touched = writer.retractDocument('a'.repeat(64), AT)
      expect(touched.map((rule) => rule.id).sort()).toEqual([first.id, second.id].sort())
      expect(writer.retractDocument('nessuno', AT)).toEqual([])
      return [writer.findRule(first.ruleKey)!, writer.findRule(second.ruleKey)!]
    })!
    expect(anchor).toMatchObject({ positiveCount: 1, negativeCount: 0 })
    expect(other).toMatchObject({ positiveCount: 0, negativeCount: 0 })
    // Gli eventi restano: si ritira la prova, non la storia.
    expect(learning.listEvents()).toHaveLength(2)
  })

  it('gli effetti recenti vanno dal più nuovo', () => {
    const { learning, documentId } = setup()
    const effects = learning.acquire((writer) => {
      const rule = writer.createRule(ANCHOR, AT)
      const at = (hour: number) => `2026-09-17T${String(hour).padStart(2, '0')}:00:00.000Z`
      for (const [hour, sha, effect] of [
        [9, 'a', 'POSITIVE'],
        [10, 'b', 'NEGATIVE'],
        [11, 'c', 'NEGATIVE']
      ] as const) {
        const recorded = writer.addEvent(
          event(documentId, { at: at(hour), contentSha256: sha.repeat(64) })
        )
        writer.recordEvidence(rule.id, recorded.id, effect, at(hour))
      }
      return writer.recentEffects(rule.id, 2)
    })
    expect(effects).toEqual(['NEGATIVE', 'NEGATIVE'])
  })

  it('i cambi di stato hanno un nome, portano i numeri e aggiornano le regole attive', () => {
    const { learning, documentId } = setup()
    const rule = learning.acquire((writer) => {
      const created = writer.createRule(ANCHOR, AT)
      writer.recordEvidence(created.id, writer.addEvent(event(documentId)).id, 'POSITIVE', AT)
      return created
    })!
    expect(learning.activeRules()).toEqual([])

    const promoted = learning.acquire((writer) =>
      writer.changeRuleStatus(rule.id, 'ACTIVE', { at: AT, detail: 'supporto raggiunto' })
    )
    expect(promoted).toMatchObject({
      kind: 'RULE_PROMOTED',
      ruleId: rule.id,
      numbers: { support: 1, precision: 1 }
    })
    expect(learning.activeRules().map((active) => active.id)).toEqual([rule.id])

    learning.acquire((writer) => {
      writer.changeRuleStatus(rule.id, 'SUSPENDED', { at: AT, detail: 'smentita' })
      writer.changeRuleStatus(rule.id, 'ACTIVE', { at: AT, detail: 'di nuovo confermata' })
      writer.changeRuleStatus(rule.id, 'REJECTED', { at: AT, detail: 'scartata' })
    })
    expect(learning.activeRules()).toEqual([])
    expect(learning.listActions().map((action) => action.kind)).toEqual([
      'RULE_REJECTED',
      'RULE_REACTIVATED',
      'RULE_SUSPENDED',
      'RULE_PROMOTED'
    ])
  })

  it('i passaggi senza nome non sono permessi', () => {
    const { learning } = setup()
    const rule = learning.acquire((writer) => writer.createRule(ANCHOR, AT))!
    const change = (status: 'SUSPENDED' | 'CANDIDATE' | 'ACTIVE') => () =>
      learning.acquire((writer) => writer.changeRuleStatus(rule.id, status, { at: AT, detail: '' }))

    expect(change('SUSPENDED')).toThrow('Una regola CANDIDATE non può diventare SUSPENDED.')
    expect(change('CANDIDATE')).toThrow('non può diventare CANDIDATE')
    learning.acquire((writer) =>
      writer.changeRuleStatus(rule.id, 'REJECTED', { at: AT, detail: 'scartata' })
    )
    expect(change('ACTIVE')).toThrow('Una regola REJECTED non può diventare ACTIVE.')
  })

  it('filtra per stato, tipo di regola e tipo di documento', () => {
    const { learning } = setup()
    learning.acquire((writer) => {
      writer.createRule(ANCHOR, AT)
      writer.createRule(
        {
          kind: 'TEMPLATE_TYPE',
          scope: 'TEMPLATE',
          documentType: 'accounting.fattura',
          fieldId: null,
          templateFingerprint: 'b'.repeat(16),
          pattern: {},
          ruleKey: 'template-type'
        },
        AT
      )
    })
    expect(learning.listRules({ kind: 'TEMPLATE_TYPE' }).map((rule) => rule.ruleKey)).toEqual([
      'template-type'
    ])
    expect(learning.listRules({ documentType: 'accounting.fattura', status: 'ACTIVE' })).toEqual([])
    expect(learning.listRules({ status: 'CANDIDATE' })).toHaveLength(2)
    expect(learning.getRule('nessuna')).toBeUndefined()
  })
})
