import { describe, expect, it } from 'vitest'
import type { ProfileTypeMeasure } from '../src/shared/profile-metrics'
import {
  describeRerun,
  describeStore,
  describeWriteOutcome,
  type ProfileStoreStatus,
  type TypeRerunResult
} from '../src/shared/profile-workspace'

/**
 * Le frasi che il revisore legge dopo una correzione o un re-run. Sono parte del
 * contratto quanto i numeri: una degradazione dichiarata male vale una degradazione
 * nascosta.
 */

function store(mode: ProfileStoreStatus['mode']): ProfileStoreStatus {
  return {
    directory: '/registry/v2',
    writable: mode !== 'EXPORT_REQUIRED',
    repositoryRoot: mode === 'COMMITTED' ? '/repo' : null,
    mode
  }
}

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

describe('cosa succederà alla prossima correzione', () => {
  it('lo dice prima di farla, in tutti e tre i casi', () => {
    expect(describeStore(store('COMMITTED'))).toContain('commit dedicato')
    expect(describeStore(store('WRITTEN'))).toContain('senza commit')
    expect(describeStore(store('EXPORT_REQUIRED'))).toContain('sola lettura')
  })
})

describe('com’è andata', () => {
  const subject = 'profile(accounting.fattura): rimuove document.number, mai usato su 12 documenti'

  it('col commit dice quale', () => {
    expect(
      describeWriteOutcome({ mode: 'COMMITTED', paths: ['/a.json'], commit: 'a1b2c3d', subject })
    ).toBe(`${subject} — commit a1b2c3d.`)
  })

  it('senza git dice che è salvato e non versionato', () => {
    const message = describeWriteOutcome({
      mode: 'WRITTEN',
      paths: ['/a.json'],
      subject,
      reason: 'la cartella non sta in un repository git.'
    })
    expect(message).toContain('salvato senza commit')
    expect(message).toContain('non sta in un repository git')
  })

  it('con la cartella di sola lettura dice dove sta il file da sostituire', () => {
    const message = describeWriteOutcome({
      mode: 'EXPORT_REQUIRED',
      files: ['class_extraction_profiles_v2.json'],
      exportedTo: ['/Users/x/Documents/class_extraction_profiles_v2.json'],
      subject,
      reason: 'La cartella è di sola lettura.'
    })
    expect(message).toContain('/Users/x/Documents/class_extraction_profiles_v2.json')
    expect(message).toContain('sostituiscilo a mano in class_extraction_profiles_v2.json')
  })

  it('export annullato: il registry non è cambiato, e si dice', () => {
    expect(
      describeWriteOutcome({
        mode: 'EXPORT_REQUIRED',
        files: ['class_extraction_profiles_v2.json'],
        exportedTo: [],
        subject,
        reason: 'La cartella è di sola lettura.'
      })
    ).toContain('export annullato: il registry non è stato modificato')
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
