import { describe, expect, it } from 'vitest'
import {
  addYears,
  TRAINING_EXPIRY_FIELD,
  TRAINING_VALIDITY,
  trainingExpiryOf
} from '../src/shared/training-expiry'
import { testRegistryV2 } from './helpers/registry'

/**
 * La tabella della validità della formazione, e il conto che ne esce. Il caso di
 * riferimento è `6ad7d267` dell'export del 18/09: attestato del 13/05/2021, e il revisore
 * ha scritto a mano `13-05-2026`.
 */

const GENERALE = 'hse_training.attestato_formazione_generale'

describe('la scadenza di un attestato di formazione', () => {
  it('cinque anni dal rilascio, come li ha contati il revisore', () => {
    const computed = trainingExpiryOf(GENERALE, (fieldId) =>
      fieldId === 'document.issue_date' ? '2021-05-13' : null
    )
    expect(computed).toMatchObject({ value: '2026-05-13', from: 'document.issue_date', years: 5 })
  })

  it('si conta dal rilascio, non dall’ultima giornata d’aula', () => {
    // Sull'attestato c'erano tutte e due: il corso finiva il 04/05, il rilascio era il 13.
    const computed = trainingExpiryOf(GENERALE, (fieldId) =>
      fieldId === 'document.issue_date' ? '13/05/2021' : '04/05/2021'
    )
    expect(computed?.value).toBe('2026-05-13')
  })

  it('senza la data di partenza non si deduce niente', () => {
    expect(trainingExpiryOf(GENERALE, () => null)).toBeNull()
    // «03/05/2021 (8 ore), 04/05/2021 (8 ore)», verbatim dall'export: non è una data sola.
    expect(trainingExpiryOf(GENERALE, () => '03/05/2021 (8 ore), 04/05/2021 (8 ore)')).toBeNull()
  })

  it('un corso fuori tabella resta senza scadenza calcolata', () => {
    // Meglio un campo vuoto che una data inventata: la riga la scrive chi conosce la norma.
    for (const documentType of [
      'hse_training.attestato_preposto',
      'hse_training.attestato_antincendio',
      'hse_training.attestato_primo_soccorso',
      'hse_training.attestato_lavori_in_quota',
      'hse_training.attestato_spazi_confinati',
      'hse_training.attestato_dpi_terza_categoria'
    ]) {
      expect(
        trainingExpiryOf(documentType, () => '2021-05-13'),
        documentType
      ).toBeNull()
    }
  })

  it('ogni riga della tabella parla di un tipo vero, di un campo vero, e porta la norma', () => {
    const registry = testRegistryV2()
    expect(registry.field(TRAINING_EXPIRY_FIELD)).not.toBeNull()
    for (const [documentType, validity] of Object.entries(TRAINING_VALIDITY)) {
      const profile = registry.profile(documentType)
      expect(profile, documentType).not.toBeNull()
      // Il campo da cui si conta e quello che si riempie devono stare nel profilo del tipo,
      // o il motore non li avrebbe mai letti.
      const fields = [...profile!.core_fields, ...profile!.required_fields]
      expect(fields, documentType).toContain(validity.from)
      expect(fields, documentType).toContain(TRAINING_EXPIRY_FIELD)
      expect(validity.years, documentType).toBeGreaterThan(0)
      expect(validity.reference.length, documentType).toBeGreaterThan(20)
    }
  })

  it('il 29 febbraio cade sul 28 quando l’anno non è bisestile', () => {
    expect(addYears('2024-02-29', 5)).toBe('2029-02-28')
    expect(addYears('2024-02-29', 4)).toBe('2028-02-29')
    expect(addYears('2021-05-13', 5)).toBe('2026-05-13')
    expect(addYears('13/05/2021', 5)).toBeNull()
  })
})
