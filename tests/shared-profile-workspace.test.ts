import { describe, expect, it } from 'vitest'
import type { ProfileAction } from '../src/shared/profile-history'
import {
  describeBundle,
  describeMapEdit,
  type ProfileBundleResult
} from '../src/shared/profile-workspace'

/**
 * Le frasi che il revisore legge dopo una correzione o un export. Sono parte del contratto
 * quanto i numeri: se la scheda dice che il documento è aggiornato mentre non lo è, la
 * frase è un difetto.
 */

describe('com’è andata una correzione', () => {
  const action: ProfileAction = {
    id: 'a1',
    at: '2026-09-17T08:00:00.000Z',
    kind: 'REMOVE_FIELD',
    documentType: 'accounting.fattura',
    fieldId: 'procurement.cig',
    label: null,
    before: 'optional',
    after: 'excluded',
    previousOverride: null,
    detail: '«CIG» (procurement.cig) segnato non utile per accounting.fattura.',
    reason: null,
    revertsId: null,
    revertedAt: null
  }

  it('ripete la decisione e manda a «Dati», dove i campi sono già aggiornati', () => {
    const message = describeMapEdit({ action, reprocessed: true, queued: 0 })
    expect(message).toContain('segnato non utile')
    expect(message).toContain('i campi aggiornati sono in «Dati»')
    expect(message).not.toContain('in coda')
  })

  it('senza copia locale dice che il documento non è cambiato', () => {
    expect(describeMapEdit({ action, reprocessed: false, queued: 0 })).toContain(
      'riaprilo da Drive'
    )
  })

  it('conta i documenti in coda che si rielaborano in sottofondo', () => {
    expect(describeMapEdit({ action, reprocessed: true, queued: 1 })).toContain(
      '1 altro documento in coda dello stesso tipo si rielabora in sottofondo'
    )
    expect(describeMapEdit({ action, reprocessed: true, queued: 3 })).toContain(
      '3 altri documenti in coda dello stesso tipo si rielaborano'
    )
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
