import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { templateTypeRuleInput } from '../src/main/learning-templates'
import {
  exportLearnedRules,
  learningOverview,
  learningSnapshot,
  registryFieldResolver,
  setRuleStatusByHand
} from '../src/main/learning-workspace'
import {
  buildLearningBundle,
  manualTransitions,
  ruleTitle,
  sortRuleViews,
  toRuleView
} from '../src/shared/learning-workspace'
import type { LearningEventInput, LearningRuleInput } from '../src/shared/local-learning'
import { createTestRepository, seedDocument } from './helpers/db'

let repo: ReturnType<typeof createTestRepository> | null = null
afterEach(() => {
  repo?.close()
  repo = null
})
const workdir = mkdtempSync(join(tmpdir(), 'reviewer-learning-'))
afterAll(() => rmSync(workdir, { recursive: true, force: true }))

const AT = '2026-09-17T10:00:00.000Z'
const TYPE = 'payments_treasury.richiesta_pagamento'
const names = {
  typeLabel: (type: string) => (type === TYPE ? 'Richiesta di pagamento' : null),
  fieldLabel: (field: string) => (field === 'document.issue_date' ? 'Data emissione' : null)
}

const anchor = (scope: 'TEMPLATE' | 'CLASS'): LearningRuleInput => ({
  kind: 'EXTRACTION_ANCHOR',
  scope,
  documentType: TYPE,
  fieldId: 'document.issue_date',
  templateFingerprint: scope === 'TEMPLATE' ? 'f1' : null,
  pattern: { label: 'data', relation: 'same-line' },
  ruleKey: `anchor-${scope}`
})

const event = (documentId: string, sha: string): LearningEventInput => ({
  at: AT,
  actor: 'revisore@example.com',
  documentId,
  contentSha256: sha.repeat(64),
  templateFingerprint: 'f1',
  textSource: 'NATIVE_TEXT',
  kind: 'FIELD_VALUE',
  outcome: 'FILLED',
  documentType: TYPE,
  predictedType: null,
  predictedConfidence: null,
  fieldId: 'document.issue_date',
  itemIndex: null,
  engineConfidence: null,
  engineRuleId: null,
  pick: null
})

/** Una regola di template attiva con due conferme, una di tipo candidata, una memoria sospesa. */
function setup() {
  const r = createTestRepository()
  repo = r
  const documentId = seedDocument(r)
  const ids = r.learning.acquire((writer) => {
    const template = writer.createRule(anchor('TEMPLATE'), AT)
    const klass = writer.createRule(anchor('CLASS'), AT)
    const memory = writer.createRule(templateTypeRuleInput(TYPE, 'f1'), AT)
    for (const sha of ['a', 'b']) {
      const recorded = writer.addEvent(event(documentId, sha))
      writer.recordEvidence(template.id, recorded.id, 'POSITIVE', AT)
      writer.recordEvidence(klass.id, recorded.id, 'POSITIVE', AT)
    }
    writer.changeRuleStatus(template.id, 'ACTIVE', { at: AT, detail: 'attivata' })
    writer.changeRuleStatus(memory.id, 'ACTIVE', { at: AT, detail: 'attivata' })
    writer.changeRuleStatus(memory.id, 'SUSPENDED', { at: AT, detail: 'sospesa' })
    return { template: template.id, klass: klass.id, memory: memory.id }
  })!
  return { r, documentId, ids, deps: { repo: r, names } }
}

