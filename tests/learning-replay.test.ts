import { afterAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/db'
import { createRepository } from '../src/main/db/repository'
import { createReloadableExtractionRegistry } from '../src/main/extract/v2/profile-loader'
import { updateFieldValue } from '../src/main/field-edits'
import { replayReviews } from '../src/main/learning-replay'
import { createDocumentProcessor } from '../src/main/pipeline'
import { assignDocumentType } from '../src/main/reprocess'
import { submitReview } from '../src/main/review'
import { fixture, REGISTRY_DIR } from './helpers/registry'

/**
 * Il ripasso delle revisioni già chiuse.
 *
 * Il caso vero: il learner acceso a revisione iniziata. Sull'export del 18/09/2026 aveva
 * 122 eventi su 11 documenti contro 281 correzioni su 41 — le chiusure di prima nessuno
 * gliele aveva viste. Qui si riproduce con la modalità: si revisiona in FROZEN, dove non
 * si registra niente, poi si passa a LEARNING e si ripassa.
 */

const PDF = 'application/pdf'
const TYPE = 'payments_treasury.richiesta_pagamento'
const ACTOR = 'revisore@example.com'
const CHI_RIPASSA = 'altro@example.com'

const SERIES = {
  settembre: ['promemoria-ignoto.pdf', '12/09/2026'],
  ottobre: ['promemoria-ottobre.pdf', '10/10/2026']
} as const

type Month = keyof typeof SERIES

const closers: Array<() => void> = []
afterAll(() => {
  for (const close of closers) close()
})

function setup() {
  const db = openDatabase({ file: ':memory:' })
  closers.push(() => db.close())
  let registry: ReturnType<typeof createReloadableExtractionRegistry>
  const repo = createRepository(db, {
    requiredFields: (type) => (type ? (registry.baseProfile(type)?.required_fields ?? []) : []),
    typeLabel: (type) => (type ? (registry.baseProfile(type)?.canonical_name ?? null) : null)
  })
  registry = createReloadableExtractionRegistry(REGISTRY_DIR, () => repo.profileMap.overlay())
  const extractionRegistry = registry
  const process = createDocumentProcessor({ repo, extractionRegistry })
  const ids = new Map<Month, string>()

  async function open(month: Month) {
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
    await assignDocumentType({ repo, documentId: id, documentType: TYPE, process })
    return id
  }

  const idOf = (month: Month) => ids.get(month)!

  /** Il revisore seleziona la data sul documento e chiude. */
  function reviewAndSave(month: Month, now: Date) {
    const id = idOf(month)
    const field = repo.getReviewDocument(id)!.fields.find((f) => f.name === 'document.issue_date')!
    const text = SERIES[month][1]
    const line = repo.pages.lines(id, 1).find((candidate) => candidate.text.includes(text))!
    updateFieldValue(repo, {
      documentId: id,
      fieldId: field.id,
      correctedValue: text,
      pick: { method: 'TEXT_SELECTION', page: 1, text, ...(line.bbox ? { bbox: line.bbox } : {}) }
    })
    submitReview(repo, {
      documentId: id,
      action: 'SAVE',
      actor: ACTOR,
      now,
      registry: extractionRegistry
    })
  }

  const replay = (now: Date) =>
    replayReviews({ repo, actor: CHI_RIPASSA, registry: extractionRegistry, now })

  return { repo, open, idOf, reviewAndSave, replay, extractionRegistry }
}

const NOW = new Date('2026-09-18T09:00:00.000Z')
const CHIUSURA = new Date('2026-09-15T08:00:00.000Z')

describe('ripasso delle revisioni già chiuse', () => {
  it('recupera quello che il learner non aveva visto perché era spento', async () => {
    const flow = setup()
    flow.repo.learning.setMode('FROZEN')
    await flow.open('settembre')
    await flow.open('ottobre')
    flow.reviewAndSave('settembre', CHIUSURA)
    flow.reviewAndSave('ottobre', CHIUSURA)

    // In FROZEN non si registra niente: è il buco che il ripasso deve colmare.
    expect(flow.repo.learning.listEvents()).toHaveLength(0)
    expect(flow.repo.learning.listRules({})).toHaveLength(0)

    flow.repo.learning.setMode('LEARNING')
    const result = flow.replay(NOW)

    expect(result).toMatchObject({ documents: 2, replayed: 2 })
    expect(flow.repo.learning.listEvents().length).toBeGreaterThan(0)
    // Le due selezioni della stessa etichetta sullo stesso modulo: due prove.
    const anchors = flow.repo.learning.listRules({ kind: 'EXTRACTION_ANCHOR' })
    expect(anchors.length).toBeGreaterThan(0)
    expect(anchors.some((rule) => rule.positiveCount === 2)).toBe(true)
  })

  it('lʼevento dice quando il revisore ha deciso e quando è stato scritto', async () => {
    const flow = setup()
    flow.repo.learning.setMode('FROZEN')
    await flow.open('settembre')
    flow.reviewAndSave('settembre', CHIUSURA)
    flow.repo.learning.setMode('LEARNING')
    flow.replay(NOW)

    const event = flow.repo.learning.listEvents()[0]!
    // `at` è il momento della chiusura, non quello del ripasso: la cronologia non mente.
    expect(event.at).toBe(CHIUSURA.toISOString())
    expect(event.replayedAt).toBe(NOW.toISOString())
    // `actor` è chi ha lanciato il ripasso: chi aveva chiuso non è mai stato salvato sul
    // documento, e `replayedAt` è lì perché il registro non dica una cosa che non sa.
    expect(event.actor).toBe(CHI_RIPASSA)
  })

  it('è idempotente: rilanciarlo non conta due volte', async () => {
    const flow = setup()
    flow.repo.learning.setMode('FROZEN')
    await flow.open('settembre')
    flow.reviewAndSave('settembre', CHIUSURA)
    flow.repo.learning.setMode('LEARNING')

    flow.replay(NOW)
    const after = flow.repo.learning
      .listRules({ kind: 'EXTRACTION_ANCHOR' })
      .map((rule) => [rule.ruleKey, rule.positiveCount, rule.negativeCount])
    const events = flow.repo.learning.listEvents().length

    flow.replay(new Date('2026-09-18T10:00:00.000Z'))
    expect(
      flow.repo.learning
        .listRules({ kind: 'EXTRACTION_ANCHOR' })
        .map((rule) => [rule.ruleKey, rule.positiveCount, rule.negativeCount])
    ).toEqual(after)
    // Gli eventi sono append-only: il ripasso ne riscrive di nuovi, le prove no.
    expect(flow.repo.learning.listEvents().length).toBe(events * 2)
  })

  it('una revisione registrata sul momento non ha una data di ripasso', async () => {
    const flow = setup()
    flow.repo.learning.setMode('LEARNING')
    await flow.open('settembre')
    flow.reviewAndSave('settembre', CHIUSURA)

    expect(flow.repo.learning.listEvents()[0]!.replayedAt).toBeNull()
  })

  it('senza revisioni chiuse non fa niente', () => {
    const flow = setup()
    flow.repo.learning.setMode('LEARNING')
    expect(flow.replay(NOW)).toMatchObject({ documents: 0, replayed: 0 })
  })

  it('fuori da LEARNING non registra: il ripasso è una registrazione come le altre', async () => {
    const flow = setup()
    flow.repo.learning.setMode('FROZEN')
    await flow.open('settembre')
    flow.reviewAndSave('settembre', CHIUSURA)

    expect(flow.replay(NOW)).toMatchObject({ documents: 1, replayed: 0 })
    expect(flow.repo.learning.listEvents()).toHaveLength(0)
  })
})
