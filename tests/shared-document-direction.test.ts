import { describe, expect, it } from 'vitest'
import type { DatasetScalarField } from '../src/shared/dataset'
import { toDatasetDocument } from '../src/shared/dataset'
import {
  type CompanyIdentity,
  computeDirection,
  directionOf,
  EMPTY_COMPANY,
  foldCompanyName,
  foldIdentifier,
  isDirectionalType
} from '../src/shared/document-direction'
import type { ExtractedField } from '../src/shared/types'
import { reviewDocument, scalarField } from './helpers/review-document'

/**
 * Emesso o ricevuto.
 *
 * I dati vengono dall'export del 18/09: tutte e tre le fatture hanno come emittente
 * POLESINE MASSETTI SRLS (01479320291), e così il preventivo `e017c573` — che è il motivo
 * per cui il revisore non sapeva se tenerlo in `procurement` o in `sales_customers`.
 */

const NOI: CompanyIdentity = {
  name: 'POLESINE MASSETTI SRLS',
  vatNumber: '01479320291',
  taxCode: '01479320291'
}

const FATTURA = 'accounting.fattura'

function party(name: string, value: string, overrides: Partial<ExtractedField> = {}) {
  return scalarField({ id: `f-${name}`, name, label: name, value, role: 'core', ...overrides })
}

const compute = (fields: ExtractedField[], documentType = FATTURA, company = NOI) =>
  computeDirection({ documentType, company, fields })

describe('la direzione di un documento', () => {
  it('l’emittente è l’azienda: emessa', () => {
    expect(
      compute([
        party('issuer.vat_number', '01479320291'),
        party('recipient.vat_number', '00112233445')
      ])
    ).toEqual({ direction: 'EMESSO', matchedBy: 'FISCAL_ID' })
  })

  it('il destinatario è l’azienda: ricevuta', () => {
    expect(
      compute([
        party('issuer.vat_number', '00112233445'),
        party('recipient.vat_number', '01479320291')
      ])
    ).toEqual({ direction: 'RICEVUTO', matchedBy: 'FISCAL_ID' })
  })

  it('la partita IVA si confronta senza spazi, punti e prefisso IT', () => {
    expect(compute([party('issuer.vat_number', 'IT 01479320291')])?.direction).toBe('EMESSO')
    expect(foldIdentifier('IT01479320291')).toBe('01479320291')
    // `IT` si toglie solo davanti alle 11 cifre: un codice fiscale che comincia per IT no.
    expect(foldIdentifier('ITLMRA80A01H501U')).toBe('ITLMRA80A01H501U')
  })

  it('sulla proforma e sulla nota di credito la chiave è `tax_id`, che vale per tutti e due', () => {
    for (const documentType of ['accounting.fattura_proforma', 'accounting.nota_di_credito']) {
      expect(compute([party('issuer.tax_id', '01479320291')], documentType), documentType).toEqual({
        direction: 'EMESSO',
        matchedBy: 'FISCAL_ID'
      })
    }
  })

  it('la stessa partita IVA su tutte e due le parti non decide, ed è il conflitto della PR 1', () => {
    // Una «P.IVA» che l'etichetta non attribuisce finisce su emittente e destinatario.
    const conflict = [
      party('issuer.vat_number', '01479320291', { reviewStatus: 'CONFLICT' }),
      party('recipient.vat_number', '01479320291', { reviewStatus: 'CONFLICT' })
    ]
    expect(compute(conflict)).toBeNull()

    // Appena il revisore ne risolve una, decide l'altra: il campo resta segnato in
    // conflitto perché l'ha accettato comʼera, e questo non lo mette fuori gioco.
    const resolved = [
      party('issuer.vat_number', '01479320291', { reviewStatus: 'CONFLICT' }),
      party('recipient.vat_number', '01479320291', {
        reviewStatus: 'CONFLICT',
        correctedValue: '00112233445'
      })
    ]
    expect(compute(resolved)).toEqual({ direction: 'EMESSO', matchedBy: 'FISCAL_ID' })
  })

  it('il preventivo non ha campi fiscali: decide il nome, forma societaria a parte', () => {
    const preventivo = [party('issuer.name', 'Polesine Massetti S.r.l.s.')]
    expect(compute(preventivo, 'procurement.preventivo')).toEqual({
      direction: 'EMESSO',
      matchedBy: 'NAME'
    })
    expect(foldCompanyName('POLESINE MASSETTI SRLS')).toBe('polesine massetti')
    expect(foldCompanyName('Polesine Massetti S.r.l.s.')).toBe('polesine massetti')
    expect(foldCompanyName('Alfa S.p.A.')).toBe('alfa')
  })

  it('il nome non parla se hanno già parlato gli identificativi', () => {
    // L'azienda è il destinatario, e il nome dell'emittente le somiglia: vince il numero.
    const fields = [
      party('issuer.name', 'POLESINE MASSETTI SRLS'),
      party('issuer.vat_number', '00112233445'),
      party('recipient.vat_number', '01479320291')
    ]
    expect(compute(fields)).toEqual({ direction: 'RICEVUTO', matchedBy: 'FISCAL_ID' })
  })

  it('l’azienda da tutte e due le parti non è né emessa né ricevuta', () => {
    expect(
      compute([
        party('issuer.vat_number', '01479320291'),
        party('recipient.vat_number', '01479320291')
      ])
    ).toBeNull()
  })

  it('senza azienda, e sui tipi che una direzione non ce l’hanno, non si calcola niente', () => {
    expect(
      computeDirection({
        documentType: FATTURA,
        company: EMPTY_COMPANY,
        fields: [party('issuer.vat_number', '01479320291')]
      })
    ).toBeNull()
    expect(
      compute([party('company.vat_number', '01479320291')], 'corporate_registry.visura_camerale')
    ).toBeNull()
    expect(isDirectionalType('corporate_registry.visura_camerale')).toBe(false)
    expect(isDirectionalType(null)).toBe(false)
    expect(isDirectionalType(FATTURA)).toBe(true)
  })
})

