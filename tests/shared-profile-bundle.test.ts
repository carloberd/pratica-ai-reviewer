import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createExtractionRegistryV2 } from '../src/main/extract/v2/profile-loader'
import type { FieldOntologyEntry } from '../src/shared/extraction-v2'
import {
  buildProfileBundle,
  CHANGELOG_FILE,
  EXCLUDED_KEY,
  HINTS_FILE,
  type HintsFile,
  jsonSchemaFor,
  PROFILES_FILE,
  type ProfilesFile,
  REVIEWER_PROVENANCE,
  SCHEMAS_FILE,
  serializeRegistryJson
} from '../src/shared/profile-bundle'
import type { ProfileAction } from '../src/shared/profile-history'
import type { ProfileOverlay } from '../src/shared/profile-overlay'
import { REGISTRY_DIR, REGISTRY_V2_DIR } from './helpers/registry'

/**
 * I file che il revisore consegna a pratica-ai.
 *
 * Il controllo che conta è il primo: senza nessuna correzione, gli schemi rigenerati da
 * qui devono venire identici a `extraction_schemas_v2.generated.json` del programmer
 * pack, tutti e 500. Se il generatore sbaglia una forma — una data che non diventa
 * `format: date`, un campo `many` che non diventa un array — si vede lì, e non mesi dopo
 * dentro pratica-ai.
 */

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(REGISTRY_V2_DIR, name), 'utf8')) as T
}

const PROFILES = readJson<ProfilesFile>(PROFILES_FILE)
const HINTS = readJson<HintsFile>(HINTS_FILE)
const ONTOLOGY = readJson<{ fields: Record<string, FieldOntologyEntry> }>(
  'field_ontology_v2.json'
).fields
const GENERATED = readJson<Record<string, unknown>>('extraction_schemas_v2.generated.json')

const MANIFEST = {
  app: { name: 'praticaai-reviewer', version: '1.3.0' },
  schemaVersion: PROFILES.version,
  exportedAt: '2026-09-17T09:00:00.000Z'
}

const EMPTY: ProfileOverlay = { fields: {}, hintLabels: {}, cardinality: {} }

function bundle(overlay: ProfileOverlay, actions: ProfileAction[] = []) {
  const result = buildProfileBundle({
    manifest: MANIFEST,
    profiles: PROFILES,
    hints: HINTS,
    overlay,
    ontology: ONTOLOGY,
    actions
  })
  const file = (name: string) =>
    JSON.parse(result.files.find((f) => f.name === name)?.content ?? '')
  return { result, file }
}

function action(overrides: Partial<ProfileAction> = {}): ProfileAction {
  return {
    id: 'a1',
    at: '2026-09-17T08:00:00.000Z',
    kind: 'REMOVE_FIELD',
    documentType: 'accounting.fattura',
    fieldId: 'procurement.cig',
    label: null,
    before: 'conditional',
    after: 'excluded',
    previousOverride: null,
    detail: 'CIG segnato non utile per accounting.fattura.',
    reason: { documents: 2, confirmed: 0, corrected: 0, manual: 0 },
    revertsId: null,
    revertedAt: null,
    ...overrides
  }
}

describe('gli schemi JSON rigenerati', () => {
  it('senza correzioni sono identici a quelli del programmer pack, tutti e 500', () => {
    const schemas: Record<string, unknown> = {}
    for (const [documentType, profile] of Object.entries(PROFILES.profiles)) {
      schemas[documentType] = jsonSchemaFor(documentType, profile, ONTOLOGY).schema
    }

    expect(Object.keys(schemas)).toHaveLength(500)
    expect(schemas).toEqual(GENERATED)
  })

  it('un campo che l’ontologia non conosce resta fuori e viene elencato', () => {
    const profile = { ...PROFILES.profiles['accounting.fattura']! }
    profile.core_fields = [...profile.core_fields, 'campo.inventato']

    const { schema, unknownFields } = jsonSchemaFor('accounting.fattura', profile, ONTOLOGY)

    expect(unknownFields).toEqual(['campo.inventato'])
    expect(Object.keys(schema.properties as object)).not.toContain('campo.inventato')
  })

  it('la nota di credito non dichiara non negativi i suoi importi, la fattura sì', () => {
    const validators = (documentType: string) => {
      const { schema } = jsonSchemaFor(documentType, PROFILES.profiles[documentType]!, ONTOLOGY)
      const properties = schema.properties as Record<string, Record<string, unknown>>
      return (fieldId: string) => properties[fieldId]?.['x-praticaai-validators']
    }
    const note = validators('accounting.nota_di_credito')
    const invoice = validators('accounting.fattura')

    for (const fieldId of ['money.total', 'money.taxable', 'money.tax']) {
      expect(note(fieldId)).toEqual([])
      expect(invoice(fieldId)).toEqual(['non_negative_money'])
    }
  })
})

