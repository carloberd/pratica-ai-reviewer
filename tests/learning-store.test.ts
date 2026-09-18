import { afterEach, describe, expect, it } from 'vitest'
import { type Db, openDatabase } from '../src/main/db'
import { createLearningDao, type LearningWriter } from '../src/main/db/dao/learning'
import {
  type LearningEventInput,
  type LearningMode,
  type LearningRuleInput,
  rulePrecision,
  ruleSupport
} from '../src/shared/local-learning'
import { createTestRepository, seedDocument } from './helpers/db'

let repo: ReturnType<typeof createTestRepository> | null = null
let raw: Db | null = null

afterEach(() => {
  repo?.close()
  repo = null
  raw?.close()
  raw = null
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
    replayedAt: null,
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

  it('gli effetti dall’ultima attivazione vanno dal più nuovo, senza quelli che l’hanno attivata', () => {
    const { learning, documentId } = setup()
    const at = (hour: number) => `2026-09-17T${String(hour).padStart(2, '0')}:00:00.000Z`
    const effects = learning.acquire((writer) => {
      const rule = writer.createRule(ANCHOR, AT)
      const prove = (hour: number, sha: string, effect: 'POSITIVE' | 'NEGATIVE') => {
        const recorded = writer.addEvent(
          event(documentId, { at: at(hour), contentSha256: sha.repeat(64) })
        )
        writer.recordEvidence(rule.id, recorded.id, effect, at(hour))
      }
      prove(9, 'a', 'POSITIVE')
      prove(10, 'b', 'NEGATIVE')
      const before = writer.effectsSinceActive(rule.id)
      writer.changeRuleStatus(rule.id, 'ACTIVE', { at: at(10), detail: '' })
      prove(11, 'c', 'NEGATIVE')
      prove(12, 'd', 'POSITIVE')
      return { before, after: writer.effectsSinceActive(rule.id) }
    })
    expect(effects).toEqual({ before: ['NEGATIVE', 'POSITIVE'], after: ['POSITIVE', 'NEGATIVE'] })
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

/**
 * Il deposito con la porta di servizio aperta sulle colonne: serve a metterci dentro un
 * JSON che il learner non scriverebbe mai, e che solo un file danneggiato o una versione
 * che non c'è ancora possono lasciare lì.
 */
function store() {
  const db = openDatabase({ file: ':memory:' })
  raw = db
  return { db, learning: createLearningDao(db) }
}

describe('righe che il learner non sa più leggere', () => {
  it('una regola col pattern illeggibile si legge senza pattern, e lʼelenco regge', () => {
    const { db, learning } = store()
    const rule = learning.acquire((writer) => writer.createRule(ANCHOR, AT))!
    const other = learning.acquire((writer) =>
      writer.createRule({ ...ANCHOR, scope: 'CLASS', ruleKey: 'class-key' }, AT)
    )!
    db.prepare('UPDATE learning_rules SET pattern_json = ? WHERE id = ?').run(
      '{"label": "dat',
      rule.id
    )

    // Il punto è questo: una riga rotta non si porta dietro le altre. L'elenco va dalla
    // più recente, quindi la regola corrotta è la seconda.
    expect(learning.listRules().map((entry) => entry.pattern)).toEqual([
      { label: 'data', relation: 'same-line', reader: 'date' },
      {}
    ])
    expect(learning.getRule(other.id)?.pattern).toMatchObject({ label: 'data' })
  })

  it('un pattern che non è un oggetto vale quanto uno illeggibile', () => {
    const { db, learning } = store()
    const rule = learning.acquire((writer) => writer.createRule(ANCHOR, AT))!
    db.prepare('UPDATE learning_rules SET pattern_json = ? WHERE id = ?').run(
      '["data", "same-line"]',
      rule.id
    )
    expect(learning.getRule(rule.id)?.pattern).toEqual({})
  })

  it('unʼazione coi numeri malformati resta in cronologia, senza numeri', () => {
    const { db, learning } = store()
    const promoted = learning.acquire((writer) => {
      const rule = writer.createRule(ANCHOR, AT)
      return writer.changeRuleStatus(rule.id, 'ACTIVE', { at: AT, detail: 'promossa' })
    })!
    db.prepare('UPDATE learning_actions SET numbers_json = ? WHERE id = ?').run(
      '{"support": 2,',
      promoted.id
    )

    expect(learning.listActions().find((action) => action.id === promoted.id)).toMatchObject({
      kind: 'RULE_PROMOTED',
      detail: 'promossa',
      numbers: null
    })
  })

  it('i numeri della forma sbagliata non arrivano alla frase che li racconta', () => {
    const { db, learning } = store()
    const promoted = learning.acquire((writer) => {
      const rule = writer.createRule(ANCHOR, AT)
      return writer.changeRuleStatus(rule.id, 'ACTIVE', { at: AT, detail: 'promossa' })
    })!
    const numbers = (json: string) => {
      db.prepare('UPDATE learning_actions SET numbers_json = ? WHERE id = ?').run(json, promoted.id)
      return learning.listActions().find((action) => action.id === promoted.id)?.numbers
    }

    expect(numbers('{"precision": 1}')).toBeNull()
    expect(numbers('{"support": "due", "precision": null}')).toBeNull()
    expect(numbers('3')).toBeNull()
    // La forma giusta passa, precisione ancora ignota compresa.
    expect(numbers('{"support": 2, "precision": null}')).toEqual({ support: 2, precision: null })
  })
})

/**
 * L'annullamento di un cambio di stato. Le regole nascono qui con `acquire`, perché al
 * deposito non importa chi ha premuto: quello che cambia fra il learner e una persona è
 * il *tipo* dell'azione, ed è su quello che si decide cosa si annulla.
 */
describe('annullare l’ultimo cambio di stato di una regola', () => {
  /** Una regola attiva, promossa dal learner: il punto di partenza di quasi tutti i casi. */
  function attiva() {
    const { db, learning } = store()
    const rule = learning.acquire((writer) => {
      const created = writer.createRule(ANCHOR, AT)
      writer.changeRuleStatus(created.id, 'ACTIVE', { at: AT, detail: 'attivata: 2 conferme' })
      return created
    })!
    return { db, learning, ruleId: rule.id }
  }

  const DOPO = '2026-09-18T09:00:00.000Z'
  const ANCORA_DOPO = '2026-09-18T10:00:00.000Z'

  it('rimette lo stato di prima e aggiunge una riga, senza toglierne nessuna', () => {
    const { learning, ruleId } = attiva()
    const scarto = learning.setRuleStatus(ruleId, 'REJECTED', {
      at: DOPO,
      detail: 'Etichetta «data» scartata a mano: 2 conferme, 0 smentite.'
    })
    expect(learning.getRule(ruleId)?.status).toBe('REJECTED')

    const revert = learning.rollbackRule(ruleId, ANCORA_DOPO)

    // Lo stato torna quello di prima dello scarto, anche se nessun passaggio permesso
    // riaprirebbe una regola scartata.
    expect(learning.getRule(ruleId)).toMatchObject({ status: 'ACTIVE', updatedAt: ANCORA_DOPO })
    expect(revert).toMatchObject({
      kind: 'REVERT',
      ruleId,
      before: 'REJECTED',
      after: 'ACTIVE',
      detail: 'Annullata: Etichetta «data» scartata a mano: 2 conferme, 0 smentite.',
      revertsId: scarto.id,
      revertedAt: null
    })

    // La cronologia cresce: l'azione annullata resta dov'è, marcata.
    const actions = learning.listActions()
    expect(actions.map((action) => action.kind)).toEqual([
      'REVERT',
      'RULE_REJECTED',
      'RULE_PROMOTED'
    ])
    expect(actions.find((action) => action.id === scarto.id)?.revertedAt).toBe(ANCORA_DOPO)
  })

  it('la regola torna a valere: la cache delle regole attive non se la perde', () => {
    const { learning, ruleId } = attiva()
    expect(learning.activeRules().map((rule) => rule.id)).toEqual([ruleId])
    learning.setRuleStatus(ruleId, 'REJECTED', { at: DOPO, detail: 'scartata' })
    expect(learning.activeRules()).toEqual([])

    learning.rollbackRule(ruleId, ANCORA_DOPO)
    expect(learning.activeRules().map((rule) => rule.id)).toEqual([ruleId])
  })

  it('senza un cambio da annullare non succede niente, e lo dice', () => {
    const { learning, ruleId } = attiva()
    // La sola azione della regola è la promozione del learner: fuori da quello che si annulla.
    expect(learning.revertableRuleAction(ruleId)).toBeUndefined()
    expect(() => learning.rollbackRule(ruleId, DOPO)).toThrow(/Nessun cambio di stato annullabile/)
    expect(learning.getRule(ruleId)?.status).toBe('ACTIVE')
    expect(learning.listActions()).toHaveLength(1)
  })

  it('una promozione del learner non si annulla: i contatori la rifarebbero subito', () => {
    const { learning, ruleId } = attiva()
    expect(learning.listActions()[0]?.kind).toBe('RULE_PROMOTED')
    expect(learning.revertableRuleAction(ruleId)).toBeUndefined()
  })

  it('un annullamento non si annulla a sua volta', () => {
    const { learning, ruleId } = attiva()
    learning.setRuleStatus(ruleId, 'SUSPENDED', { at: DOPO, detail: 'sospesa a mano' })
    learning.rollbackRule(ruleId, ANCORA_DOPO)

    // Sotto il REVERT c'è solo la promozione, che non si annulla: la catena si ferma qui.
    expect(learning.revertableRuleAction(ruleId)).toBeUndefined()
    expect(() => learning.rollbackRule(ruleId, '2026-09-18T11:00:00.000Z')).toThrow(
      /Nessun cambio di stato annullabile/
    )
    expect(learning.listActions().filter((action) => action.kind === 'REVERT')).toHaveLength(1)
  })

  it('un cambio di stato arrivato dopo toglie di mezzo quello di prima', () => {
    const { learning, ruleId } = attiva()
    learning.setRuleStatus(ruleId, 'SUSPENDED', { at: DOPO, detail: 'sospesa a mano' })
    // Qualcuno ci ripensa e la scarta: la sospensione non è più quella in vigore.
    learning.setRuleStatus(ruleId, 'REJECTED', { at: ANCORA_DOPO, detail: 'scartata a mano' })

    // Si annulla lo scarto, non la sospensione: si torna a SUSPENDED, non ad ACTIVE.
    expect(learning.revertableRuleAction(ruleId)).toMatchObject({ after: 'REJECTED' })
    expect(learning.rollbackRule(ruleId, '2026-09-18T11:00:00.000Z')).toMatchObject({
      before: 'REJECTED',
      after: 'SUSPENDED'
    })
    expect(learning.getRule(ruleId)?.status).toBe('SUSPENDED')
  })

  it('se il learner ha cambiato stato dopo, non c’è più niente da annullare', () => {
    const { db, learning, ruleId } = attiva()
    const sospensione = learning.setRuleStatus(ruleId, 'SUSPENDED', {
      at: DOPO,
      detail: 'sospesa a mano'
    })
    // Lo stato cambia sotto l'azione senza lasciare cronologia: non è una strada che il
    // learner prende, ma è esattamente la situazione da cui il controllo deve difendere.
    db.prepare('UPDATE learning_rules SET status = ? WHERE id = ?').run('REJECTED', ruleId)

    expect(learning.revertableRuleAction(ruleId)).toBeUndefined()
    expect(sospensione.after).toBe('SUSPENDED')
    expect(() => learning.rollbackRule(ruleId, ANCORA_DOPO)).toThrow(
      /Nessun cambio di stato annullabile/
    )
  })

  it('un’azione con lo stato di partenza illeggibile non si annulla', () => {
    const { db, learning, ruleId } = attiva()
    const scarto = learning.setRuleStatus(ruleId, 'REJECTED', { at: DOPO, detail: 'scartata' })
    db.prepare('UPDATE learning_actions SET before_state = ? WHERE id = ?').run('BOH', scarto.id)

    // Il `before_state` finisce dritto nello stato della regola: se non è uno stato, non si
    // scrive niente, invece di rimettere in piedi una regola con uno stato inventato.
    expect(learning.revertableRuleAction(ruleId)).toBeUndefined()
  })

  it('se la riga nuova non entra, il database resta com’era', () => {
    const { db, learning, ruleId } = attiva()
    const scarto = learning.setRuleStatus(ruleId, 'REJECTED', { at: DOPO, detail: 'scartata' })
    // Fa fallire l'ultimo dei tre passi, quando ripristino e marcatura sono già scritti.
    db.exec(`
      CREATE TRIGGER niente_revert BEFORE INSERT ON learning_actions
      WHEN NEW.kind = 'REVERT'
      BEGIN SELECT RAISE(ABORT, 'niente REVERT'); END
    `)

    expect(() => learning.rollbackRule(ruleId, ANCORA_DOPO)).toThrow(/niente REVERT/)
    expect(learning.getRule(ruleId)?.status).toBe('REJECTED')
    expect(learning.listActions().find((action) => action.id === scarto.id)?.revertedAt).toBeNull()
    expect(learning.listActions()).toHaveLength(2)

    // Tolto l'ostacolo l'annullamento riesce, sullo stato che non si era mosso.
    db.exec('DROP TRIGGER niente_revert')
    expect(learning.rollbackRule(ruleId, ANCORA_DOPO)).toMatchObject({ after: 'ACTIVE' })
    expect(learning.getRule(ruleId)?.status).toBe('ACTIVE')
  })
})