describe('la scelta del revisore', () => {
  const state = (
    choice: Parameters<typeof directionOf>[0]['choice'],
    fields: ExtractedField[] = []
  ) => directionOf({ documentType: FATTURA, company: NOI, fields, choice })

  it('vince sul calcolo, e il calcolo resta accanto per confronto', () => {
    const chosen = state('RICEVUTO', [party('issuer.vat_number', '01479320291')])
    expect(chosen).toMatchObject({
      value: 'RICEVUTO',
      chosenBy: 'REVIEWER',
      choice: 'RICEVUTO',
      computed: { direction: 'EMESSO', matchedBy: 'FISCAL_ID' }
    })
  })

  it('«né l’una né l’altra» è una decisione, non un buco', () => {
    const none = state('NESSUNA', [party('issuer.vat_number', '01479320291')])
    expect(none).toMatchObject({ value: null, chosenBy: 'REVIEWER', choice: 'NESSUNA' })
    expect(none.computed?.direction).toBe('EMESSO')
  })

  it('senza scelta vale il calcolo', () => {
    expect(state(null, [party('issuer.vat_number', '01479320291')])).toMatchObject({
      value: 'EMESSO',
      chosenBy: 'ENGINE',
      choice: null
    })
    expect(state(null)).toMatchObject({ value: null, chosenBy: null })
  })
})

describe('la direzione nel dataset', () => {
  const exported = (overrides: Parameters<typeof reviewDocument>[0], company = NOI) =>
    toDatasetDocument({
      document: reviewDocument({ status: 'REVIEWED', ...overrides }),
      extraction: null,
      company
    })!

  it('esce col calcolo e con la scelta, come il tipo', () => {
    const document = exported({
      fields: [party('issuer.vat_number', '01479320291')],
      directionChoice: 'RICEVUTO'
    })
    expect(document.direction).toEqual({
      value: 'RICEVUTO',
      computed: 'EMESSO',
      matchedBy: 'FISCAL_ID',
      chosenBy: 'REVIEWER',
      choice: 'RICEVUTO'
    })
  })

  it('un tipo senza direzione non porta la proprietà, uno che ce l’ha la porta anche vuota', () => {
    expect(exported({ documentType: 'corporate_registry.visura_camerale' }).direction).toBeNull()
    expect(exported({ fields: [] }).direction).toEqual({
      value: null,
      computed: null,
      matchedBy: null,
      chosenBy: null,
      choice: null
    })
  })

  it('i campi restano quelli di sempre: la direzione non è un campo', () => {
    const document = exported({ fields: [party('issuer.vat_number', '01479320291')] })
    const [field] = document.fields as DatasetScalarField[]
    expect(field?.name).toBe('issuer.vat_number')
    expect(document.fields).toHaveLength(1)
  })
})
