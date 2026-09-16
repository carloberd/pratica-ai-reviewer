import { describe, expect, it } from 'vitest'
import {
  fieldOutcome,
  isFieldTestedProfile,
  type MeasuredDocumentInput,
  type MeasuredTypeInput,
  measureDelta,
  measureType,
  measureTypes
} from '../src/shared/profile-metrics'
import type { ExtractedField } from '../src/shared/types'
import { item, listField, scalarField } from './helpers/review-document'

/**
 * Le tre misure e i due segnali, su ingressi costruiti a mano: qui non c'è database,
 * quindi ogni caso è esattamente quello che dice di essere.
 */

function document(
  id: string,
  fields: ExtractedField[],
  overrides: Partial<MeasuredDocumentInput> = {}
): MeasuredDocumentInput {
  return {
    documentId: id,
    driveFileId: `drive-${id}`,
    filename: `${id}.pdf`,
    reviewedAt: '2026-09-16T10:00:00.000Z',
    fields,
    ...overrides
  }
}

function type(
  documents: MeasuredDocumentInput[],
  profileFields: MeasuredTypeInput['profileFields']
): MeasuredTypeInput {
  return {
    documentType: 'accounting.fattura',
    label: 'fattura',
    profileOrigin: 'V2_EXPLICIT',
    schemaState: 'EXTRACTION_SCHEMA_DRAFT',
    fieldTested: false,
    profileFields,
    documents
  }
}

const NUMBER = { fieldId: 'document.number', label: 'Numero documento', role: 'core' as const }
const DATE = { fieldId: 'document.issue_date', label: 'Data emissione', role: 'required' as const }

describe('esito di un campo su un documento', () => {
  it('proposto e non toccato = confermato', () => {
    expect(fieldOutcome(scalarField({ value: '114/2026' }))).toBe('CONFIRMED')
  })

  it('riscrivere lo stesso valore non è una correzione', () => {
    expect(fieldOutcome(scalarField({ value: '114/2026', correctedValue: '114/2026' }))).toBe(
      'CONFIRMED'
    )
  })

  it('proposto e cambiato = corretto; proposto e svuotato pure', () => {
    expect(fieldOutcome(scalarField({ value: '114/2026', correctedValue: '114/2026/B' }))).toBe(
      'CORRECTED'
    )
    expect(fieldOutcome(scalarField({ value: '114/2026', correctedValue: '' }))).toBe('CORRECTED')
  })

  it('vuoto e compilato = a mano; vuoto e lasciato vuoto = vuoto', () => {
    expect(fieldOutcome(scalarField({ value: '', correctedValue: '114/2026' }))).toBe('MANUAL')
    expect(fieldOutcome(scalarField({ value: '' }))).toBe('EMPTY')
  })

  it('campi ripetuti: righe aggiunte a mano sul niente valgono «a mano»', () => {
    const proposed = listField([item(), item({ id: 'i1', index: 1, value: 'Trasporto' })])
    expect(fieldOutcome(proposed)).toBe('CONFIRMED')

    const corrected = listField([item({ correctedValue: 'Fornitura materiali vari' })])
    expect(fieldOutcome(corrected)).toBe('CORRECTED')

    const removed = listField([item({ removed: true })])
    expect(fieldOutcome(removed)).toBe('CORRECTED')

    const manual = listField([
      item({ id: 'm0', value: '', origin: 'MANUAL', correctedValue: 'Riga scritta a mano' })
    ])
    expect(fieldOutcome(manual)).toBe('MANUAL')

    expect(fieldOutcome(listField([]))).toBe('EMPTY')
  })
})

