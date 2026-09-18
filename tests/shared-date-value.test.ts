import { describe, expect, it } from 'vitest'
import { findDate, findTextualDate, normalizeDateValue } from '../src/shared/date-value'
import { normalizeFieldValue, resolveFieldEdit, resolveItemEdit } from '../src/shared/field-edits'
import { isDateField } from '../src/shared/fields'

/**
 * I valori di questo file vengono dall'export del 18/09/2026: 45 date su 57 erano in
 * formato libero, e tutte e 45 le aveva scritte il revisore ricopiando dal documento.
 */

describe('la data in forma canonica', () => {
  it('le forme che il revisore ricopia dai documenti', () => {
    expect(normalizeDateValue('16/12/2025')).toBe('2025-12-16')
    expect(normalizeDateValue('31.05.2024')).toBe('2024-05-31')
    expect(normalizeDateValue('05-07-2022')).toBe('2022-07-05')
    expect(normalizeDateValue('29 07 2026')).toBe('2026-07-29')
    expect(normalizeDateValue('10 11 1994')).toBe('1994-11-10')
    expect(normalizeDateValue('31 Maggio 2022')).toBe('2022-05-31')
    expect(normalizeDateValue('  2/7/25  ')).toBe('2025-07-02')
  })

  it('una data già canonica resta comʼè', () => {
    expect(normalizeDateValue('2024-04-29')).toBe('2024-04-29')
  })

  it('lʼanno a due cifre ha il pivot di POSIX', () => {
    expect(normalizeDateValue('01/01/69')).toBe('2069-01-01')
    expect(normalizeDateValue('01/01/70')).toBe('1970-01-01')
  })

  it('una data che non esiste non è una data', () => {
    expect(normalizeDateValue('31/02/2026')).toBeNull()
    expect(normalizeDateValue('45/13/2026')).toBeNull()
    expect(normalizeDateValue('31 febbraio 2026')).toBeNull()
  })

  it('deve essere tutta la stringa, o quello che il revisore ha scritto si perderebbe', () => {
    // Verbatim dallʼexport: due date e le ore, su `hse.training_date`.
    expect(normalizeDateValue('03/05/2021 (8 ore), 04/05/2021 (8 ore)')).toBeNull()
    expect(normalizeDateValue('Contratto del 05/07/2022')).toBeNull()
    expect(normalizeDateValue('COMUNE DI ROVIGO')).toBeNull()
    expect(normalizeDateValue('')).toBeNull()
  })

  it('«31 12 2025» si legge solo come valore intero, non dentro una riga', () => {
    // Tre numeri di seguito dentro una riga sono quasi sempre una riga merce o un codice.
    expect(findDate('LGICSL60001674 PZ 5 5000 26 6250')).toBeNull()
    expect(normalizeDateValue('5 5000 26')).toBeNull()
  })

  it('le date dentro una riga si trovano ancora', () => {
    expect(findDate('FATTURA n. 114/2026 del 08/09/2026')?.value).toBe('2026-09-08')
    expect(findTextualDate('emessa il 12 settembre 2026 a Bologna')?.value).toBe('2026-09-12')
  })
})

describe('quali campi sono date', () => {
  it('lo dice il tipo semantico del profilo v2', () => {
    expect(isDateField('date', 'document.issue_date')).toBe(true)
    expect(isDateField('string', 'document.number')).toBe(false)
    // Il tipo dichiarato vince sul nome: un campo `string` che si chiama `_date` non lo è.
    expect(isDateField('string', 'contract.signature_date')).toBe(false)
  })

  it('senza tipo semantico lo dice il nome, come sulle righe del v1', () => {
    expect(isDateField(null, 'document.issue_date')).toBe(true)
    expect(isDateField(null, 'identity.expiry_date')).toBe(true)
    expect(isDateField(null, 'person.birth_date')).toBe(true)
    expect(isDateField(null, 'issue_date')).toBe(true)
    expect(isDateField(null, 'issuer.name')).toBe(false)
  })
})

describe('quello che il revisore scrive', () => {
  it('in un campo data si salva canonico', () => {
    expect(normalizeFieldValue(' 16/12/2025 ', true)).toBe('2025-12-16')
  })

  it('in un campo che non è una data si salva comʼè, solo senza spazi ai bordi', () => {
    expect(normalizeFieldValue('  B/2600143  ', false)).toBe('B/2600143')
    // Un numero documento che sembra una data non si tocca.
    expect(normalizeFieldValue('16/12/2025', false)).toBe('16/12/2025')
  })

  it('ricopiare la data che il motore aveva già letto non è una correzione', () => {
    // Il motore scrive ISO, il revisore ricopia dal documento: sono dʼaccordo.
    expect(resolveFieldEdit('2025-12-16', '16/12/2025', true)).toBeNull()
    // Senza normalizzazione sarebbe finita nel dataset come un CHANGED che non è mai stato.
    expect(resolveFieldEdit('2025-12-16', '16/12/2025', false)).toBe('16/12/2025')
  })

  it('una data diversa resta una correzione, in forma canonica', () => {
    expect(resolveFieldEdit('2025-12-16', '17/12/2025', true)).toBe('2025-12-17')
  })

  it('vale anche per le righe dei campi ripetuti', () => {
    const proposta = { origin: 'ENGINE' as const, value: '2026-01-31', correctedValue: undefined }
    expect(resolveItemEdit(proposta, '31/01/2026', true)).toEqual({ type: 'reset' })
    expect(resolveItemEdit(proposta, '28/02/2026', true)).toEqual({
      type: 'correct',
      value: '2026-02-28'
    })
  })
})
