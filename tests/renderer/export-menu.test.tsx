import { describe, expect, it } from 'vitest'
import ExportMenu from '../../src/renderer/src/components/export-menu'
import { html, text } from './render'

const props = { busy: false, pending: null, onExport: () => {} }

describe('ExportMenu', () => {
  it('un solo pulsante, con il menu chiuso', () => {
    const markup = html(<ExportMenu {...props} />)
    expect(text(<ExportMenu {...props} />)).toBe('Esporta')
    expect(markup).toContain('aria-haspopup="menu"')
    expect(markup).toContain('aria-expanded="false"')
    // Le due forme si vedono solo aprendo il menu: niente JSON e Excel in pagina.
    expect(markup).not.toContain('menuitem')
  })

  it('mentre esporta lo dice, qualunque delle due forme sia in corso', () => {
    expect(text(<ExportMenu {...props} pending="json" />)).toBe('Esporto…')
    expect(text(<ExportMenu {...props} pending="xlsx" />)).toBe('Esporto…')
  })

  it('durante un’altra operazione il pulsante è disabilitato', () => {
    expect(html(<ExportMenu {...props} busy />)).toContain('disabled=""')
  })
})
