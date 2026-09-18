import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../src/main/db'
import { createRepository } from '../src/main/db/repository'
import { updateFieldValue } from '../src/main/field-edits'
import { createDocumentProcessor } from '../src/main/pipeline'
import { assignDocumentType } from '../src/main/reprocess'
import { submitReview } from '../src/main/review'
import type { LearningMode } from '../src/shared/local-learning'
import {
  normalizedTemplateSignature,
  templateFingerprint
} from '../src/shared/template-fingerprint'
import { createTestRepository, seedDocument } from './helpers/db'
import {
  fixture,
  testClassifierConfigV2,
  testLegacyFieldMap,
  testRegistry,
  testRegistryV2
} from './helpers/registry'

let repo: ReturnType<typeof createTestRepository> | null = null

afterEach(() => {
  repo?.close()
  repo = null
})

const ACTOR = 'revisore@example.com'
const NOW = new Date('2026-09-17T10:00:00.000Z')

/** Una fattura con tipo del motore, un campo proposto e uno corretto. */
function setup() {
  const r = createTestRepository()
  repo = r
  const id = seedDocument(r)
  r.fields.replaceForDocument(id, [
    { name: 'issuer.name', label: 'Emittente', value: 'ALFA SRL', confidence: 0.7 },
    { name: 'document.issue_date', label: 'Data emissione', value: '2026-09-08', confidence: 0.85 }
  ])
  r.documents.setExtraction(id, {
    documentType: 'accounting.fattura',
    typeConfidence: 0.9,
    confidence: 0.775,
    confidenceBand: 'MEDIUM',
    textSource: 'NATIVE_TEXT'
  })
  const issuer = r.fields.listForDocument(id).find((field) => field.name === 'issuer.name')!
  r.fields.setCorrectedValue(issuer.id, 'Alfa S.r.l.')
  return { r, id }
}

const lastDetail = (r: NonNullable<typeof repo>, id: string) =>
  r.getReviewDocument(id)!.timeline.at(-1)!.detail

describe('una revisione salvata insegna al learner', () => {
  it('in LEARNING registra una decisione per il tipo e per ogni campo, e la timeline lo dice', () => {
    const { r, id } = setup()
    submitReview(r, { documentId: id, action: 'SAVE', now: NOW, actor: ACTOR })

    expect(
      r.learning
        .listEvents({ documentId: id })
        .map(({ kind, outcome, fieldId }) => [kind, outcome, fieldId])
    ).toEqual([
      ['DOCUMENT_TYPE', 'CONFIRMED', null],
      ['FIELD_VALUE', 'CHANGED', 'issuer.name'],
      ['FIELD_VALUE', 'CONFIRMED', 'document.issue_date']
    ])
    expect(r.learning.listEvents()[0]).toMatchObject({
      at: NOW.toISOString(),
      actor: ACTOR,
      documentType: 'accounting.fattura',
      learnerVersion: 'local-learner/0.1.0'
    })
    expect(lastDetail(r, id)).toBe(
      '1 campo corretto: Emittente «ALFA SRL» → «Alfa S.r.l.» Apprendimento: 3 decisioni registrate (2 conferme, 1 correzione).'
    )
  })

  it('uno scarto non insegna niente, e non lo dice', () => {
    const { r, id } = setup()
    submitReview(r, { documentId: id, action: 'DISCARD', now: NOW, actor: ACTOR })
    expect(r.learning.listEvents()).toEqual([])
    expect(lastDetail(r, id)).not.toContain('Apprendimento')
  })

  it.each([
    ['FROZEN', 'Apprendimento congelato: revisione non registrata.'],
    ['BASELINE', 'Solo registry: revisione non registrata.']
  ] as Array<[LearningMode, string]>)(
    'in %s la revisione si salva ma non si registra',
    (mode, note) => {
      const { r, id } = setup()
      r.learning.setMode(mode)
      const document = submitReview(r, { documentId: id, action: 'SAVE', now: NOW, actor: ACTOR })

      expect(document.status).toBe('REVIEWED')
      expect(r.learning.counts().events).toBe(0)
      expect(lastDetail(r, id)).toContain(note)
    }
  )

  it('senza un account collegato non c’è un autore, e non si registra', () => {
    const { r, id } = setup()
    submitReview(r, { documentId: id, action: 'SAVE', now: NOW, actor: null })
    expect(r.learning.counts().events).toBe(0)
    expect(lastDetail(r, id)).toContain(
      'Apprendimento: revisione non registrata, nessun account collegato.'
    )
  })

  it('se la registrazione fallisce, la revisione non si salva: niente a metà', () => {
    const { r, id } = setup()
    vi.spyOn(r.learning, 'acquire').mockImplementation(() => {
      throw new Error('deposito non disponibile')
    })

    expect(() =>
      submitReview(r, { documentId: id, action: 'SAVE', now: NOW, actor: ACTOR })
    ).toThrow('deposito non disponibile')
    const document = r.getReviewDocument(id)!
    expect(document.status).toBe('NEEDS_REVIEW')
    expect(document.reviewedAt).toBeNull()
    expect(document.timeline).toEqual([])
  })

  it('richiudere un documento registra di nuovo: il registro non si riscrive', () => {
    const { r, id } = setup()
    submitReview(r, { documentId: id, action: 'SAVE', now: NOW, actor: ACTOR })
    submitReview(r, {
      documentId: id,
      action: 'SAVE',
      now: new Date('2026-09-17T11:00:00.000Z'),
      actor: ACTOR
    })
    expect(r.learning.listEvents({ documentId: id })).toHaveLength(6)
  })
})

