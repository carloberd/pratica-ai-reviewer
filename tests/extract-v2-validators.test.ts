import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkTaxId,
  FIELD_VALIDATORS,
  isValidCodiceFiscale,
  isValidDate,
  isValidIban,
  isValidPartitaIva,
  normalizeTaxId,
  runFieldValidator
} from '../src/main/extract/v2/validators'
import { REGISTRY_V2_DIR } from './helpers/registry'

const readRegistry = <T>(file: string): T =>
  JSON.parse(readFileSync(join(REGISTRY_V2_DIR, file), 'utf8')) as T

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

  it('un validatore sconosciuto non blocca', () => {
    expect(runFieldValidator('sconosciuto', 'qualunque')).toBeNull()
  })

  it('ogni validatore del registry è uno che questo modulo sa eseguire', () => {
    // Un nome sconosciuto non blocca: senza questo controllo un validatore dichiarato
    // resterebbe muto, come targa e telaio finché il pack non li assegnava a nessun campo.
    const known = new Set<string>(FIELD_VALIDATORS)
    const { validators } = readRegistry<{ validators: Record<string, unknown> }>(
      'validators_v2.json'
    )
    const { fields } = readRegistry<{ fields: Record<string, { validators: string[] }> }>(
      'field_ontology_v2.json'
    )
    const used = Object.values(fields).flatMap((field) => field.validators)

    expect(Object.keys(validators).filter((name) => !known.has(name))).toEqual([])
    expect(used.filter((name) => !known.has(name))).toEqual([])
    expect(new Set(used)).toEqual(known)
  })
})
