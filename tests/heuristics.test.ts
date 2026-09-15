import { FIELD_SEMANTIC_TYPES } from '@shared/fields'
import { describe, expect, it } from 'vitest'
import {
  CONFIDENCE_REGEX_ONLY,
  CONFIDENCE_WITH_CONTEXT,
  FIELD_SPECS,
  findDate,
  findLabeledValue,
  findMoney,
  findNumber,
  findTaxCode,
  fold,
  parseMoney,
  prefillFields
} from '../src/main/extract/heuristics'
import type { ExtractedPage } from '../src/main/extract/types'

function page(lines: string[], number = 1): ExtractedPage {
  return { page: number, text: lines.join('\n'), lines: lines.map((text) => ({ text })) }
}

describe('normalizzazione per le keyword', () => {
  it('toglie accenti, maiuscole e punteggiatura', () => {
    expect(fold('Finalità del trattamento:')).toBe('finalita del trattamento')
    expect(fold('  P.  IVA  ')).toBe('p iva')
  })
})

describe('date', () => {
  it.each([
    ['del 08/09/2026', '2026-09-08'],
    ['gg 8-9-2026', '2026-09-08'],
    ['8.9.2026', '2026-09-08'],
    ['2026-09-08', '2026-09-08'],
    ['scadenza 30/09/26', '2026-09-30'],
    ['del 01/12/1999', '1999-12-01']
  ])('%s -> %s', (input, expected) => {
    expect(findDate(input)?.value).toBe(expected)
  })

  it('scarta date che non esistono', () => {
    expect(findDate('31/02/2026')).toBeNull()
    expect(findDate('45/13/2026')).toBeNull()
  })

  it('non confonde un numero di documento con una data', () => {
    expect(findDate('Fattura n. 114/2026')).toBeNull()
  })
})

describe('importi', () => {
  it.each([
    ['€ 12.840,50', '12840.50'],
    ['12.840,50 EUR', '12840.50'],
    ['1.234,56', '1234.56'],
    ['1,234.56', '1234.56'],
    ['86.420,00', '86420.00'],
    ['€ 9,90', '9.90'],
    ['EUR 24.000,00', '24000.00']
  ])('%s -> %s', (input, expected) => {
    expect(findMoney(input)?.value).toBe(expected)
  })

  it('non prende per importo un numero nudo', () => {
    expect(findMoney('periodo di imposta 2026')).toBeNull()
    expect(findMoney('protocollo 554321')).toBeNull()
  })

  it('prende il numero nudo solo se accompagnato dalla valuta', () => {
    expect(findMoney('importo 150 EUR')?.value).toBe('150.00')
  })

  it('normalizza a due decimali con il punto', () => {
    expect(parseMoney('7,5')).toBe('7.50')
    expect(parseMoney('1.000')).toBe('1000.00')
    expect(parseMoney('abc')).toBeNull()
  })
})

describe('identificativi', () => {
  it('riconosce un codice fiscale senza bisogno di contesto', () => {
    expect(findTaxCode('RSSMRA80A01H501U', false)?.value).toBe('RSSMRA80A01H501U')
  })

  it('accetta una partita IVA nuda solo con una keyword di contesto', () => {
    expect(findTaxCode('01234567890', false)).toBeNull()
    expect(findTaxCode('01234567890', true)?.value).toBe('01234567890')
  })

  it('legge numero di documento e di protocollo', () => {
    expect(findNumber('FATTURA n. 114/2026 del 08/09/2026')?.value).toBe('114/2026')
    expect(findNumber('Prot. n. 2026/554321')?.value).toBe('2026/554321')
    expect(findNumber('Documento n. CC-2026-018')?.value).toBe('CC-2026-018')
  })

  it('non apre un numero sulla n di una parola qualsiasi', () => {
    expect(findNumber('Contratto di consulenza')).toBeNull()
    expect(findNumber('Nessun numero qui')).toBeNull()
  })

  it('legge il valore che segue la propria etichetta, non i primi due punti', () => {
    expect(findLabeledValue('Fattura n. 114 - Cliente: Alfa S.r.l.', 'cliente')).toBe('Alfa S.r.l.')
    expect(findLabeledValue('Emittente: Alfa S.r.l.', 'emittente')).toBe('Alfa S.r.l.')
    expect(findLabeledValue('Emittente Alfa S.r.l.', 'emittente')).toBeNull()
  })
})

