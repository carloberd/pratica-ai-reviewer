import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createExtractionRegistry } from '../src/main/extract/v2/profile-loader'
import type { FieldOntologyEntry } from '../src/shared/extraction-v2'
import {
  buildProfileBundle,
  CHANGELOG_FILE,
  DOCUMENT_FIELDS_FILE,
  type DocumentFieldsFile,
  EXCLUDED_KEY,
  FIELDS_FILE,
  type FieldsFile,
  jsonSchemaFor,
  REVIEWER_PROVENANCE,
  SCHEMAS_FILE,
  serializeRegistryJson
} from '../src/shared/profile-bundle'
import type { ProfileAction } from '../src/shared/profile-history'
import type { ProfileOverlay } from '../src/shared/profile-overlay'
import { REGISTRY_DIR } from './helpers/registry'

/**
 * I file che il revisore consegna a pratica-ai.
 *
 * Il controllo che conta è il primo: senza nessuna correzione, gli schemi rigenerati da
 * qui devono avere la forma che l'ontologia dichiara per ognuno dei 171 tipi. Se il
 * generatore sbaglia una forma — una data che non diventa `format: date`, un campo `many`
 * che non diventa un array — si vede lì, e non mesi dopo dentro pratica-ai.
 */

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(REGISTRY_DIR, name), 'utf8')) as T
}

const MAP = readJson<DocumentFieldsFile>(DOCUMENT_FIELDS_FILE)
const CATALOG = readJson<FieldsFile>(FIELDS_FILE)
const ONTOLOGY = CATALOG.fields as Record<string, FieldOntologyEntry>
const TYPES = Object.keys(MAP.document_types).length

const MANIFEST = {
  app: { name: 'praticaai-reviewer', version: '1.3.0' },
  schemaVersion: MAP.version,
  exportedAt: '2026-09-17T09:00:00.000Z'
}

const EMPTY: ProfileOverlay = { fields: {}, hintLabels: {}, cardinality: {} }

