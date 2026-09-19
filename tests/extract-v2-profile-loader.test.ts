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
    expect(registry.schemaVersion()).toBe('2.0.3')
  })

  it('legge le eccezioni ai validatori solo sul tipo che le dichiara', () => {
    expect(registry.profile('accounting.nota_di_credito')?.field_validator_overrides).toEqual({
      'money.total': [],
      'money.taxable': [],
      'money.tax': []
    })
    expect(registry.profile('accounting.fattura')?.field_validator_overrides).toBeUndefined()
    // L'ontologia non cambia: vale per tutti gli altri tipi.
    expect(registry.field('money.total')?.validators).toEqual(['non_negative_money'])
  })

  it('le correzioni del revisore non perdono le eccezioni ai validatori', () => {
    const corrected = createExtractionRegistryV2(REGISTRY_V2_DIR, REGISTRY_DIR, () => ({
      fields: { 'accounting.nota_di_credito': { 'money.total': 'required' } },
      hintLabels: {},
      cardinality: { 'accounting.nota_di_credito': { 'money.total': 'many' } }
    }))
    const profile = corrected.profile('accounting.nota_di_credito')!
    expect(profile.required_fields).toContain('money.total')
    expect(profile.field_validator_overrides?.['money.total']).toEqual([])
  })

  it('fattura e visura chiedono partita IVA e codice fiscale distinti, gli altri tipi no', () => {
    const fields = (type: string) => {
      const profile = registry.profile(type)!
      return [...profile.required_fields, ...profile.core_fields, ...profile.optional_fields]
    }
    expect(fields('accounting.fattura')).toEqual(
      expect.arrayContaining([
        'issuer.vat_number',
        'issuer.tax_code',
        'recipient.vat_number',
        'recipient.tax_code'
      ])
    )
    expect(fields('accounting.fattura')).not.toContain('issuer.tax_id')
    const visura = fields('corporate_registry.visura_camerale')
    expect(visura).toEqual(
      expect.arrayContaining(['company.vat_number', 'company.tax_code', 'company.rea_number'])
    )
    expect(visura).not.toContain('company.tax_id')
    expect(visura).not.toContain('company.registration_number')
    // `*.tax_id` resta col suo significato dove c'era.
    expect(fields('accounting.nota_di_credito')).toContain('issuer.tax_id')
    expect(fields('payroll_contributions.durc')).toContain('company.tax_id')
  })

  it('la mappa del revisore si somma al profilo nuovo: il ripiego resta finché non lo toglie', () => {
    // La mappa della visura il 18/09: il codice fiscale in `recipient.tax_id`, e un campo
    // uscito dal registry a cui il revisore avesse cambiato il peso.
    const corrected = createExtractionRegistryV2(REGISTRY_V2_DIR, REGISTRY_DIR, () => ({
      fields: {
        'corporate_registry.visura_camerale': {
          'recipient.tax_id': 'core',
          'recipient.name': 'excluded',
          'company.registration_number': 'optional'
        }
      },
      hintLabels: {},
      cardinality: {}
    }))
    const profile = corrected.profile('corporate_registry.visura_camerale')!
    expect(profile.core_fields).toEqual(
      expect.arrayContaining(['company.tax_code', 'company.vat_number', 'recipient.tax_id'])
    )
    expect(profile.core_fields).not.toContain('recipient.name')
    // Una decisione su un campo che il registry non chiede più lo rimette nel profilo.
    expect(profile.optional_fields).toContain('company.registration_number')
  })

  it('i documenti d’identità chiedono cognome e nome distinti, e le chiavi generiche', () => {
    const roles = (type: string) => {
      const profile = registry.profile(type)!
      return {
        required: profile.required_fields,
        core: profile.core_fields,
        optional: profile.optional_fields
      }
    }
    const required = [
      'person.last_name',
      'person.first_name',
      'document.number',
      'document.issue_date',
      'document.expiry_date'
    ]
    const core = [
      'identity.document_type',
      'person.tax_code',
      'person.birth_date',
      'person.birth_place'
    ]
    // Carta e permesso: anche cittadinanza e residenza, come nella mappa della carta.
    for (const type of [
      'identity_personal.carta_identita',
      'identity_personal.permesso_di_soggiorno'
    ]) {
      expect(roles(type), type).toEqual({
        required: [...required, 'identity.nationality'],
        core: [...core, 'person.address'],
        optional: ['identity.issuing_authority']
      })
    }
    // Il passaporto scrive sempre la cittadinanza, la residenza non sempre.
    expect(roles('identity_personal.passaporto')).toEqual({
      required: [...required, 'identity.nationality'],
      core,
      optional: ['identity.issuing_authority', 'person.address']
    })
    // La patente europea non stampa né cittadinanza né residenza.
    expect(roles('identity_personal.patente_di_guida')).toEqual({
      required,
      core,
      optional: ['identity.issuing_authority']
    })

    expect(registry.field('person.last_name')).toMatchObject({
      label_it: 'Cognome',
      pii: 'personal'
    })
    expect(registry.field('person.first_name')).toMatchObject({ label_it: 'Nome', pii: 'personal' })
    // `person.name` resta dove una persona compare per intero.
    expect(registry.field('person.name')?.label_it).toBe('Nome e cognome')
    expect(registry.profile('real_estate.contratto_locazione')!.core_fields).toContain(
      'person.name'
    )
    // Le date di `identity.*` restano su certificati e stato di famiglia, ora con un
    // validatore: «COMUNE DI ROVIGO» in una scadenza non passa più in silenzio.
    expect(registry.profile('identity_personal.certificato_nascita')!.core_fields).toEqual(
      expect.arrayContaining(['identity.issue_date', 'identity.expiry_date'])
    )
    expect(registry.field('identity.issue_date')?.validators).toEqual(['valid_date'])
    expect(registry.field('identity.expiry_date')?.validators).toEqual(['valid_date'])
  })

  it('la mappa del revisore sui documenti d’identità, dopo il cambio: cosa rientra', () => {
    // Le decisioni del 18/09 che l'export fa vedere, confrontate col registry di allora.
    const corrected = createExtractionRegistryV2(REGISTRY_V2_DIR, REGISTRY_DIR, () => ({
      fields: {
        'identity_personal.carta_identita': {
          'identity.nationality': 'required',
          'person.address': 'core',
          'identity.document_type': 'excluded',
          'identity.document_number': 'excluded',
          'identity.issue_date': 'excluded',
          'issuer.name': 'excluded',
          'recipient.name': 'excluded',
          'document.number': 'required',
          'document.issue_date': 'required',
          'person.name': 'required',
          'person.birth_date': 'required',
          'person.birth_place': 'required',
          'identity.expiry_date': 'required'
        },
        'identity_personal.permesso_di_soggiorno': {
          'document.number': 'required',
          'identity.expiry_date': 'required',
          'person.name': 'required',
          'person.birth_date': 'required',
          'person.birth_place': 'required',
          'identity.document_number': 'optional',
          'document.issue_date': 'excluded',
          'issuer.name': 'excluded',
          'recipient.name': 'excluded'
        }
      },
      hintLabels: {},
      cardinality: {}
    }))
    const fields = (type: string) => {
      const profile = corrected.profile(type)!
      return [...profile.required_fields, ...profile.core_fields, ...profile.optional_fields]
    }

    const carta = corrected.profile('identity_personal.carta_identita')!
    // Le decisioni su campi usciti dal registry li rimettono nel profilo, col loro peso:
    // accanto a cognome e nome torna `person.name`, accanto alla scadenza generica quella
    // di `identity.*`. Finché il revisore non le ripristina, il motore cerca tutte e due.
    expect(carta.required_fields).toEqual(
      expect.arrayContaining([
        'person.last_name',
        'person.first_name',
        'person.name',
        'document.expiry_date',
        'identity.expiry_date'
      ])
    )
    // Le esclusioni su campi usciti non rimettono niente; quella sul tipo di documento,
    // che il registry tiene, resta la decisione del revisore.
    expect(fields('identity_personal.carta_identita')).not.toContain('identity.document_type')
    expect(fields('identity_personal.carta_identita')).not.toContain('identity.issue_date')

    const permesso = corrected.profile('identity_personal.permesso_di_soggiorno')!
    expect(permesso.required_fields).toEqual(
      expect.arrayContaining(['person.name', 'identity.expiry_date'])
    )
    expect(permesso.optional_fields).toContain('identity.document_number')
    // Il permesso resta senza data di rilascio: `document.issue_date` è esclusa dalla mappa,
    // e `identity.issue_date`, che il revisore usava al suo posto, esce dal registry.
    expect(fields('identity_personal.permesso_di_soggiorno')).not.toContain('document.issue_date')
    expect(fields('identity_personal.permesso_di_soggiorno')).not.toContain('identity.issue_date')
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

  it.each([
    ['un campo fuori dal profilo del tipo', 'finance.balance_closing'],
    ['un campo assente dall’ontologia', 'campo.inventato']
  ])('un’eccezione ai validatori su %s', (_, fieldId) => {
    const dir = registryCopy()
    editJson<{
      profiles: Record<string, { field_validator_overrides?: Record<string, string[]> }>
    }>(dir, 'class_extraction_profiles_v2.json', (data) => {
      data.profiles['accounting.fattura']!.field_validator_overrides = { [fieldId]: [] }
    })
    expect(() => createExtractionRegistryV2(dir, REGISTRY_DIR)).toThrow(
      `accounting.fattura.field_validator_overrides: ${fieldId}`
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
