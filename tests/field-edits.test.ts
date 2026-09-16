import { afterEach, describe, expect, it } from 'vitest'
import type { FieldInput } from '../src/main/db/dao/fields'
import {
  addFieldItem,
  setFieldItemRemoved,
  updateFieldItem,
  updateFieldValue
} from '../src/main/field-edits'
import { createTestRepository, seedDocument } from './helpers/db'

let repo: ReturnType<typeof createTestRepository> | null = null

afterEach(() => {
  repo?.close()
  repo = null
})

/** Una fattura con due righe proposte dal motore e un numero documento. */
function setup(lines = ['Fornitura materiali edili', 'Posa in opera']) {
  const r = createTestRepository()
  repo = r
  const id = seedDocument(r)
  const evidence = r.evidence.replaceForDocument(
    id,
    lines.map((text) => ({ page: 1, text, confidence: 0.85 }))
  )
  r.fields.replaceForDocument(id, fieldsFor(lines, evidence))
  return { r, id }
}

function fieldsFor(lines: string[], evidence: string[] = []): FieldInput[] {
  return [
    { name: 'document.number', label: 'Numero documento', value: '114/2026', confidence: 0.85 },
    {
      name: 'line_items',
      label: 'Righe documento',
      value: null,
      confidence: 0.85,
      cardinality: 'many',
      role: 'core',
      items: lines.map((value, itemIndex) => ({
        itemIndex,
        value,
        confidence: 0.85,
        evidenceId: evidence[itemIndex] ?? null
      }))
    }
  ]
}

function lines(r: NonNullable<typeof repo>, id: string) {
  return r.getReviewDocument(id)!.fields.find((field) => field.name === 'line_items')!
}

function rows(r: NonNullable<typeof repo>, id: string) {
  return lines(r, id).items.map(({ index, value, correctedValue, origin, removed }) => ({
    index,
    value,
    correctedValue,
    origin,
    removed
  }))
}

describe('righe dei campi ripetuti', () => {
  it('le righe arrivano alla revisione con la loro evidenza', () => {
    const { r, id } = setup()
    const document = r.getReviewDocument(id)!
    const field = lines(r, id)
    expect(field.cardinality).toBe('many')
    expect(field.items).toHaveLength(2)
    const evidence = document.evidence.find((item) => item.id === field.items[1]!.evidenceId)
    expect(evidence).toMatchObject({ text: 'Posa in opera', label: 'Righe documento · riga 2' })
  })

  it('correggere, togliere e ripristinare una riga proposta', () => {
    const { r, id } = setup()
    const [first, second] = lines(r, id).items

    updateFieldItem(r, { documentId: id, itemId: first!.id, correctedValue: 'Fornitura laterizi' })
    updateFieldItem(r, { documentId: id, itemId: second!.id, correctedValue: '' })
    expect(rows(r, id)).toEqual([
      {
        index: 0,
        value: 'Fornitura materiali edili',
        correctedValue: 'Fornitura laterizi',
        origin: 'ENGINE',
        removed: false
      },
      {
        index: 1,
        value: 'Posa in opera',
        correctedValue: undefined,
        origin: 'ENGINE',
        removed: true
      }
    ])

    setFieldItemRemoved(r, { documentId: id, itemId: second!.id, removed: false })
    updateFieldItem(r, {
      documentId: id,
      itemId: first!.id,
      correctedValue: 'Fornitura materiali edili'
    })
    expect(rows(r, id).every((row) => !row.removed && row.correctedValue === undefined)).toBe(true)
  })

  it('una riga aggiunta a mano va in coda, e svuotata sparisce', () => {
    const { r, id } = setup()
    addFieldItem(r, { documentId: id, fieldId: lines(r, id).id, value: '  Trasporto  ' })
    expect(rows(r, id).at(-1)).toEqual({
      index: 2,
      value: '',
      correctedValue: 'Trasporto',
      origin: 'MANUAL',
      removed: false
    })

    const manual = lines(r, id).items.at(-1)!
    updateFieldItem(r, { documentId: id, itemId: manual.id, correctedValue: '' })
    expect(lines(r, id).items).toHaveLength(2)

    addFieldItem(r, { documentId: id, fieldId: lines(r, id).id, value: 'Nolo' })
    setFieldItemRemoved(r, {
      documentId: id,
      itemId: lines(r, id).items.at(-1)!.id,
      removed: true
    })
    expect(lines(r, id).items).toHaveLength(2)
  })

  it('una riga tolta non conta fra i valori del campo', () => {
    const { r, id } = setup(['Unica riga'])
    expect(r.fields.countFilledItems(lines(r, id).id)).toBe(1)
    setFieldItemRemoved(r, { documentId: id, itemId: lines(r, id).items[0]!.id, removed: true })
    expect(r.fields.countFilledItems(lines(r, id).id)).toBe(0)
  })

  it('gli id devono appartenere al documento, e il tipo di campo deve essere quello giusto', () => {
    const { r, id } = setup()
    const other = seedDocument(r, { driveFileId: 'drive-2' })
    const field = lines(r, id)
    const number = r.getReviewDocument(id)!.fields[0]!

    expect(() =>
      updateFieldItem(r, { documentId: other, itemId: field.items[0]!.id, correctedValue: 'x' })
    ).toThrow('Riga non trovata')
    expect(() => addFieldItem(r, { documentId: other, fieldId: field.id, value: 'x' })).toThrow(
      'Campo non trovato'
    )
    expect(() => addFieldItem(r, { documentId: id, fieldId: number.id, value: 'x' })).toThrow(
      'non è ripetuto'
    )
    expect(() => addFieldItem(r, { documentId: id, fieldId: field.id, value: '  ' })).toThrow(
      'vuota'
    )
    expect(() =>
      updateFieldValue(r, { documentId: id, fieldId: field.id, correctedValue: 'x' })
    ).toThrow('riga per riga')
  })
})

