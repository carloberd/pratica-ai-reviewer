import { describe, expect, it } from 'vitest'
import ExtractionFields, { ConfirmEdit } from '../../src/renderer/src/components/extraction-fields'
import type { ProfileAction } from '../../src/shared/profile-history'
import type { ProfileFieldMeasure, ProfileTypeMeasure } from '../../src/shared/profile-metrics'
import type { TypeFieldMap } from '../../src/shared/profile-workspace'
import { count, html, text } from './render'

/**
 * La scheda «Campi da estrarre» della revisione: deve essere leggibile da chi non ha
 * scritto il codice, e stare in una colonna stretta. Qui si verificano le parole, i numeri
 * e gli attributi `data-*` a schermo.
 */

function fieldMeasure(overrides: Partial<ProfileFieldMeasure> = {}): ProfileFieldMeasure {
  const base: ProfileFieldMeasure = {
    fieldId: 'document.issue_date',
    label: 'Data emissione',
    note: null,
    role: 'required',
    inProfile: true,
    confirmed: 12,
    corrected: 0,
    manual: 0,
    empty: 0,
    filled: 12,
    documents: 12,
    confirmedRate: 1,
    correctedRate: 0,
    manualRate: 0,
    signal: 'OK',
    decision: null,
    cardinality: 'one',
    cardinalityDecision: null
  }
  return { ...base, ...overrides }
}

const NEVER_USED = fieldMeasure({
  fieldId: 'document.number',
  label: 'Numero documento',
  role: 'optional',
  confirmed: 0,
  filled: 0,
  empty: 12,
  confirmedRate: 0,
  signal: 'NEVER_USED'
})

const MISSING = fieldMeasure({
  fieldId: 'bank.iban',
  label: 'IBAN',
  role: null,
  inProfile: false,
  confirmed: 0,
  manual: 9,
  filled: 9,
  empty: 3,
  confirmedRate: 0,
  manualRate: 0.75,
  signal: 'MISSING_FROM_PROFILE'
})

function measure(overrides: Partial<ProfileTypeMeasure> = {}): ProfileTypeMeasure {
  return {
    documentType: 'accounting.fattura',
    label: 'fattura',
    profileOrigin: 'EXPLICIT',
    schemaState: 'EXTRACTION_SCHEMA_DRAFT',
    fieldTested: false,
    totals: {
      documents: 12,
      confirmed: 12,
      corrected: 3,
      manual: 9,
      outcomes: 24,
      confirmedRate: 0.5,
      correctedRate: 0.125,
      manualRate: 0.375
    },
    fields: [fieldMeasure(), NEVER_USED, MISSING],
    documents: [
      {
        documentId: 'doc-1',
        driveFileId: 'drive-1',
        filename: 'Fattura 114.pdf',
        reviewedAt: '2026-09-16T10:00:00.000Z',
        confirmed: 2,
        corrected: 0,
        manual: 1
      }
    ],
    ...overrides
  }
}

const ONTOLOGY = [
  { id: 'bank.iban', label: 'IBAN', hint: 'bank.iban' },
  { id: 'procurement.cig', label: 'CIG', hint: 'procurement.cig · Codice gara' }
]

function fieldMap(overrides: Partial<TypeFieldMap> = {}): TypeFieldMap {
  return {
    documentType: 'accounting.fattura',
    measure: measure(),
    editable: true,
    ontology: ONTOLOGY,
    undoable: [],
    ...overrides
  }
}

const props = {
  documentType: 'accounting.fattura',
  busy: false,
  onEdit: () => {},
  onRevert: () => {},
  onShowData: () => {}
}

