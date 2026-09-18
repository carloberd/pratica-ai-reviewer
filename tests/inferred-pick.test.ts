import { describe, expect, it } from 'vitest'
import type { PageInput } from '../src/main/db/dao/pages'
import { inferExactValuePick, valueVariants } from '../src/main/inferred-pick'

const page = (...lines: string[]): PageInput => ({
  page: 1,
  textSource: 'NATIVE_TEXT',
  lines: lines.map((text) => ({ text }))
})

const pages = (...lines: string[]): PageInput[] => [page(...lines)]

describe('il valore digitato ritrovato sul documento', () => {
  it('ritrova una data salvata in forma canonica nella forma che aveva sul documento', () => {
    expect(inferExactValuePick(pages('Data documento: 12/09/2026'), '2026-09-12')).toEqual({
      method: 'EXACT_VALUE_MATCH',
      page: 1,
      bbox: null,
      location: { lineStart: 0, lineEnd: 0, charStart: 16, charEnd: 26 }
    })
  })

  it('conta gli offset sulla pagina intera, come una selezione vera', () => {
    expect(
      inferExactValuePick(pages('Documento', 'Data contabile: 12/09/2026'), '2026-09-12')
    ).toMatchObject({
      location: { lineStart: 1, lineEnd: 1, charStart: 26, charEnd: 36 }
    })
  })

  it('ritrova un importo scritto con la virgola e le migliaia', () => {
    expect(inferExactValuePick(pages('Totale documento 1.250,00 euro'), '1250.00')).toMatchObject({
      location: { charStart: 17, charEnd: 25 }
    })
  })

  it('ritrova un IBAN a gruppi di quattro quando il revisore lo digita tutto attaccato', () => {
    expect(
      inferExactValuePick(
        pages('IBAN: IT60 X054 2811 1010 0000 0123 456'),
        'IT60X0542811101000000123456'
      )
    ).toMatchObject({ location: { charStart: 6, charEnd: 39 } })
  })

  it('porta il bbox della riga, che è tutto quello che si sa del punto', () => {
    const bbox = { x: 0.1, y: 0.2, w: 0.3, h: 0.04 }
    const withBox: PageInput[] = [
      { page: 2, textSource: 'OCR', lines: [{ text: 'Data documento: 12/09/2026', bbox }] }
    ]
    expect(inferExactValuePick(withBox, '2026-09-12')).toMatchObject({ page: 2, bbox })
  })

  it('non si aggancia a un pezzo di un numero più lungo', () => {
    expect(inferExactValuePick(pages('Totale documento 11.250,00 euro'), '1250.00')).toBeNull()
  })

  it('rinuncia quando lo stesso valore compare due volte sulla stessa pagina', () => {
    expect(inferExactValuePick(pages('Totale 10,50', 'Imponibile 10,50'), '10.50')).toBeNull()
  })

  it('rinuncia anche quando le due occorrenze stanno su pagine diverse', () => {
    expect(
      inferExactValuePick(
        [page('Totale 1.250,00'), { ...page('Riepilogo: 1250,00'), page: 2 }],
        '1250.00'
      )
    ).toBeNull()
  })

  it('rinuncia su un valore troppo corto perché l unicità voglia dire qualcosa', () => {
    expect(inferExactValuePick(pages('Colli 7'), '7')).toBeNull()
  })

  it('rinuncia quando il valore sul documento non c è', () => {
    expect(inferExactValuePick(pages('Data documento: 12/09/2026'), 'Alfa S.r.l.')).toBeNull()
  })

  it('ignora le differenze di maiuscole ma non quelle di sostanza', () => {
    expect(inferExactValuePick(pages('Beneficiario: ALFA S.R.L.'), 'Alfa S.r.l.')).toMatchObject({
      location: { charStart: 14, charEnd: 25 }
    })
    expect(inferExactValuePick(pages('Beneficiario: ALFA SPA'), 'Alfa S.r.l.')).toBeNull()
  })
})

describe('le forme verbatim di un valore normalizzato', () => {
  it('riscrive una data canonica nei modi in cui si scrive in italiano', () => {
    expect(valueVariants('2026-09-05')).toEqual([
      '2026-09-05',
      '05/09/2026',
      '05-09-2026',
      '05.09.2026',
      '5/9/2026'
    ])
  })

  it('riscrive un importo con la virgola, con e senza migliaia', () => {
    expect(valueVariants('1250.00')).toEqual(['1.250,00', '1250.00', '1250,00'])
  })

  it('riscrive un IBAN nelle due punteggiature che si usano', () => {
    expect(valueVariants('IT60X0542811101000000123456')).toEqual([
      'IT60 X054 2811 1010 0000 0123 456',
      'IT60X0542811101000000123456'
    ])
  })

  it('non inventa niente su un valore che non ha una forma nota', () => {
    expect(valueVariants('Alfa S.r.l.')).toEqual(['Alfa S.r.l.'])
  })

  it('non propone niente per un valore vuoto o troppo corto', () => {
    expect(valueVariants('   ')).toEqual([])
    expect(valueVariants('12')).toEqual([])
  })
})
