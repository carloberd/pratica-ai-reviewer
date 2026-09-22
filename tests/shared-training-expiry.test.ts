import { describe, expect, it } from 'vitest'
import {
  addYears,
  TRAINING_EXPIRY_FIELD,
  TRAINING_VALIDITY,
  trainingExpiryOf
} from '../src/shared/training-expiry'
import { testExtractionRegistry } from './helpers/registry'

/**
 * La tabella della validità della formazione, e il conto che ne esce. Il caso di
 * riferimento è `6ad7d267` dell'export del 18/09: attestato del 13/05/2021, e il revisore
 * ha scritto a mano `13-05-2026`.
 *
 * Dal registry del 22/09 la tabella è vuota: i due tipi che avevano una riga sono
 * confluiti in `hse_training.attestato_formazione_sicurezza`, dove il corso è un
 * attributo. Il conto resta provato qui, così quando le righe torneranno non si ricomincia
 * da capo.
 */

const GENERALE = 'hse_training.attestato_formazione_generale'

describe('la scadenza di un attestato di formazione', () => {
  it('nessun tipo ha una riga: dopo l’accorpamento la scadenza si scrive a mano', () => {
    expect(Object.keys(TRAINING_VALIDITY)).toEqual([])
    expect(trainingExpiryOf(GENERALE, () => '2021-05-13')).toBeNull()
    expect(
      trainingExpiryOf('hse_training.attestato_formazione_sicurezza', () => '2021-05-13')
    ).toBeNull()
  })

  it('il campo che la tabella riempie esiste ancora nell’ontologia', () => {
    const registry = testExtractionRegistry()
    expect(registry.field(TRAINING_EXPIRY_FIELD)).not.toBeNull()
  })

  it('una riga che tornasse deve parlare di un tipo vero, di campi veri, e portare la norma', () => {
    const registry = testExtractionRegistry()
    for (const [documentType, validity] of Object.entries(TRAINING_VALIDITY)) {
      const profile = registry.profile(documentType)
      expect(profile, documentType).not.toBeNull()
      // Il campo da cui si conta e quello che si riempie devono stare nel profilo del tipo,
      // o il motore non li avrebbe mai letti.
      const fields = [...profile!.optional_fields, ...profile!.required_fields]
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
