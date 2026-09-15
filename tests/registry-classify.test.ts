import { describe, expect, it } from 'vitest'
import { normalize } from '../src/main/registry'
import { matchDocumentType } from '../src/main/registry/classify'
import { testRegistry } from './helpers/registry'

const registry = testRegistry()
const aliases = registry.aliases()

describe('snapshot del registry', () => {
  it('espone i 511 tipi con etichetta e famiglia', () => {
    const types = registry.types()
    expect(types).toHaveLength(511)
    expect(types.every((type) => type.label.length > 0 && type.family.length > 0)).toBe(true)
  })

  it('restituisce i campi e i required dello schema del tipo', () => {
    expect(registry.fieldsFor('accounting.fattura')).toEqual([
      'document_number',
      'issue_date',
      'issuer_name',
      'recipient_name',
      'taxable_amount',
      'tax_amount',
      'total_amount',
      'currency'
    ])
    expect(registry.requiredFor('accounting.fattura')).toEqual(['document_number', 'issue_date'])
    expect(registry.label('accounting.fattura')).toBe('fattura')
  })

  it('su un tipo sconosciuto non inventa nulla', () => {
    expect(registry.has('non.esiste')).toBe(false)
    expect(registry.fieldsFor('non.esiste')).toEqual([])
    expect(registry.requiredFor(null)).toEqual([])
    expect(registry.label(null)).toBeNull()
  })

  it('normalizza collassando spazi e punteggiatura', () => {
    expect(normalize('  FATTURA  n.  114 ')).toBe('fattura n 114')
  })
})

describe('classificazione deterministica', () => {
  it('assegna 0,90 a un alias trovato in prima pagina', () => {
    const match = matchDocumentType(
      aliases,
      'ALFA S.R.L.\nFATTURA n. 114/2026 del 08/09/2026',
      'documento.pdf'
    )
    expect(match).toMatchObject({
      documentType: 'accounting.fattura',
      confidence: 0.9,
      source: 'first-page'
    })
  })

  it('un match solo nel nome del file vale 0,70 e resta sotto la soglia', () => {
    // Scelta dei punteggi: il nome di un file è un indizio, non una prova. Con 0,70
    // contro una soglia di 0,75 il documento resta da classificare a mano.
    expect(matchDocumentType(aliases, 'testo senza indizi utili', 'Fattura 114.pdf')).toBeNull()
  })

  it('la prima pagina vince sul nome del file', () => {
    const match = matchDocumentType(aliases, 'DURC rilasciato da INPS', 'Fattura 114.pdf')
    expect(match?.documentType).toBe('payroll_contributions.durc')
    expect(match?.confidence).toBe(0.9)
  })

  it('a parità di punteggio vince l alias più lungo', () => {
    const match = matchDocumentType(aliases, 'CONTRATTO CONSULENZA tra le parti', 'doc.pdf')
    expect(match?.documentType).toBe('contracts_general.contratto_consulenza')
    expect(match?.phrase).toBe('contratto consulenza')
  })

  it('sotto la soglia di 0,75 non assegna nessun tipo', () => {
    expect(
      matchDocumentType(aliases, 'testo generico senza titolo', 'scansione_2026.pdf')
    ).toBeNull()
  })

  it('cerca parole intere: «fattura» non corrisponde dentro «fatturato»', () => {
    expect(matchDocumentType(aliases, 'il fatturato annuo della societa', 'doc.pdf')).toBeNull()
  })
})
