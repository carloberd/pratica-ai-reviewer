import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkTaxId,
  checkVatNumber,
  FIELD_VALIDATORS,
  isValidCodiceFiscale,
  isValidDate,
  isValidIban,
  isValidPartitaIva,
  normalizeTaxId,
  runFieldValidator,
  validationErrorsOf,
  validatorsOf
} from '../src/main/extract/v2/validators'
import { validationMessage } from '../src/shared/validation-messages'
import { REGISTRY_DIR } from './helpers/registry'

const readRegistry = <T>(file: string): T =>
  JSON.parse(readFileSync(join(REGISTRY_DIR, file), 'utf8')) as T

describe('validatori dell’ontologia v2', () => {
  it('date ISO che esistono davvero', () => {
    expect(isValidDate('2026-09-16')).toBe(true)
    expect(isValidDate('2026-02-31')).toBe(false)
    expect(isValidDate('16/09/2026')).toBe(false)
  })

  it('partita IVA con la cifra di controllo', () => {
    expect(isValidPartitaIva('12345678903')).toBe(true)
    expect(isValidPartitaIva('98765432103')).toBe(true)
    // Una cifra sbagliata, due cifre vicine scambiate.
    expect(isValidPartitaIva('12345678901')).toBe(false)
    expect(isValidPartitaIva('21345678903')).toBe(false)
    // Undici zeri passano il conto, ma non sono una partita IVA.
    expect(isValidPartitaIva('00000000000')).toBe(false)
    expect(isValidPartitaIva('1234567890')).toBe(false)
  })

  it('codice fiscale col carattere di controllo, omocodia compresa', () => {
    expect(isValidCodiceFiscale('RSSMRA80A01H501U')).toBe(true)
    expect(isValidCodiceFiscale('VRDGPP85T41F205T')).toBe(true)
    // Le cifre sostituite da lettere (L=0 … V=9) cambiano il carattere di controllo.
    expect(isValidCodiceFiscale('RSSMRA80A01H50MM')).toBe(true)
    expect(isValidCodiceFiscale('RSSMRA80A01H5LMX')).toBe(true)
    expect(isValidCodiceFiscale('RSSMRA80A01H501X')).toBe(false)
    // «F» non è la lettera di nessun mese.
    expect(isValidCodiceFiscale('RSSMRA80F01H501U')).toBe(false)
  })

  it('il prefisso IT e gli spazi non fanno parte del codice', () => {
    expect(normalizeTaxId('IT12345678903')).toBe('12345678903')
    expect(normalizeTaxId(' it 123 456 789 03 ')).toBe('12345678903')
    expect(normalizeTaxId('rssmra80a01h501u')).toBe('RSSMRA80A01H501U')
    // Davanti a un codice fiscale «IT» è parte del codice, non un prefisso.
    expect(normalizeTaxId('ITLMRA80A01H501U')).toBe('ITLMRA80A01H501U')
  })

  it('forma sbagliata e carattere di controllo sbagliato sono due risposte diverse', () => {
    expect(checkTaxId('IT12345678903')).toBe('VALID')
    expect(checkTaxId('rssmra80a01h501u')).toBe('VALID')
    expect(checkTaxId('12345678901')).toBe('BAD_CHECKSUM')
    expect(checkTaxId('RSSMRA80A01H501X')).toBe('BAD_CHECKSUM')
    expect(checkTaxId('1234')).toBe('BAD_FORMAT')
    // Due codici nello stesso campo, o un carattere di troppo, non sono un codice.
    expect(checkTaxId('RSSMRA80A01H501U 12345678903')).toBe('BAD_FORMAT')
    expect(checkTaxId('RSSMRA80A01H501UXY')).toBe('BAD_FORMAT')
    // Una lettera letta come cifra rompe la forma, non solo il controllo.
    expect(checkTaxId('RSSMRA80A017501U')).toBe('BAD_FORMAT')
  })

  it('la partita IVA vuole undici cifre: un codice fiscale di persona non ha la forma', () => {
    expect(checkVatNumber('12345678903')).toBe('VALID')
    expect(checkVatNumber('IT 12345678903')).toBe('VALID')
    expect(checkVatNumber('12345678930')).toBe('BAD_CHECKSUM')
    // Un codice fiscale valido, ma nel campo sbagliato: `checkTaxId` lo farebbe passare.
    expect(checkTaxId('RSSMRA80A01H501U')).toBe('VALID')
    expect(checkVatNumber('RSSMRA80A01H501U')).toBe('BAD_FORMAT')
    expect(checkVatNumber('1234567890')).toBe('BAD_FORMAT')
    expect(runFieldValidator('vat_number_format', 'rssmra80a01h501u')).toBe('INVALID_VAT_FORMAT')
    expect(runFieldValidator('vat_number_format', '12345678930')).toBe('INVALID_VAT_CHECKSUM')
    expect(runFieldValidator('vat_number_format', 'IT12345678903')).toBeNull()
    // Chi rivede legge una frase, non il codice.
    expect(validationMessage('INVALID_VAT_FORMAT')).toBe(
      'Non ha la forma di una partita IVA: 11 cifre.'
    )
    expect(validationMessage('INVALID_VAT_CHECKSUM')).not.toBe('INVALID_VAT_CHECKSUM')
  })

  it('IBAN col controllo del checksum', () => {
    expect(isValidIban('IT60 X054 2811 1010 0000 0123 456')).toBe(true)
    expect(isValidIban('IT61X0542811101000000123456')).toBe(false)
    expect(isValidIban('IT00INVALID')).toBe(false)
  })

  it('un valore vuoto non supera nessun validatore', () => {
    expect(runFieldValidator('non_empty', '')).toBe('EMPTY')
    expect(runFieldValidator('valid_date', null)).toBe('EMPTY')
  })

  it('valida i valori normalizzati come stringhe', () => {
    expect(runFieldValidator('valid_date', '2026-09-08')).toBeNull()
    expect(runFieldValidator('valid_date', '2026-13-01')).toBe('INVALID_DATE')
    expect(runFieldValidator('non_negative_money', '86420.00')).toBeNull()
    expect(runFieldValidator('non_negative_money', '-10.00')).toBe('NEGATIVE_MONEY')
    expect(runFieldValidator('non_negative_money', -1)).toBe('NEGATIVE_MONEY')
    expect(runFieldValidator('tax_id_format', '0123')).toBe('INVALID_TAX_ID_FORMAT')
    expect(runFieldValidator('tax_id_format', '12345678901')).toBe('INVALID_TAX_ID_CHECKSUM')
    expect(runFieldValidator('tax_id_format', 'IT12345678903')).toBeNull()
    expect(runFieldValidator('tax_id_format', 'RSSMRA80A01H501U')).toBeNull()
    expect(runFieldValidator('italian_tax_code_format', 'ABC')).toBe('INVALID_CF_FORMAT')
    expect(runFieldValidator('italian_tax_code_format', 'RSSMRA80A01H501X')).toBe(
      'INVALID_CF_CHECKSUM'
    )
    expect(runFieldValidator('italian_tax_code_format', 'RSSMRA80A01H50MM')).toBeNull()
    expect(runFieldValidator('iban_checksum', 'IT61X0542811101000000123456')).toBe('INVALID_IBAN')
    // L'etichetta finita nel valore non si toglie in silenzio: il valore è sporco.
    expect(runFieldValidator('iban_checksum', 'IBAN: IT60X0542811101000000123456')).toBe(
      'INVALID_IBAN'
    )
  })

  it('targa e telaio, con o senza spazi e trattini', () => {
    expect(runFieldValidator('vehicle_plate', 'AB123CD')).toBeNull()
    expect(runFieldValidator('vehicle_plate', 'ab 123 cd')).toBeNull()
    expect(runFieldValidator('vehicle_plate', 'AB-123-CD')).toBeNull()
    expect(runFieldValidator('vehicle_plate', 'MI 123456')).toBe('INVALID_VEHICLE_PLATE')
    expect(runFieldValidator('vin', 'WVWZZZ1JZXW000001')).toBeNull()
    expect(runFieldValidator('vin', 'WVWZZZ1JZXW00000O')).toBe('INVALID_VIN')
    expect(runFieldValidator('vin', 'WVWZZZ1JZXW0000')).toBe('INVALID_VIN')
  })

  it('CIG e CUP: la lunghezza è tutta la forma che hanno', () => {
    expect(runFieldValidator('cig_format', 'Z1A2B3C4D5')).toBeNull()
    expect(runFieldValidator('cig_format', 'z1a2b3c4d5')).toBeNull()
    // Scritto a gruppi, come capita sull'ordine.
    expect(runFieldValidator('cig_format', 'Z1A2 B3C4 D5')).toBeNull()
    expect(runFieldValidator('cig_format', 'Z1A2B3C4D')).toBe('INVALID_CIG')
    // Un CUP nel campo del CIG: è un identificativo vero nel campo sbagliato.
    expect(runFieldValidator('cig_format', 'B71B21000320001')).toBe('INVALID_CIG')
    expect(runFieldValidator('cig_format', 'Z1A2B3C4D_')).toBe('INVALID_CIG')

    expect(runFieldValidator('cup_format', 'B71B21000320001')).toBeNull()
    expect(runFieldValidator('cup_format', 'b71b21000320001')).toBeNull()
    expect(runFieldValidator('cup_format', 'Z1A2B3C4D5')).toBe('INVALID_CUP')
    expect(validationMessage('INVALID_CIG')).toContain('10')
    expect(validationMessage('INVALID_CUP')).toContain('15')
  })

  it('un validatore sconosciuto non blocca', () => {
    expect(runFieldValidator('sconosciuto', 'qualunque')).toBeNull()
  })

  it('ogni validatore del registry è uno che questo modulo sa eseguire', () => {
    // Un nome sconosciuto non blocca: senza questo controllo un validatore dichiarato
    // resterebbe muto, come targa e telaio finché il pack non li assegnava a nessun campo.
    const known = new Set<string>(FIELD_VALIDATORS)
    const { fields } = readRegistry<{ fields: Record<string, { validators: string[] }> }>(
      'fields.json'
    )
    const used = Object.values(fields).flatMap((field) => field.validators)

    expect(used.filter((name) => !known.has(name))).toEqual([])
    // `non_empty` non lo assegna più nessun campo: che un obbligatorio ci sia lo dice già
    // il suo ruolo, e ripeterlo in un validatore non aggiungeva niente.
    expect(new Set(used)).toEqual(new Set([...known].filter((name) => name !== 'non_empty')))
  })

  it('i validatori del profilo prendono il posto di quelli dell’ontologia', () => {
    const spec = { validators: ['non_negative_money'] }
    expect(validatorsOf(null, 'money.total', spec)).toEqual(['non_negative_money'])
    expect(
      validatorsOf({ field_validator_overrides: { 'money.total': [] } }, 'money.total', spec)
    ).toEqual([])
    expect(validatorsOf({}, 'money.total', null)).toEqual([])
  })

  it('un valore salvato vuoto non ha errori, uno pieno tutti quelli che fallisce', () => {
    expect(validationErrorsOf(['non_empty', 'iban_checksum'], '')).toEqual([])
    expect(validationErrorsOf(['iban_checksum'], '   ')).toEqual([])
    expect(validationErrorsOf(['iban_checksum'], null)).toEqual([])
    expect(validationErrorsOf(['iban_checksum', 'sconosciuto'], 'IT00')).toEqual(['INVALID_IBAN'])
  })
})
