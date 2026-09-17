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

describe('valori presi dal documento', () => {
  /** Le righe salvate dall'elaborazione per la prima pagina. */
  const PAGE = [
    { text: 'FATTURA n. 114/2026 del 08/09/2026', bbox: { x: 56, y: 111, w: 187.71, h: 11 } },
    { text: 'Fornitura materiali edili 70.836,07', bbox: { x: 56, y: 271, w: 193.81, h: 11 } }
  ]

  function withPages() {
    const context = setup()
    context.r.pages.replaceForDocument(context.id, [
      { page: 1, textSource: 'NATIVE_TEXT', lines: PAGE }
    ])
    return context
  }

  const selection = (text: string, bbox = { x: 100, y: 111, w: 45, h: 11 }) => ({
    method: 'TEXT_SELECTION' as const,
    page: 1,
    text,
    bbox
  })

  const number = (r: NonNullable<typeof repo>, id: string) => r.getReviewDocument(id)!.fields[0]!
  const evidenceOf = (r: NonNullable<typeof repo>, id: string, evidenceId: string | undefined) =>
    r.getReviewDocument(id)!.evidence.find((item) => item.id === evidenceId)

  it('la selezione diventa un’evidenza del revisore, ritrovata fra le righe salvate', () => {
    const { r, id } = withPages()
    updateFieldValue(r, {
      documentId: id,
      fieldId: number(r, id).id,
      correctedValue: '08/09/2026',
      pick: selection('08/09/2026', { x: 188, y: 111, w: 55, h: 11 })
    })

    const field = number(r, id)
    expect(field.correctedValue).toBe('08/09/2026')
    expect(evidenceOf(r, id, field.correctedEvidenceId)).toMatchObject({
      origin: 'REVIEWER',
      method: 'TEXT_SELECTION',
      page: 1,
      text: '08/09/2026',
      bbox: { x: 188, y: 111, w: 55, h: 11 },
      location: { lineStart: 0, lineEnd: 0, charStart: 24, charEnd: 34 }
    })
  })

  it('il testo selezionato resta verbatim, il valore è quello con gli spazi ripiegati', () => {
    const { r, id } = withPages()
    updateFieldValue(r, {
      documentId: id,
      fieldId: number(r, id).id,
      correctedValue: 'n. 114/2026',
      pick: selection('n.\n 114/2026')
    })
    const field = number(r, id)
    expect(evidenceOf(r, id, field.correctedEvidenceId)).toMatchObject({
      text: 'n.\n 114/2026',
      location: { charStart: 8, charEnd: 19 }
    })
  })

  it('riscritto a mano, il valore perde la selezione e l’evidenza sparisce', () => {
    const { r, id } = withPages()
    const fieldId = number(r, id).id
    updateFieldValue(r, {
      documentId: id,
      fieldId,
      correctedValue: '08/09/2026',
      pick: selection('08/09/2026')
    })
    updateFieldValue(r, { documentId: id, fieldId, correctedValue: '09/09/2026' })

    expect(number(r, id).correctedEvidenceId).toBeUndefined()
    expect(r.evidence.listForDocument(id).filter((row) => row.origin === 'REVIEWER')).toEqual([])
  })

  it('una selezione che non è il valore salvato non vale come origine', () => {
    const { r, id } = withPages()
    updateFieldValue(r, {
      documentId: id,
      fieldId: number(r, id).id,
      correctedValue: '114/2026-bis',
      pick: selection('114/2026')
    })
    expect(number(r, id)).toMatchObject({ correctedValue: '114/2026-bis' })
    expect(number(r, id).correctedEvidenceId).toBeUndefined()
    expect(r.evidence.listForDocument(id).filter((row) => row.origin === 'REVIEWER')).toEqual([])
  })

  it('selezionare la proposta non è una correzione, e non lascia evidenze', () => {
    const { r, id } = withPages()
    updateFieldValue(r, {
      documentId: id,
      fieldId: number(r, id).id,
      correctedValue: '114/2026',
      pick: selection('114/2026')
    })
    expect(number(r, id).correctedValue).toBeUndefined()
    expect(r.evidence.listForDocument(id).filter((row) => row.origin === 'REVIEWER')).toEqual([])
  })

  it('senza righe salvate la selezione si registra lo stesso, senza posizione', () => {
    const { r, id } = setup()
    updateFieldValue(r, {
      documentId: id,
      fieldId: number(r, id).id,
      correctedValue: '08/09/2026',
      pick: selection('08/09/2026')
    })
    const evidence = evidenceOf(r, id, number(r, id).correctedEvidenceId)
    expect(evidence).toMatchObject({ origin: 'REVIEWER', page: 1 })
    expect(evidence?.location).toBeUndefined()
  })

  it('righe: selezionata, aggiunta, poi tolta o tornata alla proposta', () => {
    const { r, id } = withPages()
    const area = {
      method: 'AREA_OCR' as const,
      page: 1,
      text: 'Fornitura materiali edili',
      bbox: { x: 50, y: 265, w: 140, h: 20 }
    }
    const [first] = lines(r, id).items
    updateFieldItem(r, {
      documentId: id,
      itemId: first!.id,
      correctedValue: 'Fornitura materiali edili 70.836,07',
      pick: selection('Fornitura materiali edili 70.836,07', { x: 56, y: 271, w: 193.81, h: 11 })
    })
    addFieldItem(r, {
      documentId: id,
      fieldId: lines(r, id).id,
      value: 'Fornitura materiali edili',
      pick: area
    })

    const [corrected, , added] = lines(r, id).items
    expect(evidenceOf(r, id, corrected!.correctedEvidenceId)).toMatchObject({
      label: 'Righe documento · riga 1 · selezionato dal revisore',
      location: { lineStart: 1, lineEnd: 1, charStart: 35, charEnd: 70 }
    })
    expect(evidenceOf(r, id, added!.correctedEvidenceId)).toMatchObject({
      method: 'AREA_OCR',
      location: { lineStart: 1, lineEnd: 1, charStart: 35, charEnd: 60 }
    })

    updateFieldItem(r, { documentId: id, itemId: corrected!.id, correctedValue: null })
    setFieldItemRemoved(r, { documentId: id, itemId: added!.id, removed: true })

    expect(lines(r, id).items.every((item) => item.correctedEvidenceId === undefined)).toBe(true)
    expect(r.evidence.listForDocument(id).filter((row) => row.origin === 'REVIEWER')).toEqual([])
  })
})