describe('precompilazione', () => {
  const fattura = [
    page([
      'ALFA S.R.L.',
      'FATTURA n. 114/2026 del 08/09/2026',
      'Emittente: Alfa S.r.l.',
      'Destinatario: Beta Costruzioni S.p.A.',
      'Valuta: EUR',
      'Totale imponibile EUR 70.836,07',
      'IVA 22% EUR 15.583,93',
      'Totale documento EUR 86.420,00'
    ])
  ]

  it('riempie i campi dichiarati dal tipo con evidenza verbatim', () => {
    const candidates = prefillFields({
      fields: [
        'document_number',
        'issue_date',
        'issuer_name',
        'recipient_name',
        'taxable_amount',
        'tax_amount',
        'total_amount',
        'currency'
      ],
      pages: fattura,
      fromOcr: false
    })

    const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]))
    expect(byName.get('document_number')?.value).toBe('114/2026')
    expect(byName.get('issue_date')?.value).toBe('2026-09-08')
    expect(byName.get('issuer_name')?.value).toBe('Alfa S.r.l.')
    expect(byName.get('recipient_name')?.value).toBe('Beta Costruzioni S.p.A.')
    expect(byName.get('currency')?.value).toBe('EUR')
    expect(byName.get('taxable_amount')?.value).toBe('70836.07')
    expect(byName.get('tax_amount')?.value).toBe('15583.93')
    expect(byName.get('total_amount')?.value).toBe('86420.00')

    for (const candidate of candidates) {
      expect(candidate.evidence.text.length).toBeGreaterThan(0)
      expect(candidate.evidence.page).toBe(1)
    }
  })

  it('la keyword più lunga vince: l imponibile non finisce nel totale', () => {
    const candidates = prefillFields({
      fields: ['taxable_amount', 'total_amount'],
      pages: fattura,
      fromOcr: false
    })
    const byName = new Map(candidates.map((c) => [c.name, c]))
    expect(byName.get('taxable_amount')?.evidence.text).toContain('Totale imponibile')
    expect(byName.get('total_amount')?.evidence.text).toContain('Totale documento')
  })

  it('un campo senza evidenza resta fuori dai candidati', () => {
    const candidates = prefillFields({
      fields: ['policy_number', 'premium_amount'],
      pages: fattura,
      fromOcr: false
    })
    expect(candidates).toEqual([])
  })

  it('assegna 0,85 con keyword di contesto e 0,70 col solo pattern', () => {
    const withContext = prefillFields({
      fields: ['issue_date'],
      pages: fattura,
      fromOcr: false
    })
    expect(withContext[0]?.confidence).toBe(CONFIDENCE_WITH_CONTEXT)

    const regexOnly = prefillFields({
      fields: ['issue_date'],
      pages: [page(['Documento emesso in data odierna', '08/09/2026'])],
      fromOcr: false
    })
    expect(regexOnly[0]?.confidence).toBe(CONFIDENCE_REGEX_ONLY)
  })

  it('toglie 0,10 di confidence quando il testo viene da OCR', () => {
    const candidates = prefillFields({ fields: ['issue_date'], pages: fattura, fromOcr: true })
    expect(candidates[0]?.confidence).toBe(0.75)
  })

  it('porta con sé il bbox quando il text layer lo espone', () => {
    const candidates = prefillFields({
      fields: ['issue_date'],
      pages: [
        {
          page: 1,
          text: 'del 08/09/2026',
          lines: [{ text: 'del 08/09/2026', bbox: { x: 56, y: 111, w: 188, h: 11 } }]
        }
      ],
      fromOcr: false
    })
    expect(candidates[0]?.evidence.bbox).toEqual({ x: 56, y: 111, w: 188, h: 11 })
  })

  it('cerca anche oltre la prima pagina', () => {
    const candidates = prefillFields({
      fields: ['total_amount'],
      pages: [page(['Descrizione lavori']), page(['Totale documento EUR 86.420,00'], 2)],
      fromOcr: false
    })
    expect(candidates[0]?.evidence.page).toBe(2)
  })
})

describe('copertura del closed set', () => {
  it('ogni campo del registry ha le proprie keyword di contesto', () => {
    expect(Object.keys(FIELD_SPECS).sort()).toEqual(Object.keys(FIELD_SEMANTIC_TYPES).sort())
    for (const [name, spec] of Object.entries(FIELD_SPECS)) {
      expect(spec.keywords.length, `${name} senza keyword`).toBeGreaterThan(0)
      for (const keyword of spec.keywords) {
        expect(fold(keyword), `keyword «${keyword}» non normalizzata`).toBe(keyword)
      }
    }
  })
})