describe('la scheda «Apprendimento»', () => {
  it('modalità, contatori, regole in ordine e cronologia', () => {
    const { deps, ids } = setup()
    const overview = learningOverview(deps)
    expect(overview.mode).toBe('LEARNING')
    expect(overview.counts).toEqual({
      events: 2,
      rules: { CANDIDATE: 1, ACTIVE: 1, SUSPENDED: 1, REJECTED: 0 }
    })
    expect(overview.rules.map((rule) => [rule.id, rule.status, rule.manual])).toEqual([
      [ids.template, 'ACTIVE', ['SUSPENDED', 'REJECTED']],
      [ids.memory, 'SUSPENDED', ['ACTIVE', 'REJECTED']],
      [ids.klass, 'CANDIDATE', ['REJECTED']]
    ])
    expect(overview.rules[0]).toMatchObject({
      title: '«Data emissione» sta dopo «data» sul modulo f1',
      documentTypeLabel: 'Richiesta di pagamento',
      fieldLabel: 'Data emissione',
      label: 'data',
      support: 2,
      precision: 1
    })
    expect(overview.actions.map((action) => action.kind)).toEqual([
      'RULE_SUSPENDED',
      'RULE_PROMOTED',
      'RULE_PROMOTED'
    ])
  })

  it('sospendere e riattivare a mano: in cronologia, e dice cosa rielaborare', () => {
    const { deps, ids, r } = setup()
    const suspended = setRuleStatusByHand(deps, ids.template, 'SUSPENDED', AT)
    expect(suspended.action).toMatchObject({
      kind: 'RULE_SUSPENDED',
      detail: 'Etichetta «data» per document.issue_date sospesa a mano: 2 conferme, 0 smentite.'
    })
    expect(suspended.change).toEqual({ documentTypes: [TYPE], templateFingerprints: [] })
    expect(r.learning.activeRules()).toEqual([])

    const memory = setRuleStatusByHand(deps, ids.memory, 'ACTIVE', AT)
    expect(memory.action.kind).toBe('RULE_REACTIVATED')
    expect(memory.change).toEqual({ documentTypes: [], templateFingerprints: ['f1'] })

    // Scartare una candidata non cambia quello che vale: niente da rielaborare.
    expect(setRuleStatusByHand(deps, ids.klass, 'REJECTED', AT).change).toEqual({
      documentTypes: [],
      templateFingerprints: []
    })
  })

  it('vale anche in FROZEN e BASELINE: la modalità ferma il learner, non chi lo governa', () => {
    const { deps, ids, r } = setup()
    r.learning.setMode('BASELINE')
    expect(setRuleStatusByHand(deps, ids.template, 'SUSPENDED', AT).action.after).toBe('SUSPENDED')
  })

  it('i passaggi che la scheda non offre sono rifiutati', () => {
    const { deps, ids } = setup()
    expect(() => setRuleStatusByHand(deps, ids.klass, 'ACTIVE', AT)).toThrow(
      'Una regola candidata non può diventare attiva.'
    )
    setRuleStatusByHand(deps, ids.klass, 'REJECTED', AT)
    expect(() => setRuleStatusByHand(deps, ids.klass, 'SUSPENDED', AT)).toThrow(
      'Una regola scartata non può diventare sospesa.'
    )
    expect(() => setRuleStatusByHand(deps, 'nessuna', 'SUSPENDED', AT)).toThrow(
      'Regola non trovata'
    )
  })
})

describe('l’impronta dell’apprendimento', () => {
  it('cambia con le regole attive, non con le candidate', () => {
    const { r, deps, ids } = setup()
    const before = learningSnapshot(r)
    expect(before).toMatchObject({ mode: 'LEARNING', activeRules: 1 })
    expect(before.rulesFingerprint).toMatch(/^[0-9a-f]{16}$/)

    setRuleStatusByHand(deps, ids.klass, 'REJECTED', AT)
    expect(learningSnapshot(r)).toEqual(before)

    setRuleStatusByHand(deps, ids.memory, 'ACTIVE', AT)
    const after = learningSnapshot(r)
    expect(after.activeRules).toBe(2)
    expect(after.rulesFingerprint).not.toBe(before.rulesFingerprint)

    setRuleStatusByHand(deps, ids.template, 'SUSPENDED', AT)
    setRuleStatusByHand(deps, ids.memory, 'SUSPENDED', AT)
    expect(learningSnapshot(r)).toMatchObject({ activeRules: 0, rulesFingerprint: null })
  })
})