describe('scheda «Campi da estrarre»', () => {
  it('dice che la correzione vale per tutto il tipo e che il documento si rielabora', () => {
    const view = text(<ExtractionFields {...props} map={fieldMap()} />)
    expect(view).toContain('Le modifiche valgono per tutti i documenti di questo tipo')
    expect(view).toContain('torna a «Dati» per completarlo')
    expect(view).toContain('Numeri su 12 documenti revisionati')
  })

  it('un campo che su questo tipo vuol dire qualcosa di preciso lo dice nella scheda', () => {
    const iban = fieldMeasure({
      fieldId: 'bank.iban',
      label: 'IBAN',
      role: 'optional',
      note: 'IBAN del beneficiario, non il conto da cui parte il bonifico'
    })
    const view = text(
      <ExtractionFields {...props} map={fieldMap({ measure: measure({ fields: [iban] }) })} />
    )
    expect(view).toContain('IBAN del beneficiario, non il conto da cui parte il bonifico')
  })

  it('non ha pulsanti di export: la mappa si esporta dalla dashboard', () => {
    const view = text(<ExtractionFields {...props} map={fieldMap()} />)
    expect(view).not.toContain('Report JSON')
    expect(view).not.toContain('Report CSV')
    expect(view).not.toContain('Esporta')
    expect(view).not.toContain('Rielabora')
  })

  it('ogni campo della mappa ha il peso, i numeri in una riga e le azioni', () => {
    const markup = html(<ExtractionFields {...props} map={fieldMap()} />)
    const view = text(<ExtractionFields {...props} map={fieldMap()} />)
    expect(count(markup, 'aria-label="Peso di ')).toBe(2)
    expect(view).toContain('12 confermati · 0 corretti · 0 a mano su 12')
    expect(count(view, 'Aggiungi etichetta')).toBe(2)
    expect(count(view, 'Segna non utile')).toBe(2)
  })

  it('ogni campo della mappa dice se chiede un solo valore o più valori, e si cambia da lì', () => {
    const many = fieldMeasure({
      fieldId: 'bank.iban',
      label: 'IBAN',
      role: 'optional',
      cardinality: 'many',
      cardinalityDecision: 'many'
    })
    const map = fieldMap({ measure: measure({ fields: [fieldMeasure(), many] }) })
    const markup = html(<ExtractionFields {...props} map={map} />)

    expect(count(markup, 'aria-label="Quanti valori per ')).toBe(2)
    expect(markup).toContain('data-cardinality="one"')
    expect(markup).toContain('data-cardinality="many"')
    expect(markup).toContain('<option value="many" selected="">più valori</option>')
    expect(markup).toContain('<option value="one" selected="">un solo valore</option>')
    // Solo la decisione presa qui è marcata: l'altro campo segue l'ontologia.
    expect(count(text(<ExtractionFields {...props} map={map} />), 'modificato')).toBe(1)
  })

  it('il campo mai usato è segnalato col numero di documenti', () => {
    const markup = html(<ExtractionFields {...props} map={fieldMap()} />)
    const view = text(<ExtractionFields {...props} map={fieldMap()} />)
    expect(markup).toContain('data-field="document.number" data-signal="NEVER_USED"')
    expect(view).toContain('Mai valorizzato su 12 documenti revisionati')
  })

  it('il campo che il revisore compila sempre è proposto per l’aggiunta, con quante volte', () => {
    const markup = html(<ExtractionFields {...props} map={fieldMap()} />)
    const view = text(<ExtractionFields {...props} map={fieldMap()} />)
    expect(markup).toContain('data-field="bank.iban" data-signal="MISSING_FROM_PROFILE"')
    expect(view).toContain('Compilati a mano, fuori dalla mappa')
    expect(view).toContain('Compilato su 9 di 12 documenti')
  })

  it('i campi scartati restano visibili, con il modo di rimetterli', () => {
    const excluded = fieldMeasure({
      fieldId: 'procurement.cig',
      label: 'CIG',
      role: null,
      inProfile: false,
      confirmed: 0,
      filled: 0,
      empty: 12,
      confirmedRate: 0,
      signal: 'EXCLUDED',
      decision: 'excluded'
    })
    const view = text(
      <ExtractionFields {...props} map={fieldMap({ measure: measure({ fields: [excluded] }) })} />
    )
    expect(view).toContain('Segnati non utili')
    expect(view).toContain('CIG')
    expect(view).toContain('Ripristina')
  })

  it('si può aggiungere un campo qualsiasi dell’ontologia, non solo quelli già visti', () => {
    const view = text(<ExtractionFields {...props} map={fieldMap()} />)
    expect(view).toContain('Aggiungi un campo')
    expect(view).toContain('Tutti i 2 campi dell')
  })

  it('un tipo mai revisionato mostra i campi lo stesso, senza numeri', () => {
    const empty = measure({
      totals: { ...measure().totals, documents: 0 },
      fields: [fieldMeasure({ documents: 0, confirmed: 0, filled: 0 })],
      documents: []
    })
    const view = text(<ExtractionFields {...props} map={fieldMap({ measure: empty })} />)
    expect(view).toContain('Nessun documento di questo tipo è ancora stato revisionato')
    expect(view).toContain('Data emissione')
    expect(view).not.toContain('a mano su')
  })

  it('le correzioni su questo tipo si annullano da qui', () => {
    const action: ProfileAction = {
      id: 'a1',
      at: '2026-09-17T08:00:00.000Z',
      kind: 'ADD_FIELD',
      documentType: 'accounting.fattura',
      fieldId: 'bank.iban',
      label: null,
      before: null,
      after: 'optional',
      previousOverride: null,
      detail: '«IBAN» (bank.iban) aggiunto alla mappa di accounting.fattura come opzionale.',
      reason: null,
      revertsId: null,
      revertedAt: null
    }
    const markup = html(<ExtractionFields {...props} map={fieldMap({ undoable: [action] })} />)
    const view = text(<ExtractionFields {...props} map={fieldMap({ undoable: [action] })} />)
    expect(markup).toContain('data-action="a1"')
    expect(view).toContain('Modifiche a questo tipo')
    expect(view).toContain('aggiunto alla mappa di accounting.fattura')
    expect(view).toContain('Annulla')
  })

  it('senza tipo manda a «Dati»', () => {
    const view = text(<ExtractionFields {...props} documentType={null} map={null} />)
    expect(view).toContain('Nessun tipo assegnato')
    expect(view).toContain('Vai a Dati')
  })

  it('una mappa di un altro tipo non si mostra: si aspetta quella giusta', () => {
    const view = text(<ExtractionFields {...props} documentType="hr.unilav" map={fieldMap()} />)
    expect(view).toContain('Leggo i campi da estrarre')
    expect(view).not.toContain('Data emissione')
  })

  it('un tipo senza profilo nel registry lo dice', () => {
    const view = text(<ExtractionFields {...props} map={fieldMap({ editable: false })} />)
    expect(view).toContain('Nessuna mappa per questo tipo')
  })

  it('marca i profili verificati su documenti reali', () => {
    expect(text(<ExtractionFields {...props} map={fieldMap()} />)).toContain('Proposto')
    const verified = fieldMap({ measure: measure({ fieldTested: true }) })
    expect(text(<ExtractionFields {...props} map={verified} />)).toContain('Verificato')
  })

  it('tutto bloccato quando c’è un’operazione in corso', () => {
    const markup = html(<ExtractionFields {...props} busy map={fieldMap()} />)
    expect(markup).toContain('disabled=""')
  })
})

describe('conferma sui profili verificati', () => {
  it('chiede un sì esplicito, dicendo cosa sta per cambiare', () => {
    const view = text(
      <ConfirmEdit
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
        description="segnare Numero documento come non utile per questo tipo"
      />
    )
    expect(view).toContain('Questo profilo è stato verificato su documenti reali')
    expect(view).toContain('segnare Numero documento come non utile per questo tipo')
    expect(view).toContain('Sì, correggi')
    expect(view).toContain('Annulla')
  })
})
