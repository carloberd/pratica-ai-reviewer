import { describe, expect, it } from 'vitest'
import RepeatedFieldEditor from '../../src/renderer/src/components/repeated-field-editor'
import { item, listField } from '../helpers/review-document'
import { count, html, text } from './render'

const noop = () => {}
const props = {
  disabled: false,
  activeRow: null,
  shownEvidenceId: null,
  onActivate: noop,
  onItemCommit: noop,
  onItemRemove: noop,
  onItemAdd: noop,
  onFocusEvidence: noop
}

describe('RepeatedFieldEditor', () => {
  const field = listField([
    item({ id: 'c', index: 2, origin: 'MANUAL', value: '', correctedValue: 'Trasporto' }),
    item({ id: 'a', index: 0, value: 'Fornitura', evidenceId: 'ev-a' }),
    item({ id: 'b', index: 1, value: 'Posa', correctedValue: 'Posa in opera' }),
    item({ id: 'd', index: 3, value: 'Doppione', removed: true })
  ])
  const evidenceById = new Map([
    [
      'ev-a',
      {
        id: 'ev-a',
        label: 'Righe · riga 1',
        page: 1,
        text: 'Righe documento: Fornitura',
        confidence: 0.85
      }
    ]
  ])

  it('una riga per voce, in ordine, con evidenza, correzione, rimozione e aggiunte', () => {
    const markup = html(
      <RepeatedFieldEditor {...props} field={field} evidenceById={evidenceById} />
    )

    expect([...markup.matchAll(/aria-label="Riga (\d+)"/g)].map((m) => m[1])).toEqual([
      '1',
      '2',
      '3'
    ])
    expect(count(markup, '<tr')).toBe(4)
    expect(markup).toContain('data-origin="MANUAL"')
    expect(markup).toContain('Mostra nel documento: Righe documento: Fornitura')

    const view = text(<RepeatedFieldEditor {...props} field={field} evidenceById={evidenceById} />)
    // Le righe confermate sono tre: quella tolta resta barrata, con «rimetti».
    expect(view).toContain('3 righe')
    expect(view).toContain('proposta: Posa annulla togli')
    expect(view).toContain('Doppione rimetti')
    expect(view).toContain('aggiunta a mano')
    expect(view).toContain('Aggiungi riga')
  })

  it('senza righe proposte invita ad aggiungerle', () => {
    const view = text(
      <RepeatedFieldEditor {...props} field={listField([])} evidenceById={new Map()} />
    )
    expect(view).toContain('0 righe')
    expect(view).toContain('Nessuna riga proposta: aggiungile a mano.')
  })
})
