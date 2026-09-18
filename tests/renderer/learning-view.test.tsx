import { describe, expect, it } from 'vitest'
import LearningView from '../../src/renderer/src/components/learning-view'
import type { LearningOverview, LearningRuleView } from '../../src/shared/learning-workspace'
import { count, html, text } from './render'

const rule = (overrides: Partial<LearningRuleView>): LearningRuleView => ({
  id: 'r-template',
  kind: 'EXTRACTION_ANCHOR',
  scope: 'TEMPLATE',
  status: 'ACTIVE',
  documentType: 'payments_treasury.richiesta_pagamento',
  documentTypeLabel: 'Richiesta di pagamento',
  fieldId: 'document.issue_date',
  fieldLabel: 'Data emissione',
  templateFingerprint: 'f1',
  label: 'data',
  title: '«Data emissione» sta dopo «data» sul modulo f1',
  support: 3,
  precision: 1,
  reliability: 0.8,
  positiveCount: 3,
  negativeCount: 0,
  lastPositiveAt: '2026-09-17T10:00:00.000Z',
  lastNegativeAt: null,
  updatedAt: '2026-09-17T10:00:00.000Z',
  manual: ['SUSPENDED', 'REJECTED'],
  canRollback: false,
  ...overrides
})

const overview: LearningOverview = {
  mode: 'FROZEN',
  counts: { events: 12, rules: { CANDIDATE: 1, ACTIVE: 1, SUSPENDED: 1, REJECTED: 0 } },
  rules: [
    rule({}),
    rule({
      id: 'r-memory',
      kind: 'TEMPLATE_TYPE',
      status: 'SUSPENDED',
      title: 'Il modulo f1 è «Richiesta di pagamento»',
      fieldId: null,
      fieldLabel: null,
      label: null,
      negativeCount: 1,
      precision: 0.75,
      reliability: 2 / 3,
      manual: ['ACTIVE', 'REJECTED']
    }),
    rule({ id: 'r-class', scope: 'CLASS', status: 'CANDIDATE', manual: ['REJECTED'] })
  ],
  actions: [
    {
      id: 'a1',
      at: '2026-09-17T11:00:00.000Z',
      kind: 'RULE_SUSPENDED',
      ruleId: 'r-memory',
      before: 'ACTIVE',
      after: 'SUSPENDED',
      detail:
        'Memoria del modulo f1 sospesa: lo stesso modulo è stato chiuso anche con un altro tipo.',
      numbers: { support: 3, precision: 1 },
      revertsId: null,
      revertedAt: null
    }
  ]
}

const noop = () => {}
const props = {
  overview,
  loading: false,
  busy: false,
  exporting: false,
  replaying: false,
  onSetMode: noop,
  onSetRuleStatus: noop,
  onReplay: noop,
  onRollbackRule: noop,
  onExport: noop
}

describe('LearningView', () => {
  it('la modalità in uso, i contatori e cosa fa ogni modalità', () => {
    const markup = html(<LearningView {...props} />)
    const view = text(<LearningView {...props} />)
    expect(view).toContain('12 decisioni registrate · 1 attive · 1 sospese · 1 candidate')
    expect(markup).toMatch(/aria-pressed="true"[^>]*data-mode="FROZEN"/)
    expect(count(markup, 'aria-pressed="false"')).toBe(2)
    expect(view).toContain('Solo il registry: nessuna regola applicata')
  })

  it('ogni regola coi suoi numeri e le azioni che il suo stato permette', () => {
    const markup = html(<LearningView {...props} />)
    const view = text(<LearningView {...props} />)
    expect(view).toContain(
      '«Data emissione» sta dopo «data» sul modulo f1 attiva etichetta del modulo'
    )
    expect(view).toContain(
      'Richiesta di pagamento · 3 conferme · 0 smentite · precisione 100% · affidabilità 80%'
    )
    expect(view).toContain('Il modulo f1 è «Richiesta di pagamento» sospesa tipo del modulo')
    expect(markup).toContain('data-rule="r-class" data-status="CANDIDATE"')
    // Attiva: sospendi e scarta; sospesa: riattiva e scarta; candidata: solo scarta.
    expect(count(markup, '>Sospendi<')).toBe(1)
    expect(count(markup, '>Riattiva<')).toBe(1)
    expect(count(markup, '>Scarta<')).toBe(3)
    expect(view).toContain('Cronologia del learner')
    expect(view).toContain('Regola sospesa')
  })

  it('l’affidabilità si vede anche su una regola senza prove, dove la precisione non c’è', () => {
    // La precisione sparisce dalla riga, l'affidabilità no: il 50% è il modo di dire che
    // di quella regola non si sa ancora niente.
    const senzaProve = rule({
      id: 'r-nuova',
      positiveCount: 0,
      negativeCount: 0,
      support: 0,
      precision: null,
      reliability: 0.5
    })
    const view = text(<LearningView {...props} overview={{ ...overview, rules: [senzaProve] }} />)
    expect(view).toContain('0 conferme · 0 smentite · affidabilità 50%')
    expect(view).not.toContain('precisione')
  })

  it('«Annulla ultima modifica» solo sulle regole che hanno qualcosa da annullare', () => {
    // Nel fixture nessuna regola è annullabile: il pulsante non c'è proprio, e non è un
    // pulsante spento — un'azione impossibile non si mostra.
    expect(html(<LearningView {...props} />)).not.toContain('Annulla ultima modifica')

    const scartata = rule({
      id: 'r-scartata',
      status: 'REJECTED',
      manual: [],
      canRollback: true
    })
    const markup = html(
      <LearningView {...props} overview={{ ...overview, rules: [rule({}), scartata] }} />
    )
    expect(count(markup, '>Annulla ultima modifica<')).toBe(1)
    expect(markup).toContain('Rimette lo stato che la regola aveva prima dell’ultima modifica.')
  })

  it('il ripasso delle revisioni si può lanciare solo in LEARNING', () => {
    // La modalità del fixture è FROZEN: il ripasso registra decisioni, e lì non si registra.
    expect(html(<LearningView {...props} />)).toMatch(
      /disabled[^>]*>Ripassa le revisioni<|Ripassa le revisioni/
    )
    const learning = { ...overview, mode: 'LEARNING' as const }
    const markup = html(<LearningView {...props} overview={learning} />)
    expect(markup).toContain('Ripassa le revisioni')
    expect(markup).toContain('quelle di prima che il learner fosse acceso non le ha mai viste')
  })

  it('senza regole lo dice, e spiega come nascono', () => {
    const empty = { ...overview, rules: [], actions: [] }
    const view = text(<LearningView {...props} overview={empty} />)
    expect(view).toContain('Nessuna regola ancora.')
    expect(view).toContain('Niente da mostrare qui.')
  })
})
