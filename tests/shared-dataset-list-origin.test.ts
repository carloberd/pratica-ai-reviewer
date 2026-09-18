import { describe, expect, it } from 'vitest'
import type { DatasetListField } from '../src/shared/dataset'
import { listOrigin, toDatasetDocument } from '../src/shared/dataset'
import { item, listField, reviewDocument, scalarField } from './helpers/review-document'

/**
 * Da chi vengono le righe di un campo ripetuto.
 *
 * `origin` c'era sui campi singoli e mancava sui `many`, dove stava solo riga per riga
 * dentro `items`. Chi contava le origini leggendo `field.origin` — un'analisi dell'export,
 * un benchmark — sui campi ripetuti si trovava `undefined` invece di un errore, e li
 * perdeva in silenzio.
 */

const listOf = (...items: Parameters<typeof listField>[0]) => {
  const document = reviewDocument({ status: 'REVIEWED', fields: [listField(items)] })
  const exported = toDatasetDocument({ document, extraction: null })!
  return exported.fields[0] as DatasetListField
}

describe('lʼorigine di una lista', () => {
  it('tutte del motore', () => {
    expect(listOrigin([{ origin: 'ENGINE' }, { origin: 'ENGINE' }])).toBe('ENGINE')
  })

  it('tutte del revisore', () => {
    expect(listOrigin([{ origin: 'REVIEWER' }])).toBe('REVIEWER')
  })

  it('un poʼ e un poʼ: MIXED', () => {
    expect(listOrigin([{ origin: 'ENGINE' }, { origin: 'REVIEWER' }])).toBe('MIXED')
  })

  it('lista vuota: nessuna origine, come un campo singolo rimasto vuoto', () => {
    expect(listOrigin([])).toBeNull()
  })
})

describe('il campo ripetuto nel dataset', () => {
  it('porta lʼorigine della lista accanto a quelle delle righe', () => {
    const field = listOf(
      item({ id: 'i0', index: 0, value: 'Demolizione tramezzi' }),
      item({ id: 'i1', index: 1, value: 'Posa massetto', origin: 'MANUAL' })
    )

    expect(field.origin).toBe('MIXED')
    expect(field.items.map((row) => row.origin)).toEqual(['ENGINE', 'REVIEWER'])
  })

  it('una riga proposta e poi corretta è del revisore, e la lista con lei', () => {
    const field = listOf(
      item({ id: 'i0', index: 0, value: 'Posa massetto', correctedValue: 'Posa massetto 8 cm' })
    )

    expect(field.origin).toBe('REVIEWER')
    expect(field.value).toEqual(['Posa massetto 8 cm'])
  })

  it('le righe tolte non contano nellʼorigine, come non contano nei valori', () => {
    const field = listOf(
      item({ id: 'i0', index: 0, value: 'Demolizione tramezzi' }),
      item({ id: 'i1', index: 1, value: 'Riga sbagliata', removed: true })
    )

    expect(field.origin).toBe('ENGINE')
    expect(field.value).toEqual(['Demolizione tramezzi'])
  })

  it('una lista vuota non ha origine', () => {
    expect(listOf().origin).toBeNull()
  })

  it('i campi singoli non cambiano', () => {
    const document = reviewDocument({
      status: 'REVIEWED',
      fields: [scalarField({ value: '114/2026' })]
    })
    const exported = toDatasetDocument({ document, extraction: null })!
    expect(exported.fields[0]).toMatchObject({ cardinality: 'one', origin: 'ENGINE' })
  })
})
