import { describe, expect, it } from 'vitest'
import {
  confirmedItems,
  currentItemValue,
  documentCorrections,
  fieldCorrections,
  normalizeNewItem,
  resolveFieldEdit,
  resolveItemEdit
} from '../src/shared/field-edits'
import { item, listField, scalarField } from './helpers/review-document'

describe('modifica di un campo singolo', () => {
  it('riscrivere la proposta non è una correzione, null la annulla', () => {
    expect(resolveFieldEdit('ALFA SRL', '  ALFA SRL ')).toBeNull()
    expect(resolveFieldEdit('ALFA SRL', null)).toBeNull()
    expect(resolveFieldEdit('ALFA SRL', ' Alfa S.r.l. ')).toBe('Alfa S.r.l.')
  })

  it('svuotare una proposta sbagliata resta una correzione; svuotare un vuoto no', () => {
    expect(resolveFieldEdit('ALFA SRL', '   ')).toBe('')
    expect(resolveFieldEdit(null, '')).toBeNull()
    expect(resolveFieldEdit(null, '114/2026')).toBe('114/2026')
  })
})

describe('modifica di una riga ripetuta', () => {
  const proposed = item({ value: 'Fornitura' })

  it('su una riga proposta: correggere, tornare alla proposta, togliere', () => {
    expect(resolveItemEdit(proposed, 'Posa in opera')).toEqual({
      type: 'correct',
      value: 'Posa in opera'
    })
    expect(resolveItemEdit(proposed, ' Fornitura ')).toEqual({ type: 'reset' })
    expect(resolveItemEdit(proposed, null)).toEqual({ type: 'reset' })
    expect(resolveItemEdit(proposed, '')).toEqual({ type: 'remove' })
  })

  it('su una riga aggiunta a mano: svuotarla la cancella', () => {
    const manual = item({ origin: 'MANUAL', value: '', correctedValue: 'Trasporto' })
    expect(resolveItemEdit(manual, 'Trasporto')).toEqual({ type: 'none' })
    expect(resolveItemEdit(manual, 'Trasporto e scarico')).toEqual({
      type: 'correct',
      value: 'Trasporto e scarico'
    })
    expect(resolveItemEdit(manual, '  ')).toEqual({ type: 'delete' })
    expect(resolveItemEdit(manual, null)).toEqual({ type: 'delete' })
  })

  it('una riga nuova senza testo non si aggiunge', () => {
    expect(normalizeNewItem('  ')).toBeNull()
    expect(normalizeNewItem(' Nolo gru ')).toBe('Nolo gru')
  })

  it('le righe confermate sono quelle con un valore, nell’ordine della tabella', () => {
    const items = [
      item({ id: 'b', index: 2, origin: 'MANUAL', value: '', correctedValue: 'Trasporto' }),
      item({ id: 'a', index: 0, value: 'Fornitura' }),
      item({ id: 'x', index: 1, value: 'Doppione', removed: true })
    ]
    expect(confirmedItems(items).map((row) => row.id)).toEqual(['a', 'b'])
    expect(currentItemValue(items[2]!)).toBeNull()
  })
})

describe('before/after', () => {
  it('un campo singolo: cambiato, compilato, svuotato', () => {
    expect(fieldCorrections(scalarField({ correctedValue: '114/2026-B' }))).toMatchObject([
      { kind: 'CHANGED', before: '114/2026', after: '114/2026-B', itemIndex: null }
    ])
    expect(fieldCorrections(scalarField({ value: '', correctedValue: '7' }))).toMatchObject([
      { kind: 'FILLED', before: null, after: '7' }
    ])
    expect(fieldCorrections(scalarField({ correctedValue: '' }))).toMatchObject([
      { kind: 'CLEARED', before: '114/2026', after: null }
    ])
    expect(fieldCorrections(scalarField({ correctedValue: '114/2026' }))).toEqual([])
    expect(fieldCorrections(scalarField())).toEqual([])
  })

  it('un campo ripetuto: una correzione per riga toccata', () => {
    const field = listField([
      item({ id: 'a', index: 0, value: 'Fornitura' }),
      item({ id: 'b', index: 1, value: 'Posa', correctedValue: 'Posa in opera' }),
      item({ id: 'c', index: 2, value: 'Doppione', removed: true }),
      item({ id: 'd', index: 3, origin: 'MANUAL', value: '', correctedValue: 'Trasporto' })
    ])
    expect(
      fieldCorrections(field).map(({ itemId, itemIndex, kind, before, after }) => ({
        itemId,
        itemIndex,
        kind,
        before,
        after
      }))
    ).toEqual([
      { itemId: 'b', itemIndex: 1, kind: 'CHANGED', before: 'Posa', after: 'Posa in opera' },
      { itemId: 'c', itemIndex: 2, kind: 'REMOVED', before: 'Doppione', after: null },
      { itemId: 'd', itemIndex: 3, kind: 'ADDED', before: null, after: 'Trasporto' }
    ])
  })

  it('le correzioni di un documento mettono insieme campi singoli e righe', () => {
    const fields = [
      scalarField({ correctedValue: 'X' }),
      listField([item({ origin: 'MANUAL', value: '', correctedValue: 'Y' })])
    ]
    expect(documentCorrections(fields).map((c) => c.kind)).toEqual(['CHANGED', 'ADDED'])
  })
})
