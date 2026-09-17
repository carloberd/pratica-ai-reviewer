import { describe, expect, it } from 'vitest'
import { toDatasetDocument } from '../src/shared/dataset'
import {
  PRATICAAI_TYPE_ALIASES,
  praticaaiTypeId,
  praticaaiTypeIdOrNull,
  reviewerTypeId
} from '../src/shared/registry-alignment'
import { testRegistryV2 } from './helpers/registry'
import { reviewDocument } from './helpers/review-document'

const registry = testRegistryV2()

describe('gli id dei tipi fra reviewer e pratica-ai', () => {
  it('le tre classi con slug diverso si traducono nei due sensi', () => {
    expect(praticaaiTypeId('hse_risk.autocertificazione_idoneita_tecnico_professionale')).toBe(
      'hse_risk.idoneita_autocertificazione'
    )
    expect(reviewerTypeId('hse_risk.idoneita_autocertificazione')).toBe(
      'hse_risk.autocertificazione_idoneita_tecnico_professionale'
    )
    for (const alias of PRATICAAI_TYPE_ALIASES) {
      expect(praticaaiTypeId(alias.reviewer)).toBe(alias.praticaai)
      expect(reviewerTypeId(alias.praticaai)).toBe(alias.reviewer)
    }
  })

  it('un tipo senza alias resta com’è, e un id sconosciuto non si traduce a indovinare', () => {
    expect(praticaaiTypeId('accounting.fattura')).toBe('accounting.fattura')
    expect(reviewerTypeId('accounting.fattura')).toBe('accounting.fattura')
    expect(praticaaiTypeId('qualcosa.inventato')).toBe('qualcosa.inventato')
    expect(praticaaiTypeIdOrNull(null)).toBeNull()
  })

  it('negli export il tipo esce anche con lo slug di pratica-ai', () => {
    const [alias] = PRATICAAI_TYPE_ALIASES
    const document = toDatasetDocument({
      document: reviewDocument({
        status: 'REVIEWED',
        documentType: alias!.reviewer,
        documentTypeLabel: alias!.canonicalName,
        typeConfidence: null
      }),
      extraction: null
    })!
    expect(document.documentType).toMatchObject({
      id: alias!.reviewer,
      label: alias!.canonicalName,
      registry: { id: alias!.praticaai, proposed: null },
      chosenBy: 'REVIEWER'
    })
  })

  it('ogni alias parla di una classe che questo registry ha davvero, e di una che non ha', () => {
    for (const alias of PRATICAAI_TYPE_ALIASES) {
      expect(registry.profile(alias.reviewer), alias.reviewer).not.toBeNull()
      // Lo slug di pratica-ai non è un tipo di questo pacchetto: se lo diventasse, l'alias
      // andrebbe togliato invece che tradotto.
      expect(registry.profile(alias.praticaai), alias.praticaai).toBeNull()
    }
  })
})
