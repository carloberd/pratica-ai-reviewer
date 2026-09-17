import { describe, expect, it } from 'vitest'
import {
  buildActivity,
  countStandingEdits,
  type DocumentEventEntry,
  type ProfileAction,
  revertableActions
} from '../src/shared/profile-history'

/**
 * La cronologia mette insieme due sorgenti e decide cosa si può ancora annullare.
 *
 * La regola che conta è quella sull'annullamento: si annulla solo l'ultima decisione
 * presa su un campo. Annullarne una più vecchia rimetterebbe uno stato che nel frattempo
 * qualcuno ha cambiato, e la mappa direbbe una cosa mentre la cronologia ne dice
 * un'altra.
 */

function action(overrides: Partial<ProfileAction> = {}): ProfileAction {
  return {
    id: 'a1',
    at: '2026-09-17T08:00:00.000Z',
    kind: 'REMOVE_FIELD',
    documentType: 'accounting.fattura',
    fieldId: 'procurement.cig',
    label: null,
    before: 'conditional',
    after: 'excluded',
    previousOverride: null,
    detail: 'CIG segnato non utile.',
    reason: null,
    revertsId: null,
    revertedAt: null,
    ...overrides
  }
}

function event(overrides: Partial<DocumentEventEntry> = {}): DocumentEventEntry {
  return {
    id: 'e1',
    at: '2026-09-17T09:00:00.000Z',
    documentId: 'doc-1',
    filename: 'Fattura 114.pdf',
    documentType: 'accounting.fattura',
    title: 'Documento revisionato',
    detail: 'Salvato dal revisore.',
    ...overrides
  }
}

describe('cosa si può annullare', () => {
  it('l’ultima decisione su un campo sì, quella prima no', () => {
    const older = action({ id: 'vecchia', at: '2026-09-17T08:00:00.000Z' })
    const newer = action({
      id: 'nuova',
      at: '2026-09-17T10:00:00.000Z',
      kind: 'ADD_FIELD',
      after: 'core'
    })

    const revertable = revertableActions([newer, older])

    expect(revertable.has('nuova')).toBe(true)
    expect(revertable.has('vecchia')).toBe(false)
  })

  it('due campi diversi si annullano tutti e due', () => {
    const cig = action({ id: 'cig' })
    const iban = action({ id: 'iban', fieldId: 'bank.iban', at: '2026-09-17T09:00:00.000Z' })

    expect(revertableActions([iban, cig])).toEqual(new Set(['cig', 'iban']))
  })

  it('un’azione già annullata non si annulla di nuovo', () => {
    const reverted = action({ id: 'fatta', revertedAt: '2026-09-17T11:00:00.000Z' })

    expect(revertableActions([reverted]).size).toBe(0)
  })

  it('le etichette insegnate restano annullabili una per una', () => {
    const first = action({
      id: 'l1',
      kind: 'ADD_HINT_LABEL',
      fieldId: 'issuer.tax_id',
      label: 'Partita IVA'
    })
    const second = action({
      id: 'l2',
      kind: 'ADD_HINT_LABEL',
      fieldId: 'issuer.tax_id',
      label: 'P. IVA',
      at: '2026-09-17T12:00:00.000Z'
    })

    expect(revertableActions([second, first])).toEqual(new Set(['l1', 'l2']))
  })

  it('un re-run o un export non sono correzioni: non si annullano', () => {
    const rerun = action({ id: 'r', kind: 'RERUN', fieldId: null })
    const exported = action({ id: 'x', kind: 'EXPORT', fieldId: null, documentType: null })

    expect(revertableActions([rerun, exported]).size).toBe(0)
  })
})

describe('la lista unica', () => {
  it('mescola correzioni ed eventi dei documenti, dal più recente', () => {
    const entries = buildActivity([action()], [event()])

    expect(entries.map((entry) => entry.source)).toEqual(['DOCUMENT', 'MAP'])
    expect(entries[0]!.filename).toBe('Fattura 114.pdf')
    expect(entries[1]!.title).toBe('Campo segnato non utile')
    expect(entries[1]!.revertable).toBe(true)
  })

  it('un evento di documento non si annulla', () => {
    const [entry] = buildActivity([], [event()])

    expect(entry!.revertable).toBe(false)
    expect(entry!.documentId).toBe('doc-1')
  })

  it('conta solo le correzioni ancora in piedi', () => {
    const actions = [
      action({ id: 'a' }),
      action({ id: 'b', revertedAt: '2026-09-17T11:00:00.000Z' }),
      action({ id: 'c', kind: 'REVERT' }),
      action({ id: 'd', kind: 'RERUN' })
    ]

    expect(countStandingEdits(actions)).toBe(1)
  })
})