describe('dal documento vero al registro', () => {
  it('tipo scelto a mano, data selezionata sul documento, importo confermato', async () => {
    const registry = testRegistry()
    const db = openDatabase({ file: ':memory:' })
    const r = createRepository(db, { requiredFields: (type) => registry.requiredFor(type) })
    const process = createDocumentProcessor({
      repo: r,
      registry,
      engines: { classifier: 'v2', extraction: 'v2' },
      classifierConfigV2: testClassifierConfigV2(),
      extractionRegistryV2: testRegistryV2(),
      legacyFieldMap: testLegacyFieldMap()
    })
    const { id } = r.documents.upsertFromDrive({
      driveFileId: 'drive-memo',
      filename: 'promemoria-ignoto.pdf',
      mime: 'application/pdf',
      receivedAt: null
    })
    r.documents.setCachedPath(id, fixture('promemoria-ignoto.pdf'))
    await process({
      documentId: id,
      cachedPath: fixture('promemoria-ignoto.pdf'),
      mime: 'application/pdf',
      filename: 'promemoria-ignoto.pdf'
    })
    await assignDocumentType({
      repo: r,
      documentId: id,
      documentType: 'payments_treasury.richiesta_pagamento',
      process
    })
    const date = r.getReviewDocument(id)!.fields.find((f) => f.name === 'document.issue_date')!
    updateFieldValue(r, {
      documentId: id,
      fieldId: date.id,
      correctedValue: '12/09/2026',
      pick: {
        method: 'TEXT_SELECTION',
        page: 1,
        text: '12/09/2026',
        bbox: { x: 87.6, y: 131, w: 52.7, h: 11 }
      }
    })

    submitReview(r, { documentId: id, action: 'SAVE', now: NOW, actor: ACTOR })

    const row = r.documents.get(id)!
    const events = r.learning.listEvents({ documentId: id })
    expect(events.map(({ kind, outcome, fieldId }) => [kind, outcome, fieldId])).toEqual([
      // Il classificatore non aveva assegnato niente: il tipo l'ha scelto il revisore.
      ['DOCUMENT_TYPE', 'FILLED', null],
      ['FIELD_VALUE', 'FILLED', 'document.issue_date'],
      ['FIELD_VALUE', 'CONFIRMED', 'money.amount']
    ])
    expect(events[1]).toMatchObject({
      contentSha256: row.content_sha256,
      templateFingerprint: row.template_fingerprint,
      documentType: 'payments_treasury.richiesta_pagamento',
      engineConfidence: null,
      pick: {
        method: 'TEXT_SELECTION',
        page: 1,
        location: { lineStart: 3, lineEnd: 3, charStart: 99, charEnd: 109 }
      }
    })
    expect(row.content_sha256).toMatch(/^[0-9a-f]{64}$/)
    db.close()
  })
})

/**
 * Due esemplari dello stesso stampato che l'impronta esatta separava: una riga in più sul
 * secondo, quindi due impronte. Prima della firma ognuno imparava una regola di template a
 * supporto 1, e nessuna delle due arrivava mai ad attivarsi.
 */
describe('due esemplari dello stesso modulo insegnano alla stessa regola', () => {
  const TESTATA = [
    'RICHIESTA PAGAMENTO',
    'Ufficio tesoreria',
    'Beneficiario: Alfa S.r.l.',
    'Causale: saldo fattura'
  ]

  function esemplare(
    r: NonNullable<typeof repo>,
    driveFileId: string,
    righe: string[],
    data: string
  ): string {
    const id = seedDocument(r, { driveFileId, filename: `${driveFileId}.pdf` })
    const lines = [...righe, `Data contabile: ${data}`].map((text) => ({ text }))
    r.pages.replaceForDocument(id, [{ page: 1, textSource: 'NATIVE_TEXT', lines }])
    r.documents.setContentIdentity(id, {
      contentSha256: driveFileId,
      templateFingerprint: templateFingerprint(lines.map((line) => line.text)),
      templateSignature: normalizedTemplateSignature(lines.map((line) => line.text))
    })
    r.documents.setExtraction(id, {
      documentType: 'accounting.fattura',
      typeConfidence: 0.9,
      confidence: 0.8,
      confidenceBand: 'MEDIUM',
      textSource: 'NATIVE_TEXT'
    })
    r.fields.replaceForDocument(id, [
      { name: 'document.issue_date', label: 'Data emissione', value: '', confidence: 0 }
    ])
    const field = r.fields.listForDocument(id)[0]!
    updateFieldValue(r, {
      documentId: id,
      fieldId: field.id,
      correctedValue: data,
      pick: { method: 'TEXT_SELECTION', page: 1, text: data }
    })
    return id
  }

  it('una sola regola di template, con le prove di tutti e due: attiva', () => {
    const r = createTestRepository()
    repo = r
    const registry = testRegistryV2()

    const primo = esemplare(r, 'doc-1', TESTATA, '12/09/2026')
    // Il secondo ha una riga in più: stessa testata, altra impronta.
    const secondo = esemplare(r, 'doc-2', [...TESTATA, 'Copia per archivio'], '10/10/2026')
    expect(r.documents.get(primo)!.template_fingerprint).not.toBe(
      r.documents.get(secondo)!.template_fingerprint
    )

    submitReview(r, { documentId: primo, action: 'SAVE', now: NOW, actor: ACTOR, registry })
    submitReview(r, { documentId: secondo, action: 'SAVE', now: NOW, actor: ACTOR, registry })

    const template = r.learning
      .listRules({ kind: 'EXTRACTION_ANCHOR' })
      .filter((rule) => rule.scope === 'TEMPLATE')
    expect(template).toHaveLength(1)
    expect(template[0]!.positiveCount).toBe(2)
    expect(template[0]!.status).toBe('ACTIVE')
  })
})
