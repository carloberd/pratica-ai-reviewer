import { describe, expect, it } from 'vitest'
import FieldEditor from '../../src/renderer/src/components/field-editor'
import { scalarField } from '../helpers/review-document'
import { html, text } from './render'

const props = {
  evidence: undefined,
  disabled: false,
  active: false,
  evidenceShown: false,
  onActivate: () => {},
  onCommit: () => {},
  onFocusEvidence: () => {}
}

describe('FieldEditor', () => {
  it('un campo corretto mostra la proposta e il modo di tornarci', () => {
    const view = text(<FieldEditor {...props} field={scalarField({ correctedValue: '114/B' })} />)
    expect(view).toContain('corretto proposto: 114/2026 torna alla proposta')
  })

  it('un campo compilato a mano non ha una proposta da barrare', () => {
    const view = text(
      <FieldEditor {...props} field={scalarField({ value: '', correctedValue: '114/B' })} />
    )
    expect(view).toContain('compilato a mano svuota')
    expect(view).not.toContain('proposto:')
  })

  it('un campo senza evidenza invita a compilarlo, uno svuotato dice perché è vuoto', () => {
    expect(html(<FieldEditor {...props} field={scalarField({ value: '' })} />)).toContain(
      'placeholder="Nessuna evidenza: compila a mano"'
    )
    expect(html(<FieldEditor {...props} field={scalarField({ correctedValue: '' })} />)).toContain(
      'Svuotato'
    )
  })

  it('una data dedotta lo dice: nel documento non c’è, e va confermata', () => {
    const deduced = scalarField({
      name: 'hse.training_expiry',
      label: 'Scadenza formazione',
      value: '2026-05-13',
      semanticType: 'date',
      required: false,
      reviewStatus: 'NEEDS_REVIEW',
      computed: true
    })
    expect(text(<FieldEditor {...props} field={deduced} />)).toContain('dedotto')
    expect(html(<FieldEditor {...props} field={deduced} />)).toContain('calcolata dalla normativa')
    // Corretta dal revisore non è più dedotta: il valore è suo.
    expect(
      text(<FieldEditor {...props} field={{ ...deduced, correctedValue: '2026-05-04' }} />)
    ).not.toContain('dedotto')
    expect(text(<FieldEditor {...props} field={scalarField()} />)).not.toContain('dedotto')
  })

  it('segnala un conflitto finché il revisore non corregge', () => {
    expect(
      text(<FieldEditor {...props} field={scalarField({ reviewStatus: 'CONFLICT' })} />)
    ).toContain('conflitto')
  })
})
