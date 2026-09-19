import { describe, expect, it } from 'vitest'
import { fold, prefillFields } from '../src/main/extract/heuristics'
import {
  mentionsReference,
  precededByReference,
  readsReferences
} from '../src/main/extract/reference-context'
import type { ExtractedPage } from '../src/main/extract/types'

/**
 * Le righe di questo file sono verbatim dai documenti dell'export del 18/09/2026, prese
 * dall'evidenza delle correzioni `CHANGED` su `document.number` e `document.issue_date`.
 * Erano due terzi degli errori di valore del motore.
 */

/** Dove cade la keyword nel testo ripiegato, con lo spazio davanti come lo cercano i lettori. */
function at(line: string, keyword: string): number {
  return ` ${fold(line)} `.indexOf(` ${keyword} `)
}

/** La citazione vista da unʼetichetta: dove cade, e lʼetichetta stessa. */
function cites(line: string, keyword: string): boolean {
  return precededByReference(fold(line), at(line, keyword), keyword)
}

describe('etichetta dentro una citazione', () => {
  it('la norma citata, prima dellʼetichetta', () => {
    expect(cites('(ai sensi del D.Lgs. 9 aprile 2008, n. 81 e s.m.i.)', 'n')).toBe(true)
    expect(
      cites('garanzia RC Auto (art. 17 del Decreto Legislativo n. 68 del 6/5/2011).', 'n')
    ).toBe(true)
  })

  it('la norma citata, dopo lʼetichetta', () => {
    // «del» apre la citazione invece di chiuderla: guardare solo indietro non basta.
    expect(cites('(ai sensi del D.Lgs. 9 aprile 2008, n. 81 e s.m.i.)', 'del')).toBe(true)
    expect(cites('Visti gli artt. 1-5-6-7 del Nuovo Codice della Strada', 'del')).toBe(true)
  })

  it('i marcatori di indirizzo contano solo indietro', () => {
    expect(cites('Via G. Carducci, N. 1551 CEREGNANO (RO)', 'n')).toBe(true)
    // Un indirizzo che segue non dice niente della data che lo precede.
    expect(cites('Data emissione: 12/09/2026 — Via Roma 5', 'data emissione')).toBe(false)
  })

  it('il rimando a un altro documento', () => {
    expect(cites('pratica con atto del 06/03/2017 Data deposito: 21/03/2017', 'del')).toBe(true)
    expect(cites('Rif.to Ns. Offerta n.3260/26 del 16/06/2026', 'n')).toBe(true)
    expect(cites('Riferim. fattura n. 12 del 01/09/2026', 'n')).toBe(true)
    expect(cites('Riferimento fattura n. 12 del 01/09/2026', 'n')).toBe(true)
  })

  it('unʼetichetta che non viene da una citazione passa', () => {
    expect(cites('FATTURA n. 114/2026 del 08/09/2026', 'n')).toBe(false)
    expect(cites('FATTURA n. 114/2026 del 08/09/2026', 'del')).toBe(false)
    expect(cites('Emesso del 16/12/2025', 'del')).toBe(false)
  })

  it('la finestra è di tre parole di lettere: i numeri della citazione non la consumano', () => {
    // Fra «artt» e lʼetichetta ci sono quattro numeri, e la finestra deve arrivarci lo stesso.
    expect(cites('Visti gli artt. 1-5-6-7 del provvedimento', 'del')).toBe(true)
    // Quattro parole di lettere più in là, la citazione è finita.
    expect(
      cites(
        'Visti gli artt. 1-5-6-7 del Nuovo Codice della Strada, emesso del 22/09/2022',
        'emesso del'
      )
    ).toBe(false)
  })
})

describe('la riga cita, dovunque', () => {
  it('riconosce la citazione senza unʼetichetta su cui ancorarsi', () => {
    expect(mentionsReference(fold('(ai sensi del D.Lgs. 9 aprile 2008, n. 81)'))).toBe(true)
    expect(mentionsReference(fold('Via G. Carducci, N. 1551 CEREGNANO (RO)'))).toBe(true)
    expect(mentionsReference(fold('FATTURA n. 114/2026 del 08/09/2026'))).toBe(false)
  })
})

describe('i campi che citano di mestiere', () => {
  it('un campo chiamato «Riferimento normativo» legge le citazioni, ed è il suo valore', () => {
    expect(readsReferences([fold('Riferimento normativo')])).toBe(true)
    expect(readsReferences([fold('Estremi dellʼatto')])).toBe(true)
    expect(readsReferences([fold('Numero documento'), fold('Numero')])).toBe(false)
    expect(readsReferences([fold('Data emissione')])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Il lettore v1, che ha anche il ripiego «prima data della prima pagina»
// ---------------------------------------------------------------------------

function pagesOf(...texts: string[]): ExtractedPage[] {
  return [
    {
      page: 1,
      text: texts.join('\n'),
      lines: texts.map((text, index) => ({
        text,
        bbox: { x: 10, y: 10 + index * 12, w: 300, h: 11 }
      }))
    }
  ]
}

const prefill = (name: 'issue_date' | 'document_number', ...texts: string[]) =>
  prefillFields({ fields: [name], pages: pagesOf(...texts), ocrPages: [] })[0] ?? null

describe('precompilazione v1', () => {
  it('non prende la data del decreto citato', () => {
    expect(
      prefill('issue_date', 'ATTESTATO DI FORMAZIONE', '(ai sensi del D.Lgs. 9 aprile 2008, n. 81)')
    ).toBeNull()
  })

  it('non prende il civico come numero del documento', () => {
    expect(
      prefill(
        'document_number',
        'POLESINE MASSETTI SRLS',
        'Via G. Carducci, N. 1551 CEREGNANO (RO)'
      )
    ).toBeNull()
  })

  it('non prende la data dellʼatto a cui il documento rimanda', () => {
    expect(prefill('issue_date', 'VISURA', 'pratica con atto del 06/03/2017')).toBeNull()
  })

  it('il ripiego non pesca dentro una citazione', () => {
    // Nessuna keyword: senza il filtro il ripiego prendeva la prima data della pagina.
    expect(prefill('issue_date', 'CARTA DI IDENTITA', 'KUCOVE (ALB) art. 3 23.01.1982')).toBeNull()
  })

  it('quello che è del documento continua a leggersi', () => {
    expect(prefill('issue_date', 'FATTURA n. 114/2026 del 08/09/2026')).toMatchObject({
      name: 'issue_date',
      value: '2026-09-08'
    })
    expect(prefill('document_number', 'FATTURA n. 114/2026 del 08/09/2026')).toMatchObject({
      name: 'document_number',
      value: '114/2026'
    })
  })

  it('la riga buona vince anche se il documento ne cita unʼaltra prima', () => {
    expect(
      prefill(
        'issue_date',
        '(ai sensi del D.Lgs. 9 aprile 2008, n. 81)',
        'Data emissione: 16/12/2025'
      )
    ).toMatchObject({ value: '2025-12-16' })
  })
})
