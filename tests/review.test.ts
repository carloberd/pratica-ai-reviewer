import type { ReviewDocument } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { buildReviewPayload, describeReview } from '../src/main/review'

function document(overrides: Partial<ReviewDocument> = {}): ReviewDocument {
  return {
    id: 'doc-1',
    driveFileId: 'drive-1',
    filename: 'Fattura 114.pdf',
    mime: 'application/pdf',
    documentType: 'accounting.fattura',
    documentTypeLabel: 'fattura',
    typeConfidence: 0.9,
    status: 'NEEDS_REVIEW',
    confidence: 0.85,
    confidenceBand: 'MEDIUM',
    receivedAt: '2026-09-08T10:00:00.000Z',
    syncedAt: '2026-09-10T08:00:00.000Z',
    source: 'Google Drive',
    textSource: 'NATIVE_TEXT',
    cachedPath: null,
    warnings: [],
    fields: [
      {
        id: 'f1',
        name: 'issuer_name',
        label: 'Emittente',
        value: 'ALFA SRL',
        correctedValue: 'Alfa S.r.l.',
        confidence: 0.7,
        evidenceId: 'ev1',
        required: false,
        semanticType: 'string'
      },
      {
        id: 'f2',
        name: 'issue_date',
        label: 'Data di emissione',
        value: '2026-09-08',
        confidence: 0.85,
        evidenceId: 'ev2',
        required: true,
        semanticType: 'date'
      }
    ],
    evidence: [],
    timeline: [],
    ...overrides
  }
}

describe('payload della review', () => {
  it('include solo i campi realmente modificati, con before/after e provenienza', () => {
    const payload = buildReviewPayload(document(), 'CORRECT', 'verificato con il cliente')

    expect(payload.decision).toBe('CORRECT')
    expect(payload.note).toBe('verificato con il cliente')
    // `corrections` resta la mappa campo -> valore finale del contratto v5.2.
    expect(payload.corrections).toEqual({ issuer_name: 'Alfa S.r.l.' })
    expect(payload.changes).toEqual([
      {
        fieldId: 'f1',
        name: 'issuer_name',
        label: 'Emittente',
        before: 'ALFA SRL',
        after: 'Alfa S.r.l.',
        provenance: { textSource: 'NATIVE_TEXT', evidenceId: 'ev1', confidence: 0.7 }
      }
    ])
  })

  it('senza correzioni non emette né corrections né changes', () => {
    const clean = document({
      fields: [
        {
          id: 'f2',
          name: 'issue_date',
          label: 'Data di emissione',
          value: '2026-09-08',
          confidence: 0.85,
          required: true,
          semanticType: 'date'
        }
      ]
    })
    expect(buildReviewPayload(clean, 'APPROVE')).toEqual({ decision: 'APPROVE' })
  })

  it('registra anche il riempimento di un campo che era vuoto', () => {
    const filled = document({
      fields: [
        {
          id: 'f3',
          name: 'document_number',
          label: 'Numero documento',
          value: '',
          correctedValue: '114/2026',
          confidence: 0,
          required: true,
          semanticType: 'string'
        }
      ]
    })
    const payload = buildReviewPayload(filled, 'CORRECT')
    expect(payload.changes?.[0]).toMatchObject({ before: '', after: '114/2026' })
  })

  it('descrive la decisione per la timeline', () => {
    expect(describeReview(buildReviewPayload(document(), 'CORRECT'))).toEqual({
      title: 'Approvato con correzioni',
      detail: '1 campo corretto: Emittente «ALFA SRL» → «Alfa S.r.l.»'
    })
    expect(describeReview({ decision: 'REJECT', note: 'documento illeggibile' })).toEqual({
      title: 'Documento rifiutato',
      detail: 'Nessun campo modificato. Nota: documento illeggibile'
    })
  })
})
