import { describe, expect, it } from 'vitest'
import type { DatasetScalarField } from '../src/shared/dataset'
import { fieldOrigin, toDatasetDocument } from '../src/shared/dataset'
import type { ExtractedField } from '../src/shared/types'
import { reviewDocument, scalarField } from './helpers/review-document'

/**
 * Una scadenza dedotta non è una scadenza letta.
 *
 * Il motore propone la scadenza di un attestato di formazione calcolandola dalla
 * normativa, quando il documento non la scrive. Nel dataset quel valore deve dirlo: senza
 * un'origine sua si conterebbe come una lettura riuscita, e chi misura l'estrazione
 * leggerebbe una copertura che il motore non ha.
 */

const expiry = (overrides: Partial<ExtractedField> = {}) =>
  scalarField({
    id: 'f-expiry',
    name: 'hse.training_expiry',
    label: 'Scadenza formazione',
    value: '2026-05-13',
    confidence: 0.6,
    required: false,
    semanticType: 'date',
    role: 'core',
    reviewStatus: 'NEEDS_REVIEW',
    computed: true,
    ...overrides
  })

const exported = (field: ExtractedField) => {
  const document = reviewDocument({ status: 'REVIEWED', fields: [field] })
  return toDatasetDocument({ document, extraction: null })!.fields[0] as DatasetScalarField
}

describe('lʼorigine di un valore dedotto', () => {
  it('confermato comʼè, è COMPUTED e non ENGINE', () => {
    expect(fieldOrigin(expiry())).toBe('COMPUTED')
    const field = exported(expiry())
    expect(field).toMatchObject({ value: '2026-05-13', origin: 'COMPUTED' })
    // Nel documento quella data non c'è: non può avere un'evidenza verbatim.
    expect(field.evidence).toBeNull()
  })

  it('corretto dal revisore, torna suo', () => {
    expect(fieldOrigin(expiry({ correctedValue: '2026-05-04' }))).toBe('REVIEWER')
  })

  it('svuotato dal revisore non ha origine, come ogni campo vuoto', () => {
    expect(fieldOrigin(expiry({ correctedValue: '' }))).toBeNull()
  })

  it('un valore letto resta ENGINE', () => {
    expect(fieldOrigin(scalarField())).toBe('ENGINE')
    expect(exported(scalarField()).origin).toBe('ENGINE')
  })
})
