import { describe, expect, it } from 'vitest'
import {
  isItalianTaxIdLike,
  isValidDate,
  isValidIban,
  runFieldValidator
} from '../src/main/extract/v2/validators'

describe('validatori dell’ontologia v2', () => {
  it('date ISO che esistono davvero', () => {
    expect(isValidDate('2026-09-16')).toBe(true)
    expect(isValidDate('2026-02-31')).toBe(false)
    expect(isValidDate('16/09/2026')).toBe(false)
  })

  it('partita IVA e codice fiscale per struttura', () => {
    expect(isItalianTaxIdLike('12345678901')).toBe(true)
    expect(isItalianTaxIdLike('RSSMRA80A01H501U')).toBe(true)
    expect(isItalianTaxIdLike('1234')).toBe(false)
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
    expect(runFieldValidator('italian_tax_code_format', 'ABC')).toBe('INVALID_CF_FORMAT')
    expect(runFieldValidator('iban_checksum', 'IT61X0542811101000000123456')).toBe('INVALID_IBAN')
  })

  it('un validatore sconosciuto non blocca', () => {
    expect(runFieldValidator('vehicle_plate', 'qualunque')).toBeNull()
  })
})
