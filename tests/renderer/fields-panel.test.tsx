import type { EvidenceItem } from '@shared/types'
import { describe, expect, it } from 'vitest'
import FieldsPanel from '../../src/renderer/src/components/fields-panel'
import { item, listField, scalarField } from '../helpers/review-document'
import { count, html } from './render'

const noop = () => {}
const handlers = {
  onActivate: noop,
  onFieldCommit: noop,
  onItemCommit: noop,
  onItemRemove: noop,
  onItemAdd: noop,
  onFocusEvidence: noop
}

describe('FieldsPanel', () => {
  const fields = [
    scalarField({ id: 'number', name: 'document.number', evidenceId: 'ev-number' }),
    scalarField({ id: 'total', name: 'money.total', value: '', role: 'required' }),
    scalarField({
      id: 'iban',
      name: 'bank.iban',
      label: 'IBAN',
      value: '',
      role: 'optional',
      required: false,
      correctedValue: 'IT60X0542811101000000123456'
    }),
    listField([item({ evidenceId: 'ev-line' })])
  ]
  const evidence: EvidenceItem[] = [
    {
      id: 'ev-number',
      label: 'Numero',
      page: 1,
      text: 'FATTURA n. 114/2026',
      confidence: 0.85,
      origin: 'ENGINE'
    },
    {
      id: 'ev-line',
      label: 'Righe',
      page: 1,
      text: 'Fornitura materiali edili',
      confidence: 0.85,
      origin: 'ENGINE'
    }
  ]

  it('mette in cima i campi senza proposta col contatore dei vuoti, e li mostra tutti', () => {
    const markup = html(
      <FieldsPanel
        fields={fields}
        evidence={evidence}
        disabled={false}
        active={null}
        shownEvidenceId={null}
        {...handlers}
      />
    )

    const toFill = markup.indexOf('data-group="to-fill"')
    const proposed = markup.indexOf('data-group="proposed"')
    expect(toFill).toBeGreaterThanOrEqual(0)
    expect(proposed).toBeGreaterThan(toFill)
    expect(markup).toContain('1 vuoti su 2')

    const order = [...markup.matchAll(/data-field="([^"]+)"/g)].map((match) => match[1])
    expect(order).toEqual(['money.total', 'bank.iban', 'document.number', 'line_items'])
    expect(count(markup, 'data-field=')).toBe(fields.length)
  })

  it('ogni valore proposto ha la sua evidenza cliccabile', () => {
    const markup = html(
      <FieldsPanel
        fields={fields}
        evidence={evidence}
        disabled={false}
        active={null}
        shownEvidenceId="ev-number"
        {...handlers}
      />
    )
    expect(markup).toContain('FATTURA n. 114/2026')
    expect(markup).toContain('Fornitura materiali edili')
    expect(count(markup, 'Mostra nel documento')).toBe(2)
  })

  it('un valore selezionato sul documento mostra la selezione, non la lettura del motore', () => {
    const picked: EvidenceItem = {
      id: 'ev-picked',
      label: 'Numero documento · selezionato dal revisore',
      page: 2,
      text: '114/2026-bis',
      confidence: 1,
      origin: 'REVIEWER',
      method: 'TEXT_SELECTION'
    }
    const markup = html(
      <FieldsPanel
        fields={[
          scalarField({
            evidenceId: 'ev-number',
            correctedValue: '114/2026-bis',
            correctedEvidenceId: 'ev-picked'
          })
        ]}
        evidence={[...evidence, picked]}
        disabled={false}
        active={null}
        shownEvidenceId={null}
        {...handlers}
      />
    )
    expect(markup).toContain('data-evidence-page="2"')
    expect(markup).not.toContain('FATTURA n. 114/2026')
    expect(count(markup, 'Mostra nel documento')).toBe(1)
  })

  it('a campi tutti compilati il contatore lo dice', () => {
    const markup = html(
      <FieldsPanel
        fields={[scalarField({ value: '', correctedValue: '114/2026' })]}
        evidence={[]}
        disabled={false}
        active={null}
        shownEvidenceId={null}
        {...handlers}
      />
    )
    expect(markup).toContain('tutti compilati')
    expect(markup).not.toContain('data-group="proposed"')
  })
})