describe('campi singoli', () => {
  it('svuotare una proposta sbagliata è una correzione, annullarla torna alla proposta', () => {
    const { r, id } = setup()
    const number = () => r.getReviewDocument(id)!.fields[0]!

    updateFieldValue(r, { documentId: id, fieldId: number().id, correctedValue: '   ' })
    expect(number().correctedValue).toBe('')

    updateFieldValue(r, { documentId: id, fieldId: number().id, correctedValue: null })
    expect(number().correctedValue).toBeUndefined()

    updateFieldValue(r, { documentId: id, fieldId: number().id, correctedValue: ' 114/2026 ' })
    expect(number().correctedValue).toBeUndefined()
  })
})

describe('una nuova estrazione non perde il lavoro sulle righe', () => {
  it('correzioni e rimozioni tornano sulla stessa riga, le righe a mano restano in coda', () => {
    const { r, id } = setup(['Fornitura', 'Posa', 'Doppione'])
    const [first, , third] = lines(r, id).items
    updateFieldItem(r, { documentId: id, itemId: first!.id, correctedValue: 'Fornitura laterizi' })
    setFieldItemRemoved(r, { documentId: id, itemId: third!.id, removed: true })
    addFieldItem(r, { documentId: id, fieldId: lines(r, id).id, value: 'Trasporto' })

    // Stesso documento, il motore ora legge una riga in più.
    r.fields.replaceForDocument(id, fieldsFor(['Fornitura', 'Posa', 'Doppione', 'Scarico']))

    expect(rows(r, id)).toEqual([
      {
        index: 0,
        value: 'Fornitura',
        correctedValue: 'Fornitura laterizi',
        origin: 'ENGINE',
        removed: false
      },
      { index: 1, value: 'Posa', correctedValue: undefined, origin: 'ENGINE', removed: false },
      { index: 2, value: 'Doppione', correctedValue: undefined, origin: 'ENGINE', removed: true },
      { index: 3, value: 'Scarico', correctedValue: undefined, origin: 'ENGINE', removed: false },
      { index: 4, value: '', correctedValue: 'Trasporto', origin: 'MANUAL', removed: false }
    ])
  })

  it('una riga corretta che il motore non trova più diventa del revisore', () => {
    const { r, id } = setup(['Fornitura', 'Posa'])
    const second = lines(r, id).items[1]!
    updateFieldItem(r, { documentId: id, itemId: second.id, correctedValue: 'Posa in opera' })
    setFieldItemRemoved(r, { documentId: id, itemId: lines(r, id).items[0]!.id, removed: true })

    r.fields.replaceForDocument(id, fieldsFor([]))

    // La rimozione di una riga che non esiste più non ha niente da ricordare.
    expect(rows(r, id)).toEqual([
      { index: 0, value: '', correctedValue: 'Posa in opera', origin: 'MANUAL', removed: false }
    ])
  })

  it('cambiando profilo, un campo ripetuto con righe del revisore resta come campo a sé', () => {
    const { r, id } = setup(['Fornitura'])
    addFieldItem(r, { documentId: id, fieldId: lines(r, id).id, value: 'Trasporto' })

    r.fields.replaceForDocument(
      id,
      [{ name: 'document.number', label: 'Numero documento', value: '1', confidence: 0.85 }],
      { keepUnmatchedCorrections: true }
    )

    const kept = lines(r, id)
    expect(kept).toMatchObject({ cardinality: 'many', role: 'optional', label: 'Righe documento' })
    expect(rows(r, id)).toEqual([
      { index: 0, value: '', correctedValue: 'Trasporto', origin: 'MANUAL', removed: false }
    ])
  })
})
