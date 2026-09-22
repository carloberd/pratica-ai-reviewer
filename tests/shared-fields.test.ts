import { bandOf } from '@shared/confidence'
import {
  FIELD_LABELS,
  FIELD_SEMANTIC_TYPES,
  fieldLabel,
  sortFieldNames,
  UNIVERSAL_FIELDS
} from '@shared/fields'
import { describe, expect, it } from 'vitest'

/**
 * Il closed set dei 40 nomi campo del motore v1. Lo snapshot da cui venivano non è più nel
 * repository — il registry adesso sono due file con gli id dell'ontologia — ma i nomi
 * restano: nel database ci sono documenti revisionati quando i campi si chiamavano così,
 * e la scheda deve saperli ancora leggere.
 */
describe('closed set dei campi del motore v1', () => {
  it('sono quaranta, e non ne entrano altri senza passare di qui', () => {
    expect(Object.keys(FIELD_SEMANTIC_TYPES)).toHaveLength(40)
  })

  it('ogni campo ha un etichetta italiana', () => {
    for (const name of Object.keys(FIELD_SEMANTIC_TYPES)) {
      expect(FIELD_LABELS[name as keyof typeof FIELD_LABELS]).toBeTruthy()
      expect(fieldLabel(name)).not.toBe(name)
    }
  })

  it('i 4 campi universali stanno nel closed set', () => {
    for (const universal of UNIVERSAL_FIELDS) {
      expect(Object.keys(FIELD_SEMANTIC_TYPES), universal).toContain(universal)
    }
  })

  it('la ripartizione per tipo semantico è 12 date, 6 money, 22 string', () => {
    const counts = Object.values(FIELD_SEMANTIC_TYPES).reduce<Record<string, number>>(
      (acc, type) => {
        acc[type] = (acc[type] ?? 0) + 1
        return acc
      },
      {}
    )
    expect(counts).toEqual({ date: 12, money: 6, string: 22 })
  })

  it('l ordinamento mette prima gli universali, poi le etichette in ordine italiano', () => {
    const sorted = sortFieldNames(['total_amount', 'issue_date', 'amount', 'document_number'])
    expect(sorted).toEqual(['document_number', 'issue_date', 'amount', 'total_amount'])
  })
})

describe('bande di confidence', () => {
  it.each([
    [0.95, 'HIGH'],
    [0.9, 'HIGH'],
    [0.89, 'MEDIUM'],
    [0.75, 'MEDIUM'],
    [0.7499, 'LOW'],
    [0, 'LOW']
  ])('%s -> %s', (value, band) => {
    expect(bandOf(value as number)).toBe(band)
  })
})
