import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createExtractionRegistry } from '../src/main/extract/v2/profile-loader'
import { descriptionOf, piiOf } from '../src/shared/extraction-v2'
import { REGISTRY_DIR, testExtractionRegistry } from './helpers/registry'

const registry = testExtractionRegistry()

const dirs: string[] = []

/** Copia del registry reale da modificare in un test. */
function registryCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'registry-'))
  dirs.push(dir)
  cpSync(REGISTRY_DIR, dir, { recursive: true })
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
  it('restituisce la mappa del tipo con i suoi due ruoli', () => {
    expect(registry.profileSource('accounting.fattura')).toBe('EXPLICIT')
    const profile = registry.profile('accounting.fattura')!
    expect(profile.schema_state).toBe('PRETESTED')
    expect(profile.required_fields).toEqual(
      expect.arrayContaining([
        'document.number',
        'document.issue_date',
        'issuer.name',
        'recipient.name',
        'money.total'
      ])
    )
    expect(profile.optional_fields).toContain('line_items')
    // I due ruoli non si sovrappongono: un campo obbligatorio non è anche opzionale.
    for (const fieldId of profile.required_fields) {
      expect(profile.optional_fields, fieldId).not.toContain(fieldId)
    }
  })

  it('espone ontologia, hint e versione dei profili', () => {
    expect(registry.field('line_items')).toMatchObject({
      type: 'object',
      default_cardinality: 'many'
    })
    expect(registry.field('non.esiste')).toBeNull()
    expect(registry.hints('money.total')).toContain('totale documento')
    // L'etichetta del campo apre sempre la lista: gli alias vengono dopo.
    expect(registry.hints('money.total')[0]).toBe('Totale')
    expect(registry.hints('non.esiste')).toEqual([])
    expect(registry.schemaVersion()).toBe('3.0.0')
  })

  it('la descrizione di un campo su un tipo la scrive il profilo, non l’ontologia', () => {
    const bonifico = registry.profile('banking.ricevuta_bonifico')!
    expect(descriptionOf(bonifico, 'bank.iban', registry.field('bank.iban'))).toBe(
      'IBAN del beneficiario, non il conto da cui parte il bonifico.'
    )
    // Adesso la descrizione dell'ontologia dice già qualcosa: l'eccezione del tipo la
    // precisa, non la sostituisce a un campo muto.
    expect(registry.field('bank.iban')?.description).not.toBe('IBAN')
    // Senza eccezione si legge la descrizione dell'ontologia, che adesso c'è su tutti.
    expect(descriptionOf(bonifico, 'document.number', registry.field('document.number'))).toBe(
      registry.field('document.number')!.description
    )
    expect(
      descriptionOf(
        registry.profile('accounting.fattura'),
        'bank.iban',
        registry.field('bank.iban')
      )
    ).toBe(registry.field('bank.iban')!.description)
    // Nessuna descrizione ripete la sua etichetta: nel template sarebbe un'istruzione vuota.
    for (const field of registry.allFields()) {
      expect(field.description, field.id).not.toBe(field.label_it)
    }
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
    const corrected = createExtractionRegistry(REGISTRY_DIR, () => ({
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
      return [...profile.required_fields, ...profile.optional_fields, ...profile.optional_fields]
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
    // La distinzione vale ovunque adesso, non solo sui due tipi del pilota: `*.tax_id` è
    // uscito dall'ontologia e nessun tipo lo chiede più.
    expect(fields('accounting.nota_di_credito')).toEqual(
      expect.arrayContaining(['issuer.vat_number', 'issuer.tax_code'])
    )
    expect(fields('payroll_contributions.durc')).toEqual(
      expect.arrayContaining(['company.vat_number', 'company.tax_code'])
    )
    expect(registry.field('issuer.tax_id')).toBeNull()
    expect(registry.field('company.tax_id')).toBeNull()
  })

  it('la mappa del revisore si somma al profilo nuovo: il ripiego resta finché non lo toglie', () => {
    // Un ripiego del revisore sulla visura, e un campo del registry a cui ha cambiato peso.
    const corrected = createExtractionRegistry(REGISTRY_DIR, () => ({
      fields: {
        'corporate_registry.visura_camerale': {
          'counterparty.tax_id': 'optional',
          'recipient.name': 'excluded',
          'company.tax_code': 'optional'
        }
      },
      hintLabels: {},
      cardinality: {}
    }))
    const profile = corrected.profile('corporate_registry.visura_camerale')!
    expect(profile.optional_fields).toEqual(
      expect.arrayContaining(['company.tax_code', 'counterparty.tax_id'])
    )
    expect(profile.optional_fields).not.toContain('recipient.name')
    // Il campo ripesato esce dagli obbligatori e non resta in tutte e due le liste.
    expect(profile.required_fields).not.toContain('company.tax_code')
  })

  it('i documenti d’identità chiedono cognome e nome distinti, e le chiavi generiche', () => {
    const profileOf = (type: string) => registry.profile(type)!
    // Le chiavi generiche hanno preso il posto di `identity.document_number`,
    // `identity.issue_date` e `identity.expiry_date`: sono quelle che il pilota ha messo.
    const required = [
      'person.last_name',
      'person.first_name',
      'document.number',
      'document.issue_date',
      'document.expiry_date',
      'person.birth_date',
      'person.birth_place',
      'identity.document_type'
    ]
    for (const type of [
      'identity_personal.carta_identita',
      'identity_personal.permesso_di_soggiorno',
      'identity_personal.patente_di_guida'
    ]) {
      const profile = profileOf(type)
      expect(profile.required_fields, type).toEqual(expect.arrayContaining(required))
      for (const gone of [
        'identity.document_number',
        'identity.issue_date',
        'identity.expiry_date',
        'identity.residence',
        'person.name'
      ]) {
        expect(
          [...profile.required_fields, ...profile.optional_fields],
          `${type} ${gone}`
        ).not.toContain(gone)
      }
      // La residenza resta un campo da confermare, non da dare per letto.
      expect(profile.optional_fields, type).toContain('person.address')
    }
    // Il permesso ha in più il motivo del soggiorno; la patente le sue categorie.
    expect(profileOf('identity_personal.permesso_di_soggiorno').required_fields).toContain(
      'identity.permit_type'
    )
    expect(profileOf('identity_personal.patente_di_guida').optional_fields).toContain(
      'identity.categories'
    )
    // Il passaporto è fuori dalle 171 del Brain MVP: non ha più una mappa.
    expect(registry.profile('identity_personal.passaporto')).toBeNull()

    expect(registry.field('person.last_name')).toMatchObject({
      label_it: 'Cognome',
      pii: 'personal'
    })
    expect(registry.field('person.first_name')).toMatchObject({ label_it: 'Nome', pii: 'personal' })
    // `person.name` resta dove una persona compare per intero.
    expect(registry.field('person.name')?.label_it).toBe('Nome e cognome')
    expect(registry.profile('real_estate.contratto_locazione')!.optional_fields).toContain(
      'person.name'
    )
    // Le chiavi `identity.*` che le generiche hanno sostituito sono uscite dall'ontologia:
    // tenerle avrebbe lasciato due modi di dire la stessa cosa.
    expect(registry.field('identity.issue_date')).toBeNull()
    expect(registry.field('identity.expiry_date')).toBeNull()
    expect(registry.field('identity.document_number')).toBeNull()
    // Numero e date sulle chiavi generiche, ma col `pii` delle chiavi `identity.*` che
    // sostituiscono: lo decide la mappa del tipo, non l'ontologia.
    const pii = (type: string, fieldId: string) =>
      piiOf(registry.profile(type), fieldId, registry.field(fieldId)!)
    expect(pii('identity_personal.patente_di_guida', 'document.number')).toBe('sensitive')
    expect(pii('identity_personal.carta_identita', 'document.expiry_date')).toBe('sensitive')
    expect(pii('accounting.fattura', 'document.number')).toBe('none')
  })

  it('la mappa del revisore sui documenti d’identità, dopo il cambio: cosa rientra', () => {
    // Le decisioni del 18/09 che l'export fa vedere, confrontate col registry di allora.
    const corrected = createExtractionRegistry(REGISTRY_DIR, () => ({
      fields: {
        'identity_personal.carta_identita': {
          'identity.nationality': 'required',
          'person.address': 'optional',
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
      return [...profile.required_fields, ...profile.optional_fields, ...profile.optional_fields]
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

describe('tipo senza profilo', () => {
  it('MISSING restituisce null senza errori', () => {
    expect(registry.profileSource('slug.manuale')).toBe('MISSING')
    expect(registry.profile('slug.manuale')).toBeNull()
  })
})

describe('errori d’avvio', () => {
  it('un profilo che cita un campo assente dall’ontologia', () => {
    const dir = registryCopy()
    editJson<{ document_types: Record<string, { optional_fields: string[] }> }>(
      dir,
      'document_fields.json',
      (data) => {
        data.document_types['accounting.fattura']!.optional_fields.push('campo.inventato')
      }
    )
    expect(() => createExtractionRegistry(dir)).toThrow(
      /1 riferimenti a campi assenti.*accounting\.fattura\.optional_fields: campo\.inventato/
    )
  })

  it.each([
    ['un campo fuori dal profilo del tipo', 'finance.balance_closing'],
    ['un campo assente dall’ontologia', 'campo.inventato']
  ])('un’eccezione ai validatori su %s', (_, fieldId) => {
    const dir = registryCopy()
    editJson<{
      document_types: Record<string, { field_validator_overrides?: Record<string, string[]> }>
    }>(dir, 'document_fields.json', (data) => {
      data.document_types['accounting.fattura']!.field_validator_overrides = { [fieldId]: [] }
    })
    expect(() => createExtractionRegistry(dir)).toThrow(
      `accounting.fattura.field_validator_overrides: ${fieldId}`
    )
  })

  it.each([
    ['un campo fuori dal profilo del tipo', 'finance.balance_closing'],
    ['un campo assente dall’ontologia', 'campo.inventato']
  ])('una descrizione per tipo su %s', (_, fieldId) => {
    const dir = registryCopy()
    editJson<{
      document_types: Record<string, { field_description_overrides?: Record<string, string> }>
    }>(dir, 'document_fields.json', (data) => {
      data.document_types['accounting.fattura']!.field_description_overrides = { [fieldId]: 'boh' }
    })
    expect(() => createExtractionRegistry(dir)).toThrow(
      `accounting.fattura.field_description_overrides: ${fieldId}`
    )
  })

  it.each([
    ['un campo fuori dal profilo del tipo', 'finance.balance_closing'],
    ['un campo assente dall’ontologia', 'campo.inventato']
  ])('un’eccezione al pii su %s', (_, fieldId) => {
    const dir = registryCopy()
    editJson<{
      document_types: Record<string, { field_pii_overrides?: Record<string, string> }>
    }>(dir, 'document_fields.json', (data) => {
      data.document_types['accounting.fattura']!.field_pii_overrides = { [fieldId]: 'sensitive' }
    })
    expect(() => createExtractionRegistry(dir)).toThrow(
      `accounting.fattura.field_pii_overrides: ${fieldId}`
    )
  })

  it('un’eccezione al pii vale solo coi valori che il registry conosce', () => {
    const dir = registryCopy()
    editJson<{
      document_types: Record<string, { field_pii_overrides?: Record<string, string> }>
    }>(dir, 'document_fields.json', (data) => {
      data.document_types['identity_personal.carta_identita']!.field_pii_overrides = {
        'document.number': 'segreto'
      }
    })
    expect(() => createExtractionRegistry(dir)).toThrow(
      /document_fields\.json ha una struttura inattesa in «document_types\.identity_personal\.carta_identita\.field_pii_overrides\.document\.number»/
    )
  })

  it('i derivati stanno fuori dai due ruoli, e un id sbagliato lì è un errore d’avvio', () => {
    const fattura = registry.profile('accounting.fattura')!
    // Nessuna fattura scrive la direzione del documento o il ruolo della controparte: il
    // motore li calcola, e finché li chiedeva obbligatori ogni fattura andava in revisione.
    expect(fattura.derived_fields).toEqual(['counterparty.role', 'document.direction'])
    for (const fieldId of fattura.derived_fields ?? []) {
      expect(fattura.required_fields).not.toContain(fieldId)
      expect(fattura.optional_fields).not.toContain(fieldId)
      expect(registry.field(fieldId)).toMatchObject({ derived: true, evidence_required: false })
    }

    const dir = registryCopy()
    editJson<{ document_types: Record<string, { derived_fields: string[] }> }>(
      dir,
      'document_fields.json',
      (data) => {
        data.document_types['accounting.fattura']!.derived_fields = ['fantasma.campo']
      }
    )
    expect(() => createExtractionRegistry(dir)).toThrow(
      /riferimenti a campi assenti .*accounting\.fattura\.derived_fields: fantasma\.campo/s
    )
  })

  it('un file del registry mancante o rotto', () => {
    const missing = registryCopy()
    rmSync(join(missing, 'fields.json'))
    expect(() => createExtractionRegistry(missing)).toThrow(/manca fields\.json/)

    const broken = registryCopy()
    writeFileSync(join(broken, 'document_fields.json'), '{')
    expect(() => createExtractionRegistry(broken)).toThrow(
      /document_fields\.json non è JSON valido/
    )
  })
})