describe('l’export delle regole', () => {
  it('regole, eventi e cronologia, coi nomi V5.1, senza valori dei documenti', async () => {
    const { r, documentId, deps } = setup()
    r.fields.replaceForDocument(documentId, [
      {
        name: 'document.issue_date',
        label: 'Data emissione',
        value: 'VALORE-RISERVATO',
        confidence: 0.85
      }
    ])
    const path = join(workdir, 'regole.json')
    const result = await exportLearnedRules(
      {
        ...deps,
        legacyFieldMap: { issue_date: 'document.issue_date' },
        app: { name: 'praticaai-reviewer', version: '1.5.0' }
      },
      path,
      new Date(AT)
    )
    expect(result).toEqual({ saved: true, path, rules: 3, events: 2 })

    const written = readFileSync(path, 'utf8')
    expect(written).not.toContain('VALORE-RISERVATO')
    const bundle = JSON.parse(written)
    expect(bundle.manifest).toMatchObject({
      format: 'praticaai-reviewer/learned-rules',
      formatVersion: '1.1.0',
      exportedAt: AT,
      app: { name: 'praticaai-reviewer', version: '1.5.0' },
      learnerVersion: 'local-learner/0.1.0',
      mode: 'LEARNING',
      counts: { events: 2 },
      templateFingerprintAlgorithm: 'reviewer/pdfjs-first-page-labels/sha256-16'
    })
    expect(bundle.manifest.policy.minTemplateSupport).toBe(2)
    expect(bundle.rules.map((rule: { ruleKey: string }) => rule.ruleKey)).toEqual([
      'anchor-CLASS',
      'anchor-TEMPLATE',
      `TEMPLATE_TYPE|TEMPLATE|${TYPE}|f1`
    ])
    expect(bundle.rules[1]).toMatchObject({
      registryField: 'issue_date',
      registryDocumentType: TYPE,
      support: 2,
      precision: 1
    })
    expect(bundle.rules[2].registryField).toBeNull()
    expect(bundle.events[0]).toMatchObject({
      registryField: 'issue_date',
      actor: 'revisore@example.com'
    })
    expect(bundle.actions).toHaveLength(3)
  })

  it('i nomi V5.1: il primo in ordine alfabetico quando due puntano allo stesso campo', () => {
    const resolve = registryFieldResolver({ customs_value: 'money.amount', amount: 'money.amount' })
    expect(resolve('money.amount')).toBe('amount')
    expect(resolve('bank.iban')).toBeNull()
  })
})

describe('il modulo condiviso della scheda', () => {
  it('le transizioni a mano per stato', () => {
    expect(manualTransitions('CANDIDATE')).toEqual(['REJECTED'])
    expect(manualTransitions('REJECTED')).toEqual([])
  })

  it('la frase di ogni regola', () => {
    const base = {
      documentType: TYPE,
      fieldId: 'document.issue_date',
      templateFingerprint: 'f1',
      pattern: { label: 'data', relation: 'next-line' }
    }
    expect(ruleTitle({ ...base, kind: 'EXTRACTION_ANCHOR', scope: 'CLASS' }, names)).toBe(
      '«Data emissione» sta sotto «data» su ogni «Richiesta di pagamento»'
    )
    expect(
      ruleTitle({ ...base, kind: 'TEMPLATE_TYPE', scope: 'TEMPLATE', fieldId: null }, names)
    ).toBe('Il modulo f1 è «Richiesta di pagamento»')
    const unnamed = { typeLabel: () => null, fieldLabel: () => null }
    expect(ruleTitle({ ...base, kind: 'EXTRACTION_ANCHOR', scope: 'TEMPLATE' }, unnamed)).toBe(
      '«document.issue_date» sta sotto «data» sul modulo f1'
    )
  })

  it('le regole in ordine: attive, sospese, candidate, scartate; poi supporto', () => {
    const { r } = setup()
    const views = r.learning.listRules().map((rule) => toRuleView(rule, names))
    expect(sortRuleViews([...views].reverse()).map((view) => view.status)).toEqual([
      'ACTIVE',
      'SUSPENDED',
      'CANDIDATE'
    ])
  })

  it('il bundle è stabile: stesso database, stessi byte salvo la data', () => {
    const { r } = setup()
    const input = {
      manifest: {
        exportedAt: AT,
        app: { name: 'a', version: '1' },
        learnerVersion: 'v',
        mode: 'LEARNING' as const,
        policy: {} as never,
        counts: r.learning.counts(),
        templateFingerprintAlgorithm: 'x'
      },
      rules: r.learning.listRules(),
      events: r.learning.listEvents(),
      actions: r.learning.listActions(),
      registryFieldOf: () => null
    }
    const shuffled = {
      ...input,
      rules: [...input.rules].reverse(),
      events: [...input.events].reverse(),
      actions: [...input.actions].reverse()
    }
    expect(JSON.stringify(buildLearningBundle(shuffled))).toBe(
      JSON.stringify(buildLearningBundle(input))
    )
  })
})
