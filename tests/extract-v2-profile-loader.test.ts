import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createExtractionRegistryV2,
  loadLegacyFieldMap
} from '../src/main/extract/v2/profile-loader'
import { REGISTRY_DIR, REGISTRY_V2_DIR, testRegistry, testRegistryV2 } from './helpers/registry'

const registry = testRegistryV2()

const dirs: string[] = []

/** Copia del registry v2 reale da modificare in un test. */
function registryCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'registry-v2-'))
  dirs.push(dir)
  cpSync(REGISTRY_V2_DIR, dir, { recursive: true })
  return dir
}

function editJson<T>(dir: string, file: string, edit: (data: T) => void): void {
  const path = join(dir, file)
  const data = JSON.parse(readFileSync(path, 'utf8'))
  edit(data)
  writeFileSync(path, JSON.stringify(data))
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('profili espliciti', () => {
  it('restituisce il profilo v2 del tipo con i suoi ruoli', () => {
    expect(registry.profileSource('accounting.fattura')).toBe('V2_EXPLICIT')
    const profile = registry.profile('accounting.fattura')!
    expect(profile.schema_state).toBe('EXTRACTION_SCHEMA_READY_FOR_FIELD_TEST')
    expect(profile.required_fields).toEqual([
      'document.number',
      'document.issue_date',
      'issuer.name',
      'recipient.name',
      'money.total'
    ])
    expect(profile.core_fields).toContain('line_items')
  })

  it('espone ontologia, hint e versione dei profili', () => {
    expect(registry.field('line_items')).toMatchObject({
      type: 'object',
      default_cardinality: 'many'
    })
    expect(registry.field('non.esiste')).toBeNull()
    expect(registry.hints('money.total')).toContain('totale documento')
    expect(registry.hints('non.esiste')).toEqual([])
    expect(registry.schemaVersion()).toBe('2.0.0')
  })

  it('ritrova i nomi v1 che la mappa porta su un id dell’ontologia', () => {
    expect(registry.legacyNames('document.number')).toEqual(['document_number'])
    expect(registry.legacyNames('money.amount')).toEqual(['amount', 'customs_value'])
    expect(registry.legacyNames('line_items')).toEqual([])
  })
})

describe('LEGACY_FALLBACK', () => {
  it('sintetizza il profilo dallo schema v1 portando i campi sull’ontologia', () => {
    expect(registry.profileSource('accounting.fattura_elettronica')).toBe('LEGACY_FALLBACK')
    const profile = registry.profile('accounting.fattura_elettronica')!
    expect(profile).toMatchObject({
      document_type_id: 'accounting.fattura_elettronica',
      family: 'accounting',
      schema_state: 'EXTRACTION_SCHEMA_LEGACY_FALLBACK',
      required_fields: ['document.number', 'document.issue_date'],
      core_fields: [
        'issuer.name',
        'recipient.name',
        'money.taxable',
        'money.tax',
        'money.total',
        'money.currency'
      ],
      optional_fields: [],
      conditional_fields: [],
      unknown_value_policy: 'LEAVE_EMPTY'
    })
    // Sintetizzato una volta sola.
    expect(registry.profile('accounting.fattura_elettronica')).toBe(profile)
  })

  it('nessuno dei 511 tipi del registry resta senza profilo', () => {
    const sources = testRegistry()
      .types()
      .map((type) => registry.profileSource(type.id))
    expect(sources).not.toContain('MISSING')
    expect(sources.filter((source) => source === 'LEGACY_FALLBACK')).toHaveLength(16)
  })
})

describe('tipo senza profilo', () => {
  it('MISSING restituisce null senza errori', () => {
    expect(registry.profileSource('slug.manuale')).toBe('MISSING')
    expect(registry.profile('slug.manuale')).toBeNull()
  })
})

describe('errori d’avvio', () => {
  it('un profilo che cita un campo assente dall’ontologia', () => {
    const dir = registryCopy()
    editJson<{ profiles: Record<string, { core_fields: string[] }> }>(
      dir,
      'class_extraction_profiles_v2.json',
      (data) => {
        data.profiles['accounting.fattura']!.core_fields.push('campo.inventato')
      }
    )
    expect(() => createExtractionRegistryV2(dir, REGISTRY_DIR)).toThrow(
      /1 riferimenti a campi assenti.*accounting\.fattura\.core_fields: campo\.inventato/
    )
  })

  it('una mappa legacy che punta a un campo inesistente', () => {
    const dir = registryCopy()
    editJson<{ map: Record<string, string> }>(dir, 'legacy_field_map_v2.json', (data) => {
      data.map.issue_date = 'document.data'
    })
    expect(() => createExtractionRegistryV2(dir, REGISTRY_DIR)).toThrow(
      /legacy_field_map_v2\.json: issue_date -> document\.data/
    )
  })

  it('un file dei profili mancante o rotto', () => {
    const missing = registryCopy()
    rmSync(join(missing, 'field_ontology_v2.json'))
    expect(() => createExtractionRegistryV2(missing, REGISTRY_DIR)).toThrow(
      /manca field_ontology_v2\.json/
    )

    const broken = registryCopy()
    writeFileSync(join(broken, 'extraction_hints_v2.json'), '{')
    expect(() => createExtractionRegistryV2(broken, REGISTRY_DIR)).toThrow(
      /extraction_hints_v2\.json non è JSON valido/
    )
  })

  it('senza gli schemi del registry v1', () => {
    const dir = registryCopy()
    expect(() => createExtractionRegistryV2(dir, dir)).toThrow(/manca extraction_schemas\.json/)
  })

  it('la mappa legacy si carica anche da sola', () => {
    expect(loadLegacyFieldMap(REGISTRY_V2_DIR)).toMatchObject({
      document_number: 'document.number'
    })
  })
})
