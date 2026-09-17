import { describe, expect, it } from 'vitest'
import type { ClassExtractionProfile } from '../src/shared/extraction-v2'
import {
  applyCardinalityOverlay,
  applyHintOverlay,
  applyOverlay,
  cardinalityOf,
  excludedFields,
  roleIn
} from '../src/shared/profile-overlay'

/**
 * L'overlay è il punto in cui le decisioni del revisore diventano quello che il motore
 * legge. Se sbaglia qui, sbaglia su ogni documento elaborato: niente database, niente
 * mock, solo profilo più decisioni uguale profilo.
 */

const PROFILE: ClassExtractionProfile = {
  document_type_id: 'accounting.fattura',
  canonical_name: 'fattura',
  family: 'accounting',
  schema_state: 'EXTRACTION_SCHEMA_DRAFT',
  evidence_basis: 'AI_PROPOSED',
  required_fields: ['document.number', 'document.issue_date'],
  core_fields: ['issuer.name'],
  optional_fields: [],
  conditional_fields: ['procurement.cig'],
  literal_evidence_required: true,
  unknown_value_policy: 'LEAVE_EMPTY',
  review_policy: 'REVIEW_LOW_CONFIDENCE_MISSING_REQUIRED_CONFLICTS_ONLY'
}

describe('il profilo con sopra le decisioni del revisore', () => {
  it('senza decisioni restituisce lo stesso identico profilo', () => {
    expect(applyOverlay(PROFILE, undefined)).toBe(PROFILE)
    expect(applyOverlay(PROFILE, {})).toBe(PROFILE)
  })

  it('un campo non utile esce da tutte le liste', () => {
    const next = applyOverlay(PROFILE, { 'procurement.cig': 'excluded' })

    expect(next.conditional_fields).toEqual([])
    expect(roleIn(next, 'procurement.cig')).toBeNull()
    expect(excludedFields({ 'procurement.cig': 'excluded' })).toEqual(['procurement.cig'])
  })

  it('un campo ripesato cambia lista, non compare due volte', () => {
    const next = applyOverlay(PROFILE, { 'issuer.name': 'required' })

    expect(next.core_fields).toEqual([])
    expect(next.required_fields).toEqual(['document.number', 'document.issue_date', 'issuer.name'])
  })

  it('i campi aggiunti vanno in coda in ordine, così l’export non cambia da solo', () => {
    const next = applyOverlay(PROFILE, { 'bank.iban': 'core', 'money.total': 'core' })
    const other = applyOverlay(PROFILE, { 'money.total': 'core', 'bank.iban': 'core' })

    expect(next.core_fields).toEqual(['issuer.name', 'bank.iban', 'money.total'])
    expect(other.core_fields).toEqual(next.core_fields)
  })

  it('non tocca il profilo di partenza', () => {
    applyOverlay(PROFILE, { 'issuer.name': 'excluded', 'bank.iban': 'required' })

    expect(PROFILE.core_fields).toEqual(['issuer.name'])
    expect(PROFILE.required_fields).toEqual(['document.number', 'document.issue_date'])
  })
})

describe('uno o più valori', () => {
  it('la decisione sta sul profilo, e il motore la legge prima dell’ontologia', () => {
    const corrected = applyCardinalityOverlay(PROFILE, { 'procurement.cig': 'many' })

    expect(corrected.field_cardinality).toEqual({ 'procurement.cig': 'many' })
    expect(cardinalityOf(corrected, 'procurement.cig', 'one')).toBe('many')
    expect(cardinalityOf(corrected, 'document.number', 'one')).toBe('one')
    expect(cardinalityOf(PROFILE, 'line_items', 'many')).toBe('many')
  })

  it('senza decisioni restituisce lo stesso profilo, e non tocca quello di partenza', () => {
    expect(applyCardinalityOverlay(PROFILE, {})).toBe(PROFILE)
    applyCardinalityOverlay(PROFILE, { 'issuer.name': 'many' })
    expect(PROFILE.field_cardinality).toBeUndefined()
  })
})

describe('le etichette insegnate', () => {
  it('si sommano a quelle del registry, in coda', () => {
    expect(applyHintOverlay(['Numero'], ['Fattura n.'])).toEqual(['Numero', 'Fattura n.'])
  })

  it('una già presente non si ripete, nemmeno con un’altra capitalizzazione', () => {
    expect(applyHintOverlay(['Numero'], ['numero'])).toEqual(['Numero'])
  })

  it('senza etichette insegnate restituisce la lista del registry', () => {
    const base = ['Numero']
    expect(applyHintOverlay(base, undefined)).toBe(base)
  })
})
