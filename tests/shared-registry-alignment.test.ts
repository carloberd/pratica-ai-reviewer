import { describe, expect, it } from 'vitest'
import { toDatasetDocument } from '../src/shared/dataset'
import {
  PRATICAAI_TYPE_ALIASES,
  praticaaiTypeId,
  praticaaiTypeIdOrNull,
  reviewerTypeId
} from '../src/shared/registry-alignment'
import { testExtractionRegistry } from './helpers/registry'
import { reviewDocument } from './helpers/review-document'

const registry = testExtractionRegistry()

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

  it('nessuno slug di pratica-ai è un tipo di questo registry', () => {
    // Le tre classi con lo slug diverso sono fuori dalle 171 del Brain MVP: la traduzione
    // resta perché i documenti già chiusi su di loro escono comunque negli export. Quello
    // che non deve succedere è che lo slug di pratica-ai diventi un tipo di qui: allora
    // l'alias andrebbe tolto, non tradotto.
    for (const alias of PRATICAAI_TYPE_ALIASES) {
      expect(registry.profile(alias.praticaai), alias.praticaai).toBeNull()
    }
  })
})