describe('misure per tipo', () => {
  it('conta confermati, corretti e a mano, e ne ricava le tre quote', () => {
    const measure = measureType(
      type(
        [
          document('a', [
            scalarField({ id: 'a1', value: '114/2026' }),
            scalarField({ id: 'a2', name: 'document.issue_date', value: '2026-09-14' })
          ]),
          document('b', [
            scalarField({ id: 'b1', value: '115/2026', correctedValue: '115/2026/B' }),
            scalarField({
              id: 'b2',
              name: 'document.issue_date',
              value: '',
              correctedValue: '2026-09-15'
            })
          ])
        ],
        [NUMBER, DATE]
      )
    )

    expect(measure.totals).toMatchObject({
      documents: 2,
      confirmed: 2,
      corrected: 1,
      manual: 1,
      outcomes: 4,
      confirmedRate: 0.5,
      correctedRate: 0.25,
      manualRate: 0.25
    })

    const number = measure.fields.find((field) => field.fieldId === 'document.number')!
    expect(number).toMatchObject({ confirmed: 1, corrected: 1, manual: 0, empty: 0, signal: 'OK' })
    const date = measure.fields.find((field) => field.fieldId === 'document.issue_date')!
    expect(date).toMatchObject({ confirmed: 1, manual: 1, manualRate: 0.5 })
  })

  it('un campo del profilo senza mai un valore è un candidato alla rimozione, col numero giusto', () => {
    const documents = Array.from({ length: 12 }, (_, index) =>
      document(`doc-${index}`, [
        // Il «numero» c'è nel profilo, il motore non lo trova e il revisore non lo mette.
        scalarField({ id: `n${index}`, value: '' }),
        scalarField({ id: `d${index}`, name: 'document.issue_date', value: '2026-09-14' })
      ])
    )
    const measure = measureType(type(documents, [NUMBER, DATE]))

    const number = measure.fields.find((field) => field.fieldId === 'document.number')!
    expect(number.signal).toBe('NEVER_USED')
    expect(number.empty).toBe(12)
    expect(number.documents).toBe(12)
    expect(number.filled).toBe(0)
    // I campi vuoti su entrambi i lati non entrano nelle quote del tipo.
    expect(measure.totals.outcomes).toBe(12)
    expect(measure.totals.confirmedRate).toBe(1)
  })

  it('un campo che il revisore aggiunge e il profilo non prevede è un candidato all’aggiunta', () => {
    const measure = measureType(
      type(
        [
          document('a', [
            scalarField({ id: 'a1', value: '114/2026' }),
            scalarField({
              id: 'a2',
              name: 'bank.iban',
              label: 'IBAN',
              value: '',
              correctedValue: 'IT60X0542811101000000123456'
            })
          ]),
          document('b', [
            scalarField({ id: 'b1', value: '115/2026' }),
            scalarField({
              id: 'b2',
              name: 'bank.iban',
              label: 'IBAN',
              value: '',
              correctedValue: 'IT60X0542811101000000999999'
            })
          ])
        ],
        [NUMBER]
      )
    )

    const iban = measure.fields.find((field) => field.fieldId === 'bank.iban')!
    expect(iban).toMatchObject({
      inProfile: false,
      role: null,
      manual: 2,
      filled: 2,
      signal: 'MISSING_FROM_PROFILE',
      label: 'IBAN'
    })
    // I campi del profilo stanno prima, i candidati dopo.
    expect(measure.fields.map((field) => field.fieldId)).toEqual(['document.number', 'bank.iban'])
  })

  it('un campo fuori dal profilo che nessuno ha compilato non è un candidato', () => {
    const measure = measureType(
      type([document('a', [scalarField({ id: 'a2', name: 'bank.iban', value: '' })])], [NUMBER])
    )
    expect(measure.fields.find((field) => field.fieldId === 'bank.iban')!.signal).toBe('OK')
  })

  it('i campi del profilo escono per ruolo: obbligatori, principali, opzionali', () => {
    const measure = measureType(
      type(
        [document('a', [])],
        [
          { fieldId: 'money.total', label: 'Totale', role: 'optional' },
          NUMBER,
          DATE,
          { fieldId: 'money.tax', label: 'Imposta', role: 'conditional' }
        ]
      )
    )
    expect(measure.fields.map((field) => field.fieldId)).toEqual([
      'document.issue_date',
      'document.number',
      'money.total',
      'money.tax'
    ])
  })

  it('i tipi escono da quello con più documenti annotati', () => {
    const [first, second] = measureTypes([
      { ...type([document('a', [])], []), documentType: 'a.uno' },
      { ...type([document('b', []), document('c', [])], []), documentType: 'b.due' }
    ])
    expect(first!.documentType).toBe('b.due')
    expect(second!.documentType).toBe('a.uno')
  })
})

describe('prima e dopo', () => {
  const profile = [NUMBER, DATE]

  /** Dieci documenti dove il «numero» si riempie a mano nella quota indicata. */
  function withManualNumber(manual: number) {
    return measureType(
      type(
        Array.from({ length: 10 }, (_, index) =>
          document(`doc-${index}`, [
            index < manual
              ? scalarField({ id: `n${index}`, value: '', correctedValue: `10${index}/2026` })
              : scalarField({ id: `n${index}`, value: `10${index}/2026` }),
            scalarField({ id: `d${index}`, name: 'document.issue_date', value: '2026-09-14' })
          ])
        ),
        profile
      )
    )
  }

  it('mostra il campo che è migliorato, col prima e col dopo', () => {
    const delta = measureDelta(withManualNumber(7), withManualNumber(2))

    expect(delta.unchanged).toBe(false)
    expect(delta.before.manualRate).toBe(0.35)
    expect(delta.after.manualRate).toBe(0.1)

    const number = delta.fields[0]!
    expect(number.fieldId).toBe('document.number')
    expect(number.before!.manualRate).toBe(0.7)
    expect(number.after!.manualRate).toBe(0.2)
    expect(number.manualRateChange).toBe(-0.5)
    expect(number.confirmedRateChange).toBe(0.5)
  })

  it('senza movimenti lo dice, invece di mostrare una lista vuota', () => {
    const delta = measureDelta(withManualNumber(3), withManualNumber(3))
    expect(delta.fields).toEqual([])
    expect(delta.unchanged).toBe(true)
  })

  it('un campo tolto dal profilo compare col «dopo» assente', () => {
    const before = withManualNumber(0)
    const after = measureType(
      type(
        Array.from({ length: 10 }, (_, index) =>
          document(`doc-${index}`, [
            scalarField({ id: `d${index}`, name: 'document.issue_date', value: '2026-09-14' })
          ])
        ),
        [DATE]
      )
    )
    const gone = measureDelta(before, after).fields.find(
      (field) => field.fieldId === 'document.number'
    )!
    expect(gone.before).not.toBeNull()
    expect(gone.after).toBeNull()
  })
})

describe('profili verificati su documenti reali', () => {
  it('riconosce i soli READY_FOR_FIELD_TEST', () => {
    expect(isFieldTestedProfile({ schema_state: 'EXTRACTION_SCHEMA_READY_FOR_FIELD_TEST' })).toBe(
      true
    )
    expect(isFieldTestedProfile({ schema_state: 'EXTRACTION_SCHEMA_DRAFT' })).toBe(false)
    expect(isFieldTestedProfile(null)).toBe(false)
  })
})
