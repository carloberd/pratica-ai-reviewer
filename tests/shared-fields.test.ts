import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bandOf } from '@shared/confidence'
import {
  FIELD_LABELS,
  FIELD_SEMANTIC_TYPES,
  fieldLabel,
  sortFieldNames,
  UNIVERSAL_FIELDS
} from '@shared/fields'
import { describe, expect, it } from 'vitest'

const REGISTRY = resolve(__dirname, '../resources/registry/extraction_schemas.json')

type Schema = { properties?: Record<string, unknown>; required?: string[] }

function loadSchemas(): Record<string, Schema> {
  return JSON.parse(readFileSync(REGISTRY, 'utf8')) as Record<string, Schema>
}

describe('closed set dei campi del registry', () => {
  const schemas = loadSchemas()

  it('lo snapshot contiene i 511 tipi documentali', () => {
    expect(Object.keys(schemas)).toHaveLength(511)
  })

  it('i campi dichiarati dal registry sono esattamente i 40 del closed set', () => {
    const fromRegistry = new Set<string>()
    for (const schema of Object.values(schemas)) {
      for (const name of Object.keys(schema.properties ?? {})) fromRegistry.add(name)
    }
    expect([...fromRegistry].sort()).toEqual(Object.keys(FIELD_SEMANTIC_TYPES).sort())
    expect(fromRegistry.size).toBe(40)
  })

  it('ogni campo ha un etichetta italiana', () => {
    for (const name of Object.keys(FIELD_SEMANTIC_TYPES)) {
      expect(FIELD_LABELS[name as keyof typeof FIELD_LABELS]).toBeTruthy()
      expect(fieldLabel(name)).not.toBe(name)
    }
  })

  it('i 4 campi universali sono dichiarati da tutti i tipi', () => {
    for (const [type, schema] of Object.entries(schemas)) {
      const props = Object.keys(schema.properties ?? {})
      for (const universal of UNIVERSAL_FIELDS) {
        expect(props, `${type} deve dichiarare ${universal}`).toContain(universal)
      }
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
