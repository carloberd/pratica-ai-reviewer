import { afterEach, describe, expect, it } from 'vitest'
import {
  buildReviewPayload,
  describeReview,
  statusForAction,
  submitReview
} from '../src/main/review'
import { createTestRepository, seedDocument } from './helpers/db'

let repo: ReturnType<typeof createTestRepository> | null = null

afterEach(() => {
  repo?.close()
  repo = null
})

/** Riproduce quello che fanno i canali `fields:update` e `review:submit`. */
function setup() {
  const r = createTestRepository()
  repo = r
  const id = seedDocument(r)
  const [evidenceId] = r.evidence.replaceForDocument(id, [
    { page: 1, text: 'Emittente: ALFA SRL', confidence: 0.7 }
  ])
  r.fields.replaceForDocument(id, [
    { name: 'issuer_name', label: 'Emittente', value: 'ALFA SRL', confidence: 0.7, evidenceId },
    { name: 'issue_date', label: 'Data di emissione', value: '2026-09-08', confidence: 0.85 }
  ])
  r.documents.setExtraction(id, {
    documentType: 'accounting.fattura',
    typeConfidence: 0.9,
    confidence: 0.775,
    confidenceBand: 'MEDIUM',
    textSource: 'NATIVE_TEXT'
  })
  return { repo: r, id }
}

function correct(
  r: ReturnType<typeof createTestRepository>,
  id: string,
  name: string,
  value: string | null
) {
  const field = r.fields.listForDocument(id).find((f) => f.name === name)!
  const trimmed = value?.trim() ?? null
  r.fields.setCorrectedValue(
    field.id,
    trimmed === null || trimmed === (field.value ?? '') ? null : trimmed
  )
}

describe('flusso di revisione', () => {
  it('registra una correzione e la porta nel payload con provenienza', () => {
    const { repo: r, id } = setup()
    correct(r, id, 'issuer_name', 'Alfa S.r.l.')

    const document = r.getReviewDocument(id)!
    const payload = buildReviewPayload(document, 'SAVE', 'ragione sociale per esteso')

    expect(payload.corrections).toEqual({ issuer_name: 'Alfa S.r.l.' })
    expect(payload.changes?.[0]?.before).toBe('ALFA SRL')
    expect(payload.changes?.[0]?.provenance.textSource).toBe('NATIVE_TEXT')
    expect(payload.changes?.[0]?.provenance.evidenceId).toBeTruthy()
  })

  it('riscrivere lo stesso valore non conta come correzione', () => {
    const { repo: r, id } = setup()
    correct(r, id, 'issuer_name', '  ALFA SRL  ')

    const document = r.getReviewDocument(id)!
    expect(document.fields.find((f) => f.name === 'issuer_name')?.correctedValue).toBeUndefined()
    expect(buildReviewPayload(document, 'SAVE')).toEqual({ decision: 'APPROVE' })
  })

  it('SAVE manda il documento nel dataset, DISCARD lo tiene fuori, e la timeline lo registra', () => {
    for (const [action, status] of [
      ['SAVE', 'REVIEWED'],
      ['DISCARD', 'DISCARDED']
    ] as const) {
      const { repo: r, id } = setup()
      const payload = buildReviewPayload(r.getReviewDocument(id)!, action)
      const { title, detail } = describeReview(payload)

      r.transaction(() => {
        r.documents.setStatus(id, statusForAction(action))
        r.events.add(id, title, detail)
      })

      expect(r.documents.get(id)?.status).toBe(status)
      expect(r.events.listForDocument(id).at(-1)?.title).toBe(title)
      r.close()
      repo = null
    }
  })

  it('il valore corretto è quello che la UI mostra e che i filtri vedono', () => {
    const { repo: r, id } = setup()
    correct(r, id, 'issuer_name', 'Alfa S.r.l.')
    r.documents.setStatus(id, 'REVIEWED')

    const summary = r.listSummaries({ status: 'REVIEWED' })
    expect(summary.map((doc) => doc.id)).toEqual([id])
    expect(r.listSummaries({ status: 'NEEDS_REVIEW' })).toEqual([])

    const document = r.getReviewDocument(id)!
    const field = document.fields.find((f) => f.name === 'issuer_name')!
    expect(field.value).toBe('ALFA SRL')
    expect(field.correctedValue).toBe('Alfa S.r.l.')
  })

  it('annullare la correzione riporta il campo al precompilato', () => {
    const { repo: r, id } = setup()
    correct(r, id, 'issuer_name', 'Alfa S.r.l.')
    correct(r, id, 'issuer_name', null)

    const document = r.getReviewDocument(id)!
    expect(document.fields.find((f) => f.name === 'issuer_name')?.correctedValue).toBeUndefined()
  })

  it('submitReview fissa stato, momento della decisione, nota e riga di timeline', () => {
    const { repo: r, id } = setup()
    correct(r, id, 'issuer_name', 'Alfa S.r.l.')

    const document = submitReview(r, {
      documentId: id,
      action: 'SAVE',
      note: 'ok',
      now: new Date('2026-09-16T09:30:00.000Z')
    })

    expect(document.status).toBe('REVIEWED')
    expect(document.reviewedAt).toBe('2026-09-16T09:30:00.000Z')
    // La nota sta su una colonna sua, non solo nel testo della timeline: è da lì che
    // l'export la rilegge.
    expect(document.reviewNote).toBe('ok')
    expect(document.timeline.at(-1)).toMatchObject({
      at: '2026-09-16T09:30:00.000Z',
      title: 'Revisionato con correzioni'
    })
    expect(() => submitReview(r, { documentId: 'nessuno', action: 'SAVE' })).toThrow(
      'Documento non trovato'
    )
  })

  it('richiudere un documento senza scrivere niente cancella la nota di prima', () => {
    const { repo: r, id } = setup()
    submitReview(r, { documentId: id, action: 'SAVE', note: 'da ricontrollare' })
    expect(r.getReviewDocument(id)!.reviewNote).toBe('da ricontrollare')

    submitReview(r, { documentId: id, action: 'SAVE' })
    expect(r.getReviewDocument(id)!.reviewNote).toBeNull()
  })
})
