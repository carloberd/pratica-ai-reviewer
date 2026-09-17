import { afterAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/db'
import { createRepository } from '../src/main/db/repository'
import { createReloadableExtractionRegistryV2 } from '../src/main/extract/v2/profile-loader'
import { updateFieldValue } from '../src/main/field-edits'
import { createDocumentProcessor } from '../src/main/pipeline'
import {
  type RefinementDeps,
  reprocessQueueOfTemplate,
  reprocessQueueOfType
} from '../src/main/profile-refinement'
import { assignDocumentType } from '../src/main/reprocess'
import { submitReview } from '../src/main/review'
import type { LearningMode } from '../src/shared/local-learning'
import {
  fixture,
  REGISTRY_DIR,
  REGISTRY_V2_DIR,
  testClassifierConfigV2,
  testLegacyFieldMap,
  testRegistry
} from './helpers/registry'

/**
 * Il giro completo dell'apprendimento, sui documenti veri: la definizione di «fatto» della
 * PR 4. Una serie di promemoria dello stesso modulo, che il motore non sa leggere: la data
 * sta dopo «Data:», e nessun hint del registry la annuncia così.
 *
 * - due revisioni che selezionano la data insegnano l'etichetta, e la regola di template
 *   diventa attiva;
 * - il promemoria dopo arriva con la data già compilata, e la precompilazione dice quale
 *   regola l'ha trovata;
 * - la stessa sequenza in FROZEN non impara niente; in BASELINE le regole non valgono;
 * - due smentite di fila sospendono la regola, e il documento dopo torna come prima.
 */

const PDF = 'application/pdf'
const TYPE = 'payments_treasury.richiesta_pagamento'
const ACTOR = 'revisore@example.com'

/** I promemoria della serie, con la data che il revisore seleziona. */
const SERIES = {
  settembre: ['promemoria-ignoto.pdf', '12/09/2026'],
  ottobre: ['promemoria-ottobre.pdf', '10/10/2026'],
  novembre: ['promemoria-novembre.pdf', '07/11/2026'],
  dicembre: ['promemoria-dicembre.pdf', '05/12/2026'],
  gennaio: ['promemoria-gennaio.pdf', '09/01/2027']
} as const

type Month = keyof typeof SERIES

const closers: Array<() => void> = []
afterAll(() => {
  for (const close of closers) close()
})

function setup(mode: LearningMode = 'LEARNING') {
  const registry = testRegistry()
  const db = openDatabase({ file: ':memory:' })
  closers.push(() => db.close())
  const repo = createRepository(db, {
    requiredFields: (type) => registry.requiredFor(type),
    typeLabel: (type) => registry.label(type)
  })
  repo.learning.setMode(mode)
  const extractionRegistryV2 = createReloadableExtractionRegistryV2(
    REGISTRY_V2_DIR,
    REGISTRY_DIR,
    () => repo.profileMap.overlay()
  )
  const process = createDocumentProcessor({
    repo,
    registry,
    engines: { classifier: 'v2', extraction: 'v2' },
    classifierConfigV2: testClassifierConfigV2(),
    extractionRegistryV2,
    legacyFieldMap: testLegacyFieldMap()
  })
  const deps: RefinementDeps = {
    repo,
    registry: extractionRegistryV2,
    registryDirectory: REGISTRY_V2_DIR,
    typeLabel: (type) => registry.label(type),
    process
  }
  const ids = new Map<Month, string>()
  /** I tipi che l'ultimo salvataggio ha chiesto di rielaborare, come li riceve l'IPC. */
  let queued: Promise<unknown> = Promise.resolve()

  /**
   * Il promemoria scaricato ed elaborato, col tipo scelto a mano come farebbe il revisore;
   * `type: null` lo lascia a quello che decide il classificatore.
   */
  async function open(month: Month, options: { type: string | null } = { type: TYPE }) {
    const [filename] = SERIES[month]
    const { id } = repo.documents.upsertFromDrive({
      driveFileId: `drive-${month}`,
      filename,
      mime: PDF,
      receivedAt: '2026-09-10T08:00:00.000Z'
    })
    ids.set(month, id)
    repo.documents.setCachedPath(id, fixture(filename))
    await process({ documentId: id, cachedPath: fixture(filename), mime: PDF, filename })
    if (options.type) {
      await assignDocumentType({ repo, documentId: id, documentType: options.type, process })
    }
    return id
  }

  const idOf = (month: Month) => ids.get(month)!
  const date = (month: Month) =>
    repo.getReviewDocument(idOf(month))!.fields.find((f) => f.name === 'document.issue_date')!

  /** Il revisore mette il cursore nella data e la seleziona sul documento. */
  function pickDate(month: Month) {
    const id = idOf(month)
    const text = SERIES[month][1]
    const line = repo.pages.lines(id, 1).find((candidate) => candidate.text.includes(text))!
    updateFieldValue(repo, {
      documentId: id,
      fieldId: date(month).id,
      correctedValue: text,
      pick: { method: 'TEXT_SELECTION', page: 1, text, ...(line.bbox ? { bbox: line.bbox } : {}) }
    })
  }

  function save(month: Month, action: 'SAVE' | 'DISCARD' = 'SAVE') {
    submitReview(repo, {
      documentId: idOf(month),
      action,
      actor: ACTOR,
      registry: extractionRegistryV2,
      onRulesChanged: ({ documentTypes, templateFingerprints }) => {
        for (const type of documentTypes) queued = reprocessQueueOfType(deps, type, null).done
        for (const fingerprint of templateFingerprints) {
          queued = reprocessQueueOfTemplate(deps, fingerprint).done
        }
      }
    })
    return repo.getReviewDocument(idOf(month))!.timeline.at(-1)!.detail
  }

  const anchorRules = () => repo.learning.listRules({ kind: 'EXTRACTION_ANCHOR' })
  const memoryRules = () => repo.learning.listRules({ kind: 'TEMPLATE_TYPE' })
  const classification = (month: Month) => repo.getReviewDocument(idOf(month))!.classification!
  const rule = (scope: 'TEMPLATE' | 'CLASS') => anchorRules().find((r) => r.scope === scope)!
  const lastRun = (month: Month) =>
    JSON.parse(repo.extractionRuns.listForDocument(idOf(month))[0]!.metrics_json!)

  return {
    repo,
    process,
    open,
    date,
    pickDate,
    save,
    rule,
    anchorRules,
    memoryRules,
    classification,
    lastRun,
    idOf,
    reprocessed: () => queued
  }
}

describe('il motore impara dove il revisore prende la data', () => {
  it('due selezioni attivano la regola, e il documento in coda arriva già compilato', async () => {
    const flow = setup()

    // Settembre: il motore non trova la data, il revisore la seleziona.
    await flow.open('settembre')
    expect(flow.date('settembre').value).toBe('')
    flow.pickDate('settembre')
    expect(flow.save('settembre')).toContain('Apprendimento:')
    expect(flow.anchorRules().map((r) => [r.scope, r.status, r.positiveCount])).toEqual(
      expect.arrayContaining([
        ['TEMPLATE', 'CANDIDATE', 1],
        ['CLASS', 'CANDIDATE', 1]
      ])
    )
    expect(flow.rule('TEMPLATE').pattern).toEqual({ label: 'data', relation: 'same-line' })

    // Novembre è già in coda, ancora senza data: nessuna regola vale.
    await flow.open('novembre')
    expect(flow.date('novembre').value).toBe('')

    // Ottobre: seconda selezione sullo stesso modulo, la regola di template si attiva.
    await flow.open('ottobre')
    flow.pickDate('ottobre')
    expect(flow.save('ottobre')).toContain('1 regola attivata.')
    expect(flow.rule('TEMPLATE')).toMatchObject({ status: 'ACTIVE', positiveCount: 2 })
    expect(flow.rule('CLASS')).toMatchObject({ status: 'CANDIDATE', positiveCount: 2 })
    expect(flow.repo.learning.listActions()[0]).toMatchObject({
      kind: 'RULE_PROMOTED',
      detail: expect.stringContaining('Etichetta «data» per document.issue_date'),
      numbers: { support: 2, precision: 1 }
    })

    // La coda del tipo si rielabora in sottofondo: novembre ha la data, e dice da dove viene.
    await flow.reprocessed()
    const november = flow.repo.getReviewDocument(flow.idOf('novembre'))!
    const filled = flow.date('novembre')
    expect(filled).toMatchObject({ value: '2026-11-07', reviewStatus: 'AUTO_ACCEPTED' })
    expect(november.evidence.find((e) => e.id === filled.evidenceId)).toMatchObject({
      text: 'Data: 07/11/2026',
      ruleId: flow.rule('TEMPLATE').id
    })
    expect(flow.lastRun('novembre').learning).toEqual({
      mode: 'LEARNING',
      learnerVersion: 'local-learner/0.1.0',
      activeRules: 1,
      appliedRuleIds: [flow.rule('TEMPLATE').id]
    })

    // Confermarla è una prova in più per la regola che l'ha trovata.
    expect(flow.save('novembre')).toContain('2 conferme')
    expect(flow.rule('TEMPLATE')).toMatchObject({ status: 'ACTIVE', positiveCount: 3 })
    // La regola di tipo non ha letto niente: la sua prova viene solo dalle selezioni.
    expect(flow.rule('CLASS').positiveCount).toBe(2)
  })

  it('due smentite di fila sospendono la regola, e il documento dopo torna come prima', async () => {
    const flow = setup()
    for (const month of ['settembre', 'ottobre'] as const) {
      await flow.open(month)
      flow.pickDate(month)
      flow.save(month)
    }

    // Dicembre arriva compilato, ma il revisore scrive un'altra data a mano.
    await flow.open('dicembre')
    expect(flow.date('dicembre').value).toBe('2026-12-05')
    updateFieldValue(flow.repo, {
      documentId: flow.idOf('dicembre'),
      fieldId: flow.date('dicembre').id,
      correctedValue: '06/12/2026'
    })
    flow.save('dicembre')
    expect(flow.rule('TEMPLATE')).toMatchObject({
      status: 'ACTIVE',
      positiveCount: 2,
      negativeCount: 1
    })

    // Gennaio: la svuota. Seconda smentita di fila.
    await flow.open('gennaio')
    expect(flow.date('gennaio').value).toBe('2027-01-09')
    updateFieldValue(flow.repo, {
      documentId: flow.idOf('gennaio'),
      fieldId: flow.date('gennaio').id,
      correctedValue: ''
    })
    expect(flow.save('gennaio')).toContain('1 regola sospesa.')
    expect(flow.rule('TEMPLATE')).toMatchObject({ status: 'SUSPENDED', negativeCount: 2 })

    // Novembre, elaborato adesso, non ha più la data dalla regola.
    await flow.open('novembre')
    expect(flow.date('novembre').value).toBe('')
    expect(flow.lastRun('novembre').learning).toMatchObject({ activeRules: 0, appliedRuleIds: [] })
  })

  it('selezionare la stessa data che la regola ha letto non la smentisce: cambia solo la forma', async () => {
    const flow = setup()
    for (const month of ['settembre', 'ottobre'] as const) {
      await flow.open(month)
      flow.pickDate(month)
      flow.save(month)
    }
    await flow.open('novembre')
    expect(flow.date('novembre').value).toBe('2026-11-07')
    // Il revisore preferisce la data come la stampa il documento, e la seleziona.
    flow.pickDate('novembre')
    flow.save('novembre')
    expect(flow.rule('TEMPLATE')).toMatchObject({ positiveCount: 3, negativeCount: 0 })
  })
})

describe('le modalità del learner', () => {
  it('in FROZEN la stessa sequenza non impara niente', async () => {
    const flow = setup('FROZEN')
    for (const month of ['settembre', 'ottobre'] as const) {
      await flow.open(month)
      flow.pickDate(month)
      expect(flow.save(month)).toContain('Apprendimento congelato: revisione non registrata.')
    }
    expect(flow.repo.learning.counts()).toEqual({
      events: 0,
      rules: { CANDIDATE: 0, ACTIVE: 0, SUSPENDED: 0, REJECTED: 0 }
    })
    await flow.open('novembre')
    expect(flow.date('novembre').value).toBe('')
  })

  it('in BASELINE le regole attive non valgono; in FROZEN valgono ma non si mettono alla prova', async () => {
    const flow = setup()
    for (const month of ['settembre', 'ottobre'] as const) {
      await flow.open(month)
      flow.pickDate(month)
      flow.save(month)
    }

    flow.repo.learning.setMode('BASELINE')
    await flow.open('novembre')
    expect(flow.date('novembre').value).toBe('')
    expect(flow.lastRun('novembre').learning).toMatchObject({
      mode: 'BASELINE',
      activeRules: 0,
      appliedRuleIds: []
    })

    flow.repo.learning.setMode('FROZEN')
    await flow.open('novembre')
    expect(flow.date('novembre').value).toBe('2026-11-07')
    expect(flow.lastRun('novembre').learning).toMatchObject({ mode: 'FROZEN', activeRules: 1 })
    flow.save('novembre')
    expect(flow.rule('TEMPLATE').positiveCount).toBe(2)
  })
})

describe('una prova per documento', () => {
  it('richiudere un documento non vale doppio, scartarlo toglie le sue prove', async () => {
    const flow = setup()
    for (const month of ['settembre', 'ottobre'] as const) {
      await flow.open(month)
      flow.pickDate(month)
      flow.save(month)
    }
    flow.save('ottobre')
    expect(flow.rule('TEMPLATE')).toMatchObject({ positiveCount: 2 })
    expect(
      flow.repo.learning.listEvents({ documentId: flow.idOf('ottobre') }).length
    ).toBeGreaterThan(2)

    // Le due etichette e la memoria del modulo.
    expect(flow.save('ottobre', 'DISCARD')).toContain(
      'Apprendimento: tolte le prove di questo documento da 3 regole.'
    )
    expect(flow.rule('TEMPLATE')).toMatchObject({ positiveCount: 1 })
    expect(flow.rule('CLASS')).toMatchObject({ positiveCount: 1 })
  })
})

describe('il motore impara il tipo di un modulo che ritorna', () => {
  it('tre revisioni concordi: il promemoria in coda si classifica da sé, e si compila', async () => {
    const flow = setup()
    await flow.open('settembre')
    expect(flow.classification('settembre')).toMatchObject({
      decision: 'UNKNOWN',
      proposedType: null
    })

    // Dicembre è in coda senza tipo: nessuno sa ancora cosa sia.
    await flow.open('dicembre', { type: null })
    expect(flow.repo.getReviewDocument(flow.idOf('dicembre'))!.documentType).toBeNull()

    for (const month of ['settembre', 'ottobre'] as const) {
      if (month !== 'settembre') await flow.open(month)
      flow.pickDate(month)
      flow.save(month)
    }
    expect(flow.memoryRules()).toMatchObject([{ status: 'CANDIDATE', positiveCount: 2 }])

    // Terza revisione concorde: la memoria del modulo si attiva.
    await flow.open('novembre')
    expect(flow.save('novembre')).toContain('1 regola attivata.')
    const memory = flow.memoryRules()[0]!
    expect(memory).toMatchObject({ status: 'ACTIVE', positiveCount: 3, documentType: TYPE })
    expect(flow.repo.learning.listActions()[0]!.detail).toBe(
      `Memoria del modulo ${memory.templateFingerprint} come ${TYPE} attivata: 3 revisioni concordi.`
    )

    // La coda di quel modulo si rielabora: dicembre ha il tipo, e con lui la data.
    await flow.reprocessed()
    const december = flow.repo.getReviewDocument(flow.idOf('dicembre'))!
    expect(december).toMatchObject({ documentType: TYPE, typeConfidence: 0.74 })
    expect(december.classification).toMatchObject({ decision: 'ASSIGN', reason: 'OK' })
    expect(december.classification!.candidates[0]!.signals).toEqual([
      { source: 'template-memory', phrase: `modulo ${memory.templateFingerprint}`, delta: 0.74 }
    ])
    expect(december.timeline.map((event) => event.detail)).toContainEqual(
      expect.stringContaining('dalla memoria del modulo, già revisionato con questo tipo')
    )
    expect(flow.date('dicembre').value).toBe('2026-12-05')
    expect(flow.lastRun('dicembre').classifier.templateRuleIds).toEqual([memory.id])

    // Confermare il tipo proposto dalla memoria è un'altra revisione concorde.
    flow.save('dicembre')
    expect(flow.memoryRules()[0]).toMatchObject({ status: 'ACTIVE', positiveCount: 4 })
  })

  it('un conflitto la sospende, e il modulo torna senza tipo', async () => {
    const flow = setup()
    for (const month of ['settembre', 'ottobre', 'novembre'] as const) {
      await flow.open(month)
      flow.save(month)
    }
    await flow.open('dicembre', { type: null })
    expect(flow.repo.getReviewDocument(flow.idOf('dicembre'))!.documentType).toBe(TYPE)

    // Gennaio, stesso modulo, il revisore lo chiude come un altro tipo.
    await flow.open('gennaio', { type: 'accounting.fattura' })
    expect(flow.save('gennaio')).toContain('1 regola sospesa.')
    expect(flow.memoryRules()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentType: TYPE, status: 'SUSPENDED', negativeCount: 1 }),
        expect.objectContaining({ documentType: 'accounting.fattura', status: 'CANDIDATE' })
      ])
    )
    expect(flow.repo.learning.listActions()[0]!.detail).toContain(
      'lo stesso modulo è stato chiuso anche con un altro tipo (1 smentita)'
    )

    await flow.reprocessed()
    expect(flow.repo.getReviewDocument(flow.idOf('dicembre'))!.documentType).toBeNull()
  })

  it('in BASELINE la memoria dei moduli non vale', async () => {
    const flow = setup()
    for (const month of ['settembre', 'ottobre', 'novembre'] as const) {
      await flow.open(month)
      flow.save(month)
    }
    flow.repo.learning.setMode('BASELINE')
    await flow.open('dicembre', { type: null })
    expect(flow.repo.getReviewDocument(flow.idOf('dicembre'))!.documentType).toBeNull()
    expect(flow.lastRun('dicembre').classifier.templateRuleIds).toEqual([])
  })
})