describe('il pacchetto della mappa corretta', () => {
  const overlay: ProfileOverlay = {
    fields: {
      'accounting.fattura': {
        'procurement.cig': 'excluded',
        'document.title': 'core',
        'issuer.tax_id': 'required'
      }
    },
    hintLabels: { 'issuer.tax_id': ['Partita IVA'] },
    cardinality: {}
  }

  it('scrive quattro file e conta cosa è cambiato', () => {
    const { result } = bundle(overlay, [action()])

    expect(result.files.map((file) => file.name)).toEqual([
      PROFILES_FILE,
      HINTS_FILE,
      SCHEMAS_FILE,
      CHANGELOG_FILE
    ])
    expect(result.types).toBe(1)
    expect(result.fields).toBe(3)
    expect(result.edits).toBe(1)
  })

  it('il profilo corretto porta le decisioni, e il campo scartato resta scritto', () => {
    const { file } = bundle(overlay)
    const profile = file(PROFILES_FILE).profiles['accounting.fattura']

    expect(profile.conditional_fields).not.toContain('procurement.cig')
    expect(profile[EXCLUDED_KEY]).toEqual(['procurement.cig'])
    expect(profile.core_fields).toContain('document.title')
    expect(profile.required_fields).toContain('issuer.tax_id')
    expect(profile.field_provenance['document.title']).toBe(REVIEWER_PROVENANCE)
    expect(profile.field_provenance['issuer.tax_id']).toBe(REVIEWER_PROVENANCE)
    // Il campo scartato non ha più una provenienza: non è più nella mappa.
    expect(profile.field_provenance['procurement.cig']).toBeUndefined()
  })

  it('gli altri 499 profili restano quelli del registry, byte per byte', () => {
    const { file } = bundle(overlay)
    const profiles = file(PROFILES_FILE).profiles

    expect(profiles['accounting.autofattura']).toEqual(PROFILES.profiles['accounting.autofattura'])
    expect(Object.keys(profiles)).toHaveLength(500)
  })

  it('le etichette insegnate si sommano a quelle del registry', () => {
    const { file } = bundle(overlay)
    const labels = file(HINTS_FILE).hints['issuer.tax_id'].labels
    const registryLabels = HINTS.hints['issuer.tax_id']!.labels

    expect(labels).toContain('Partita IVA')
    expect(labels.slice(0, registryLabels.length)).toEqual(registryLabels)
  })

  it('gli schemi seguono la mappa corretta', () => {
    const { file } = bundle(overlay)
    const schema = file(SCHEMAS_FILE)['accounting.fattura']

    expect(Object.keys(schema.properties)).toContain('document.title')
    expect(Object.keys(schema.properties)).not.toContain('procurement.cig')
    expect(schema.required).toContain('issuer.tax_id')
  })

  it('il changelog dice cosa è cambiato e con che numeri', () => {
    const { file } = bundle(overlay, [
      action(),
      action({ id: 'a2', revertedAt: '2026-09-17T10:00:00.000Z' })
    ])
    const changelog = file(CHANGELOG_FILE)

    expect(changelog.manifest.counts).toEqual({
      types: 1,
      fields: 3,
      actions: 2,
      standingEdits: 1
    })
    expect(changelog.changes[0].excluded).toEqual(['procurement.cig'])
    expect(changelog.changes[0].added).toEqual([{ fieldId: 'document.title', role: 'core' }])
    expect(changelog.changes[0].rerolled).toEqual([
      { fieldId: 'issuer.tax_id', from: 'core', to: 'required' }
    ])
    // Anche l'azione annullata resta: la cronologia non si riscrive.
    expect(changelog.actions).toHaveLength(2)
    expect(changelog.actions[0].standing).toBe(true)
    expect(changelog.actions[1].standing).toBe(false)
    expect(changelog.actions[0].reason.documents).toBe(2)
  })

  it('un campo con più valori esce come array nello schema, e il changelog lo dice', () => {
    const { file, result } = bundle(
      { ...EMPTY, cardinality: { 'accounting.fattura': { 'bank.iban': 'many' } } },
      [
        action({
          kind: 'SET_CARDINALITY',
          fieldId: 'bank.iban',
          before: 'one',
          after: 'many'
        })
      ]
    )

    const schema = file(SCHEMAS_FILE)['accounting.fattura']
    expect(schema.properties['bank.iban'].type).toBe('array')
    expect(schema.properties['bank.iban'].items).toEqual({ type: 'string' })
    expect(schema.properties['document.number'].type).toBe('string')

    const profile = file(PROFILES_FILE).profiles['accounting.fattura']
    expect(profile.field_cardinality).toEqual({ 'bank.iban': 'many' })
    // La mappa dei campi non cambia: cambia solo quanti valori chiede uno di loro.
    expect(profile.conditional_fields).toEqual(
      PROFILES.profiles['accounting.fattura']!.conditional_fields
    )
    // Gli altri tipi restano quelli dell'ontologia.
    expect(file(SCHEMAS_FILE)['accounting.autofattura']).toEqual(
      GENERATED['accounting.autofattura']
    )

    expect(result).toMatchObject({ types: 1, fields: 1, edits: 1 })
    expect(file(CHANGELOG_FILE).changes[0].cardinality).toEqual([
      { fieldId: 'bank.iban', from: 'one', to: 'many' }
    ])
  })

  it('un importo della nota di credito segnato non utile porta via anche la sua eccezione', () => {
    const { file } = bundle({
      ...EMPTY,
      fields: { 'accounting.nota_di_credito': { 'money.tax': 'excluded' } }
    })
    const profile = file(PROFILES_FILE).profiles['accounting.nota_di_credito']

    // Un'eccezione su un campo fuori profilo farebbe rifiutare il file al loader.
    expect(profile.field_validator_overrides).toEqual({ 'money.total': [], 'money.taxable': [] })

    const dir = mkdtempSync(join(tmpdir(), 'bundle-'))
    try {
      cpSync(REGISTRY_V2_DIR, dir, { recursive: true })
      writeFileSync(join(dir, PROFILES_FILE), serializeRegistryJson(file(PROFILES_FILE)))
      const reloaded = createExtractionRegistryV2(dir, REGISTRY_DIR)
      expect(reloaded.profile('accounting.nota_di_credito')?.optional_fields).toEqual([
        'money.taxable'
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('le altre decisioni sulla nota di credito lasciano le eccezioni com’erano', () => {
    const { file } = bundle({
      ...EMPTY,
      fields: { 'accounting.nota_di_credito': { 'money.taxable': 'core' } }
    })
    const profile = file(PROFILES_FILE).profiles['accounting.nota_di_credito']

    expect(profile.field_validator_overrides).toEqual(
      PROFILES.profiles['accounting.nota_di_credito']!.field_validator_overrides
    )
    expect(file(SCHEMAS_FILE)['accounting.nota_di_credito'].properties['money.taxable']).toEqual(
      expect.objectContaining({ 'x-praticaai-validators': [] })
    )
  })

  it('due export di fila danno gli stessi byte', () => {
    const first = bundle(overlay, [action()]).result
    const second = bundle(overlay, [action()]).result

    expect(second.files).toEqual(first.files)
  })

  it('senza correzioni i due file del registry escono identici a com’erano', () => {
    const { file } = bundle(EMPTY)

    expect(file(PROFILES_FILE)).toEqual(PROFILES)
    expect(file(HINTS_FILE)).toEqual(HINTS)
  })
})
