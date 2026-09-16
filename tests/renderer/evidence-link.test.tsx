import { describe, expect, it, vi } from 'vitest'
import EvidenceLink from '../../src/renderer/src/components/evidence-link'
import { html, text } from './render'

describe('EvidenceLink', () => {
  const target = {
    page: 2,
    text: 'Totale documento\nEUR 86.420,00',
    bbox: { x: 56, y: 331, w: 166, h: 11 }
  }

  it('mostra pagina e prima riga, col testo intero nel titolo', () => {
    const markup = html(<EvidenceLink target={target} onFocus={() => {}} />)
    expect(text(<EvidenceLink target={target} onFocus={() => {}} />)).toBe(
      'pag. 2 Totale documento'
    )
    expect(markup).toContain('data-evidence-page="2"')
    expect(markup).toContain('title="Mostra nel documento: Totale documento\nEUR 86.420,00"')
  })

  it('il clic chiede di portare il documento a quel punto', () => {
    const onFocus = vi.fn()
    const element = EvidenceLink({ target, onFocus })
    element.props.onClick()
    expect(onFocus).toHaveBeenCalledWith(target)
  })
})
