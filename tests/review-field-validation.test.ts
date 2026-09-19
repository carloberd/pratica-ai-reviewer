import { afterEach, describe, expect, it } from 'vitest'
import type { FieldInput } from '../src/main/db/dao/fields'
import { validateFieldValue } from '../src/main/extract/v2/validators'
import { addFieldItem, updateFieldItem, updateFieldValue } from '../src/main/field-edits'
import { createTestRepository, seedDocument } from './helpers/db'
import { testRegistryV2 } from './helpers/registry'

let repo: ReturnType<typeof createTestRepository> | null = null

afterEach(() => {
  repo?.close()
  repo = null
})

const VALID_IBAN = 'IT60X0542811101000000123456'
const BAD_IBAN = 'IT61X0542811101000000123456'

/** Un documento del tipo dato, letto dalla revisione coi validatori del registry vero. */
function setup(documentType: string, fields: FieldInput[]) {
  const r = createTestRepository(
    {},
    {
      validateField: (type, name, value) => validateFieldValue(testRegistryV2(), type, name, value)
    }
  )
  repo = r
  const id = seedDocument(r)
  r.documents.setType(id, documentType, 0.9)
  r.fields.replaceForDocument(id, fields)
  const field = (name: string) => r.getReviewDocument(id)!.fields.find((f) => f.name === name)!
  return { r, id, field }
}

const one = (name: string, value: string | null): FieldInput => ({
  name,
  label: name,
  value,
  confidence: 0.85
})

describe('la revisione valida il valore che si vede', () => {
  it('la proposta del motore porta i suoi errori, una proposta giusta nessuno', () => {
    const { field } = setup('accounting.fattura', [
      one('bank.iban', BAD_IBAN),
      one('issuer.tax_id', '12345678903'),
      one('recipient.tax_id', null)
    ])
    expect(field('bank.iban').validationErrors).toEqual(['INVALID_IBAN'])
    expect(field('issuer.tax_id')).not.toHaveProperty('validationErrors')
    expect(field('recipient.tax_id')).not.toHaveProperty('validationErrors')
  })

  it('quello che scrive chi rivede si controlla appena salvato', () => {
    const { r, id, field } = setup('accounting.fattura', [
      one('bank.iban', BAD_IBAN),
      one('issuer.tax_id', null)
    ])

    // Due cifre scambiate, e un'etichetta finita dentro il valore.
    updateFieldValue(r, {
      documentId: id,
      fieldId: field('issuer.tax_id').id,
      correctedValue: '12345678930'
    })
    updateFieldValue(r, {
      documentId: id,
      fieldId: field('bank.iban').id,
      correctedValue: `IBAN: ${VALID_IBAN}`
    })
    expect(field('issuer.tax_id').validationErrors).toEqual(['INVALID_TAX_ID_CHECKSUM'])
    expect(field('bank.iban').validationErrors).toEqual(['INVALID_IBAN'])

    // Corretto: l'avviso sparisce, anche se la proposta sbagliata resta accanto.
    updateFieldValue(r, {
      documentId: id,
      fieldId: field('bank.iban').id,
      correctedValue: VALID_IBAN
    })
    expect(field('bank.iban')).toMatchObject({ value: BAD_IBAN, correctedValue: VALID_IBAN })
    expect(field('bank.iban')).not.toHaveProperty('validationErrors')
  })

  it('un campo svuotato non ha niente da segnalare', () => {
    const { r, id, field } = setup('accounting.fattura', [one('bank.iban', BAD_IBAN)])
    updateFieldValue(r, { documentId: id, fieldId: field('bank.iban').id, correctedValue: '' })
    expect(field('bank.iban')).not.toHaveProperty('validationErrors')
  })

  it('i validatori sono quelli del tipo: su una nota di credito un totale negativo va bene', () => {
    const total = [one('money.total', '-100.00')]
    expect(setup('accounting.fattura', total).field('money.total').validationErrors).toEqual([
      'NEGATIVE_MONEY'
    ])
    repo?.close()
    expect(setup('accounting.nota_di_credito', total).field('money.total')).not.toHaveProperty(
      'validationErrors'
    )
  })

  it('nei campi ripetuti ogni riga ha i suoi, e una riga tolta nessuno', () => {
    const { r, id, field } = setup('accounting.fattura', [
      {
        name: 'bank.iban',
        label: 'IBAN',
        value: null,
        confidence: 0.85,
        cardinality: 'many',
        items: [VALID_IBAN, BAD_IBAN, BAD_IBAN].map((value, itemIndex) => ({
          itemIndex,
          value,
          confidence: 0.85
        }))
      }
    ])
    const third = field('bank.iban').items[2]!
    updateFieldItem(r, { documentId: id, itemId: third.id, correctedValue: '' })
    addFieldItem(r, { documentId: id, fieldId: field('bank.iban').id, value: 'IT00 1234' })

    const iban = field('bank.iban')
    expect(iban).not.toHaveProperty('validationErrors')
    expect(iban.items.map((item) => [item.removed, item.validationErrors])).toEqual([
      [false, undefined],
      [false, ['INVALID_IBAN']],
      [true, undefined],
      [false, ['INVALID_IBAN']]
    ])
  })

  it('sulla fattura un codice fiscale di persona non passa per partita IVA', () => {
    const cf = 'RSSMRA80A01H501U'
    const { field } = setup('accounting.fattura', [
      one('issuer.vat_number', cf),
      one('issuer.tax_code', cf),
      one('recipient.vat_number', 'IT12345678903'),
      one('recipient.tax_code', '12345678903'),
      // Una fattura elaborata prima tiene le chiavi di allora, coi validatori di allora.
      one('issuer.tax_id', cf)
    ])
    expect(field('issuer.vat_number').validationErrors).toEqual(['INVALID_VAT_FORMAT'])
    expect(field('issuer.tax_code')).not.toHaveProperty('validationErrors')
    expect(field('recipient.vat_number')).not.toHaveProperty('validationErrors')
    expect(field('recipient.tax_code')).not.toHaveProperty('validationErrors')
    expect(field('issuer.tax_id')).not.toHaveProperty('validationErrors')
  })

  it('senza registry v2, o su un nome del motore v1, non si valida niente', () => {
    expect(validateFieldValue(undefined, 'accounting.fattura', 'bank.iban', BAD_IBAN)).toEqual([])
    expect(validateFieldValue(testRegistryV2(), 'accounting.fattura', 'iban', BAD_IBAN)).toEqual([])
    // Senza tipo valgono quelli dell'ontologia.
    expect(validateFieldValue(testRegistryV2(), null, 'bank.iban', BAD_IBAN)).toEqual([
      'INVALID_IBAN'
    ])
  })
})