function bundle(overlay: ProfileOverlay, actions: ProfileAction[] = []) {
  const result = buildProfileBundle({
    manifest: MANIFEST,
    catalog: CATALOG,
    map: MAP,
    overlay,
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
    before: 'optional',
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
  it('coprono tutti i tipi, con la forma che l’ontologia dichiara', () => {
    const shapeOf = (fieldId: string) => {
      const field = ONTOLOGY[fieldId]!
      const scalar =
        field.type === 'date'
          ? { type: 'string', format: 'date' }
          : field.type === 'money' || field.type === 'number'
            ? { type: 'number' }
            : field.type === 'integer'
              ? { type: 'integer' }
              : field.type === 'boolean'
                ? { type: 'boolean' }
                : field.type === 'object'
                  ? { type: 'object', additionalProperties: true }
                  : { type: 'string' }
      return field.default_cardinality === 'many' ? { type: 'array', items: scalar } : scalar
    }

    let checked = 0
    for (const [documentType, profile] of Object.entries(MAP.document_types)) {
      const { schema, unknownFields } = jsonSchemaFor(documentType, profile, ONTOLOGY)
      expect(unknownFields, documentType).toEqual([])
      const properties = schema.properties as Record<string, Record<string, unknown>>
      expect(Object.keys(properties).sort(), documentType).toEqual(
        [...profile.required_fields, ...profile.optional_fields].sort()
      )
      expect(schema.required, documentType).toEqual(profile.required_fields)
      for (const [fieldId, property] of Object.entries(properties)) {
        expect(property, `${documentType} ${fieldId}`).toMatchObject(shapeOf(fieldId))
        checked += 1
      }
    }

    expect(Object.keys(MAP.document_types)).toHaveLength(TYPES)
    expect(checked).toBeGreaterThan(1000)
  })

  it('un campo che l’ontologia non conosce resta fuori e viene elencato', () => {
    const profile = { ...MAP.document_types['accounting.fattura']! }
    profile.optional_fields = [...profile.optional_fields, 'campo.inventato']

    const { schema, unknownFields } = jsonSchemaFor('accounting.fattura', profile, ONTOLOGY)

    expect(unknownFields).toEqual(['campo.inventato'])
    expect(Object.keys(schema.properties as object)).not.toContain('campo.inventato')
  })

  it('la nota di credito non dichiara non negativi i suoi importi, la fattura sì', () => {
    const validators = (documentType: string) => {
      const { schema } = jsonSchemaFor(documentType, MAP.document_types[documentType]!, ONTOLOGY)
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
        'document.title': 'optional',
        'money.taxable': 'required'
      }
    },
    hintLabels: { 'issuer.vat_number': ['Identificativo fiscale ai fini IVA'] },
    cardinality: {}
  }

  it('scrive quattro file e conta cosa è cambiato', () => {
    const { result } = bundle(overlay, [action()])

    expect(result.files.map((file) => file.name)).toEqual([
      FIELDS_FILE,
      DOCUMENT_FIELDS_FILE,
      SCHEMAS_FILE,
      CHANGELOG_FILE
    ])
    expect(result.types).toBe(1)
    expect(result.fields).toBe(3)
    expect(result.edits).toBe(1)
  })

  it('il profilo corretto porta le decisioni, e il campo scartato resta scritto', () => {
    const { file } = bundle(overlay)
    const profile = file(DOCUMENT_FIELDS_FILE).document_types['accounting.fattura']

    expect(profile.optional_fields).not.toContain('procurement.cig')
    expect(profile[EXCLUDED_KEY]).toEqual(['procurement.cig'])
    expect(profile.optional_fields).toContain('document.title')
    expect(profile.required_fields).toContain('money.taxable')
    expect(profile.field_provenance['document.title']).toBe(REVIEWER_PROVENANCE)
    expect(profile.field_provenance['money.taxable']).toBe(REVIEWER_PROVENANCE)
    // Il campo scartato non ha più una provenienza: non è più nella mappa.
    expect(profile.field_provenance['procurement.cig']).toBeUndefined()
  })

  it('gli altri tipi restano quelli del registry, byte per byte', () => {
    const { file } = bundle(overlay)
    const documentTypes = file(DOCUMENT_FIELDS_FILE).document_types

    expect(documentTypes['accounting.autofattura']).toEqual(
      MAP.document_types['accounting.autofattura']
    )
    expect(Object.keys(documentTypes)).toHaveLength(TYPES)
  })

  it('le etichette insegnate si sommano agli alias del registry', () => {
    const { file } = bundle(overlay)
    const aliases = file(FIELDS_FILE).fields['issuer.vat_number'].label_aliases_it
    const fromRegistry = CATALOG.fields['issuer.vat_number']!.label_aliases_it

    expect(aliases).toContain('Identificativo fiscale ai fini IVA')
    expect(aliases.slice(0, fromRegistry.length)).toEqual(fromRegistry)
  })

  it('gli schemi seguono la mappa corretta', () => {
    const { file } = bundle(overlay)
    const schema = file(SCHEMAS_FILE)['accounting.fattura']

    expect(Object.keys(schema.properties)).toContain('document.title')
    expect(Object.keys(schema.properties)).not.toContain('procurement.cig')
    expect(schema.required).toContain('money.taxable')
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
    expect(changelog.changes[0].added).toEqual([{ fieldId: 'document.title', role: 'optional' }])
    expect(changelog.changes[0].rerolled).toEqual([
      { fieldId: 'money.taxable', from: 'optional', to: 'required' }
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

    const profile = file(DOCUMENT_FIELDS_FILE).document_types['accounting.fattura']
    expect(profile.field_cardinality).toEqual({ 'bank.iban': 'many' })
    // La mappa dei campi non cambia: cambia solo quanti valori chiede uno di loro.
    expect(profile.optional_fields).toEqual(
      MAP.document_types['accounting.fattura']!.optional_fields
    )
    // Gli altri tipi restano quelli dell'ontologia: l'IBAN lì resta un valore solo.
    expect(file(SCHEMAS_FILE)['accounting.autofattura'].properties['bank.iban'].type).toBe('string')

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
    const profile = file(DOCUMENT_FIELDS_FILE).document_types['accounting.nota_di_credito']

    // Un'eccezione su un campo fuori profilo farebbe rifiutare il file al loader.
    expect(profile.field_validator_overrides).toEqual({ 'money.total': [], 'money.taxable': [] })

    const dir = mkdtempSync(join(tmpdir(), 'bundle-'))
    try {
      cpSync(REGISTRY_DIR, dir, { recursive: true })
      writeFileSync(
        join(dir, DOCUMENT_FIELDS_FILE),
        serializeRegistryJson(file(DOCUMENT_FIELDS_FILE))
      )
      const reloaded = createExtractionRegistry(dir)
      const optional = reloaded.profile('accounting.nota_di_credito')!.optional_fields
      expect(optional).toContain('money.taxable')
      expect(optional).not.toContain('money.tax')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('le altre decisioni sulla nota di credito lasciano le eccezioni com’erano', () => {
    const { file } = bundle({
      ...EMPTY,
      fields: { 'accounting.nota_di_credito': { 'money.taxable': 'optional' } }
    })
    const profile = file(DOCUMENT_FIELDS_FILE).document_types['accounting.nota_di_credito']

    expect(profile.field_validator_overrides).toEqual(
      MAP.document_types['accounting.nota_di_credito']!.field_validator_overrides
    )
    expect(file(SCHEMAS_FILE)['accounting.nota_di_credito'].properties['money.taxable']).toEqual(
      expect.objectContaining({ 'x-praticaai-validators': [] })
    )
  })

  it('numero e date di un documento d’identità escono sensitive, sulla fattura no', () => {
    const { file } = bundle(EMPTY)
    const pii = (documentType: string, fieldId: string) =>
      file(SCHEMAS_FILE)[documentType].properties[fieldId]['x-praticaai-pii']
    // Sui quattro tipi le chiavi generiche prendono il posto di `identity.*`, che erano
    // `sensitive`: il profilo lo dice al posto dell'ontologia, che per `document.*` dice `none`.
    for (const documentType of [
      'identity_personal.carta_identita',
      'identity_personal.permesso_di_soggiorno',
      'identity_personal.patente_di_guida'
    ]) {
      for (const fieldId of ['document.number', 'document.issue_date', 'document.expiry_date']) {
        expect(pii(documentType, fieldId), `${documentType} ${fieldId}`).toBe('sensitive')
      }
      expect(pii(documentType, 'person.last_name')).toBe('personal')
    }
    expect(ONTOLOGY['document.number']!.pii).toBe('none')
    expect(pii('accounting.fattura', 'document.number')).toBe('none')
    expect(pii('accounting.fattura', 'document.issue_date')).toBe('none')
  })

  it('un campo d’identità segnato non utile porta via anche il suo pii', () => {
    const { file } = bundle({
      ...EMPTY,
      fields: { 'identity_personal.carta_identita': { 'document.number': 'excluded' } }
    })
    const profile = file(DOCUMENT_FIELDS_FILE).document_types['identity_personal.carta_identita']
    // Un'eccezione su un campo fuori profilo farebbe rifiutare il file al loader.
    expect(profile.field_pii_overrides).toEqual({
      'document.issue_date': 'sensitive',
      'document.expiry_date': 'sensitive'
    })
    // Un'altra decisione la lascia com'è.
    const other = bundle({
      ...EMPTY,
      fields: { 'identity_personal.carta_identita': { 'person.address': 'optional' } }
    }).file(DOCUMENT_FIELDS_FILE).document_types['identity_personal.carta_identita']
    expect(other.field_pii_overrides).toEqual(
      MAP.document_types['identity_personal.carta_identita']!.field_pii_overrides
    )
  })

  it('l’IBAN del bonifico segnato non utile porta via anche la sua descrizione', () => {
    const { file } = bundle({
      ...EMPTY,
      fields: { 'banking.ricevuta_bonifico': { 'bank.iban': 'excluded' } }
    })
    const profile = file(DOCUMENT_FIELDS_FILE).document_types['banking.ricevuta_bonifico']
    // Un'eccezione su un campo fuori profilo farebbe rifiutare il file al loader.
    expect(profile.field_description_overrides).toBeUndefined()

    // Un'altra decisione la lascia com'è.
    const other = bundle({
      ...EMPTY,
      fields: { 'banking.ricevuta_bonifico': { 'payment.value_date': 'optional' } }
    }).file(DOCUMENT_FIELDS_FILE).document_types['banking.ricevuta_bonifico']
    expect(other.field_description_overrides).toEqual(
      MAP.document_types['banking.ricevuta_bonifico']!.field_description_overrides
    )
  })

  it('la visura esce coi campi nuovi, e il ripiego del revisore resta finché non lo toglie', () => {
    // Un ripiego del revisore: la controparte aggiunta a mano sulla visura, accanto ai
    // campi che il registry ci mette già.
    const { file, result } = bundle({
      ...EMPTY,
      fields: {
        'corporate_registry.visura_camerale': {
          'counterparty.tax_id': 'optional',
          'recipient.name': 'excluded',
          'document.number': 'excluded'
        }
      }
    })
    const profile = file(DOCUMENT_FIELDS_FILE).document_types['corporate_registry.visura_camerale']
    const schema = file(SCHEMAS_FILE)['corporate_registry.visura_camerale']

    // I campi del registry arrivano anche nella mappa corretta, e il ripiego accanto:
    // l'overlay si somma al profilo, non sa che un campo ne sostituisce un altro.
    expect(profile.required_fields).toEqual(
      expect.arrayContaining(['company.vat_number', 'company.tax_code', 'company.rea_number'])
    )
    expect(profile.optional_fields).toContain('counterparty.tax_id')
    expect(profile.optional_fields).not.toContain('company.tax_id')
    expect(schema.properties['company.vat_number']).toEqual({
      type: 'string',
      'x-praticaai-evidence-required': true,
      'x-praticaai-pii': 'none',
      'x-praticaai-validators': ['vat_number_format']
    })
    expect(schema.properties['company.tax_code']['x-praticaai-validators']).toEqual([
      'italian_tax_code_format'
    ])
    expect(schema.properties['company.rea_number']['x-praticaai-validators']).toEqual([])
    expect(file(CHANGELOG_FILE).fieldsWithoutOntology).toEqual({})
    expect(file(CHANGELOG_FILE).changes[0].added).toEqual([
      { fieldId: 'counterparty.tax_id', role: 'optional' }
    ])
    expect(result.types).toBe(1)
  })

  it('due export di fila danno gli stessi byte', () => {
    const first = bundle(overlay, [action()]).result
    const second = bundle(overlay, [action()]).result

    expect(second.files).toEqual(first.files)
  })

  it('senza correzioni i due file del registry escono identici a com’erano', () => {
    const { file } = bundle(EMPTY)

    expect(file(DOCUMENT_FIELDS_FILE)).toEqual(MAP)
    expect(file(FIELDS_FILE)).toEqual(CATALOG)
  })
})
