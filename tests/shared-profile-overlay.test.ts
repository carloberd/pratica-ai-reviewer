import { describe, expect, it } from 'vitest'
import type { ClassExtractionProfile } from '../src/shared/extraction-v2'
import {
  applyCardinalityOverlay,
  applyHintOverlay,
  applyOverlay,
  cardinalityOf,
  excludedFields,
  fieldStateOrNull,
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
  required_fields: ['document.number', 'document.issue_date'],
  optional_fields: ['issuer.name', 'procurement.cig'],
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

    expect(next.optional_fields).toEqual(['issuer.name'])
    expect(roleIn(next, 'procurement.cig')).toBeNull()
    expect(excludedFields({ 'procurement.cig': 'excluded' })).toEqual(['procurement.cig'])
  })

  it('un campo ripesato cambia lista, non compare due volte', () => {
    const next = applyOverlay(PROFILE, { 'issuer.name': 'required' })

    expect(next.optional_fields).toEqual(['procurement.cig'])
    expect(next.required_fields).toEqual(['document.number', 'document.issue_date', 'issuer.name'])
  })

  it('i campi aggiunti vanno in coda in ordine, così l’export non cambia da solo', () => {
    const next = applyOverlay(PROFILE, { 'bank.iban': 'optional', 'money.total': 'optional' })
    const other = applyOverlay(PROFILE, { 'money.total': 'optional', 'bank.iban': 'optional' })

    expect(next.optional_fields).toEqual([
      'issuer.name',
      'procurement.cig',
      'bank.iban',
      'money.total'
    ])
    expect(other.optional_fields).toEqual(next.optional_fields)
  })

  it('non tocca il profilo di partenza', () => {
    applyOverlay(PROFILE, { 'issuer.name': 'excluded', 'bank.iban': 'required' })

    expect(PROFILE.optional_fields).toEqual(['issuer.name', 'procurement.cig'])
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

/**
 * Il database può contenere decisioni scritte quando i ruoli erano quattro: nessuna
 * migrazione le aveva portate avanti, e `applyOverlay` indicizzava per ruolo. Una riga
 * `core` cercava una lista che non esiste — «Cannot read properties of undefined
 * (reading 'push')» — e faceva cadere la rielaborazione del documento e l'export della
 * mappa, cioè l'unico modo in cui quelle decisioni diventano file.
 */
describe('i ruoli di prima del Brain MVP', () => {
  it('«core» e «conditional» valgono «optional»: è quello che facevano', () => {
    expect(fieldStateOrNull('core')).toBe('optional')
    expect(fieldStateOrNull('conditional')).toBe('optional')
  })

  it('i tre stati di adesso restano quelli', () => {
    expect(fieldStateOrNull('required')).toBe('required')
    expect(fieldStateOrNull('optional')).toBe('optional')
    expect(fieldStateOrNull('excluded')).toBe('excluded')
  })

  it('uno stato che nessuna versione ha scritto vale «nessuna decisione»', () => {
    expect(fieldStateOrNull('principale')).toBeNull()
    expect(fieldStateOrNull(null)).toBeNull()
    expect(fieldStateOrNull(undefined)).toBeNull()
  })

  it('un profilo con una decisione vecchia si applica invece di cadere', () => {
    // @ts-expect-error: il tipo non lo prevede più, il database sì
    const next = applyOverlay(PROFILE, { 'procurement.cig': 'core', 'payment.iban': 'conditional' })

    expect(next.required_fields).toEqual(['document.number', 'document.issue_date'])
    expect(next.optional_fields).toEqual(['issuer.name', 'payment.iban', 'procurement.cig'])
  })

  it('una decisione illeggibile lascia il campo com’è nel registry', () => {
    // @ts-expect-error: proprio un valore che nessuno ha mai scritto
    const next = applyOverlay(PROFILE, { 'document.number': 'boh' })

    // Non sparisce dalla mappa: uno stato che non si sa leggere non è «non utile».
    expect(next.required_fields).toEqual(['document.number', 'document.issue_date'])
    expect(next.optional_fields).toEqual(['issuer.name', 'procurement.cig'])
    // E se non resta niente di leggibile, il profilo è proprio lo stesso oggetto.
    // @ts-expect-error: come sopra
    expect(applyOverlay(PROFILE, { 'document.number': 'boh' })).toEqual(PROFILE)
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
