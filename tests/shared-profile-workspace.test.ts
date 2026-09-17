import { describe, expect, it } from 'vitest'
import type { ProfileAction } from '../src/shared/profile-history'
import type { ProfileTypeMeasure } from '../src/shared/profile-metrics'
import {
  describeBundle,
  describeEdit,
  describeRerun,
  describeStore,
  type ProfileBundleResult,
  type TypeRerunResult
} from '../src/shared/profile-workspace'

/**
 * Le frasi che il revisore legge dopo una correzione, un re-run o un export. Sono parte
 * del contratto quanto i numeri: se una schermata dice che il lavoro è al sicuro mentre
 * è solo su questa macchina, la frase è un difetto.
 */

const EMPTY_MEASURE = {
  documentType: 'accounting.fattura',
  label: 'fattura',
  profileOrigin: 'V2_EXPLICIT',
  schemaState: null,
  fieldTested: false,
  totals: {
    documents: 2,
    confirmed: 0,
    corrected: 0,
    manual: 0,
    outcomes: 0,
    confirmedRate: 0,
    correctedRate: 0,
    manualRate: 0
  },
  fields: [],
  documents: []
} satisfies ProfileTypeMeasure

function rerun(overrides: Partial<TypeRerunResult> = {}): TypeRerunResult {
  return {
    documentType: 'accounting.fattura',
    processed: ['a', 'b'],
    skipped: [],
    failed: [],
    retyped: [],
    before: EMPTY_MEASURE,
    after: EMPTY_MEASURE,
    delta: {
      documentType: 'accounting.fattura',
      before: EMPTY_MEASURE.totals,
      after: EMPTY_MEASURE.totals,
      fields: [],
      unchanged: false
    },
    ...overrides
  }
}

describe('dove finisce una correzione', () => {
  it('senza correzioni dice dove valgono e come si portano fuori', () => {
    const message = describeStore(0)
    expect(message).toContain('restano qui dentro e valgono subito per il motore')
    expect(message).toContain('Esporta → Mappa tipi ↔ dati')
  })

  it('con delle correzioni in piedi le conta: sono su questa installazione', () => {
    expect(describeStore(1)).toContain('1 correzione in piedi')
    expect(describeStore(7)).toContain('7 correzioni in piedi')
    expect(describeStore(7)).toContain('per portarle in pratica-ai')
  })
})

describe('com’è andata una correzione', () => {
  const action: ProfileAction = {
    id: 'a1',
    at: '2026-09-17T08:00:00.000Z',
    kind: 'REMOVE_FIELD',
    documentType: 'accounting.fattura',
    fieldId: 'procurement.cig',
    label: null,
    before: 'conditional',
    after: 'excluded',
    previousOverride: null,
    detail: '«CIG» (procurement.cig) segnato non utile per accounting.fattura.',
    reason: null,
    revertsId: null,
    revertedAt: null
  }

  it('ripete la decisione e dice dove si annulla', () => {
    const message = describeEdit(action)
    expect(message).toContain('segnato non utile')
    expect(message).toContain('Cronologia')
  })
})

describe('esito dell’export della mappa', () => {
  const bundle: ProfileBundleResult = {
    saved: true,
    directory: '/Users/x/Documents/mappa-tipi-2026-09-17',
    paths: ['/a.json', '/b.json', '/c.json', '/d.json'],
    types: 2,
    fields: 5,
    edits: 5
  }

  it('dice dove sono i file, quanti tipi e che il registry non è cambiato', () => {
    const message = describeBundle(bundle)
    expect(message).toContain('mappa-tipi-2026-09-17')
    expect(message).toContain('2 tipi corretti')
    expect(message).toContain('5 campi decisi')
    expect(message).toContain('4 file')
    expect(message).toContain('non sono stati toccati')
  })

  it('annullato: non è stato scritto niente, e lo dice', () => {
    expect(describeBundle({ ...bundle, saved: false })).toContain('non è stato scritto niente')
  })
})

describe('esito del re-run', () => {
  it('quanti documenti, e cosa è rimasto fuori', () => {
    expect(describeRerun(rerun())).toBe('Rielaborati 2 documenti dalla cache.')

    const partial = describeRerun(
      rerun({
        processed: ['a'],
        skipped: [{ documentId: 'b', filename: 'b.pdf', reason: 'la copia locale non c’è più.' }],
        failed: [{ documentId: 'c', filename: 'c.pdf', reason: 'boom' }],
        retyped: ['d']
      })
    )
    expect(partial).toContain('Rielaborato 1 documento dalla cache.')
    expect(partial).toContain('1 documento saltato')
    expect(partial).toContain('1 documento non rielaborato per un errore')
    expect(partial).toContain('1 documento ha cambiato tipo')
  })

  it('se i numeri non si muovono lo dice, invece di far cercare la differenza', () => {
    const message = describeRerun(
      rerun({
        delta: {
          documentType: 'accounting.fattura',
          before: EMPTY_MEASURE.totals,
          after: EMPTY_MEASURE.totals,
          fields: [],
          unchanged: true
        }
      })
    )
    expect(message).toContain('I numeri non si sono mossi')
  })
})
