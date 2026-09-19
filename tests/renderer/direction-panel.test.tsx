import type { CompanyIdentity } from '@shared/document-direction'
import { describe, expect, it } from 'vitest'
import CompanyPanel from '../../src/renderer/src/components/company-panel'
import DirectionPanel from '../../src/renderer/src/components/direction-panel'
import { reviewDocument, scalarField } from '../helpers/review-document'
import { html, text } from './render'

/**
 * Emesso o ricevuto sulla scheda «Dati», e l'azienda con cui si decide.
 *
 * La direzione non è un campo: sta accanto al tipo, e deve dire **su cosa** ha deciso,
 * altrimenti il revisore si trova una parola senza sapere da dove viene.
 */

const NOI: CompanyIdentity = {
  name: 'POLESINE MASSETTI SRLS',
  vatNumber: '01479320291',
  taxCode: null
}

const props = { busy: false, onChoose: () => {} }

const nostra = scalarField({
  id: 'f-vat',
  name: 'issuer.vat_number',
  label: 'Partita IVA emittente',
  value: '01479320291',
  role: 'core'
})

describe('DirectionPanel', () => {
  it('non compare sui tipi che una direzione non ce l’hanno', () => {
    const view = html(
      <DirectionPanel
        {...props}
        company={NOI}
        document={reviewDocument({ documentType: 'corporate_registry.visura_camerale' })}
      />
    )
    expect(view).toBe('')
  })

  it('dice la direzione e su cosa l’ha decisa', () => {
    const view = text(
      <DirectionPanel {...props} company={NOI} document={reviewDocument({ fields: [nostra] })} />
    )
    expect(view).toContain('Emesso')
    expect(view).toContain('partita IVA o codice fiscale della parte')
  })

  it('senza azienda manda a scriverla, invece di dire «non si sa»', () => {
    const view = text(
      <DirectionPanel
        {...props}
        company={{ name: null, vatNumber: null, taxCode: null }}
        document={reviewDocument({ fields: [nostra] })}
      />
    )
    expect(view).toContain('l’azienda di cui sono i documenti non è ancora scritta')
  })

  it('la scelta del revisore lo dice, e lascia tornare al calcolo', () => {
    const view = text(
      <DirectionPanel
        {...props}
        company={NOI}
        document={reviewDocument({ fields: [nostra], directionChoice: 'NESSUNA' })}
      />
    )
    expect(view).toContain('Scelto dal revisore')
    expect(view).toContain('Dal documento risultava emesso')
    expect(view).toContain('Torna al calcolo')
  })
})

describe('CompanyPanel', () => {
  it('dice a cosa serve, e marca il caso vuoto', () => {
    const markup = html(<CompanyPanel company={null} busy={false} onSave={() => {}} />)
    expect(markup).toContain('data-company="empty"')
    expect(text(<CompanyPanel company={null} busy={false} onSave={() => {}} />)).toContain(
      'Serve a dire se un documento è emesso o ricevuto'
    )
  })

  it('mostra quella salvata', () => {
    const markup = html(<CompanyPanel company={NOI} busy={false} onSave={() => {}} />)
    expect(markup).toContain('data-company="set"')
    expect(markup).toContain('value="POLESINE MASSETTI SRLS"')
    expect(markup).toContain('value="01479320291"')
  })
})
