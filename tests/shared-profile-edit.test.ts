import { describe, expect, it } from 'vitest'
import {
  applyProfileEdit,
  type HintsFile,
  ProfileEditError,
  type ProfileEditInput,
  type ProfilesFile,
  type RawProfile,
  REVIEWER_PROVENANCE
} from '../src/shared/profile-edit'
import { REVIEWER_EDITED_SCHEMA_STATE } from '../src/shared/profile-metrics'

/**
 * La correzione di un profilo: JSON valido, chiavi sconosciute intatte, nessun profilo
 * perso e un messaggio di commit che dice perché.
 */

function profiles(): ProfilesFile {
  return {
    version: '2.0.0',
    active_registry_source: 'Document Brain 496 active classes',
    profiles: {
      'accounting.fattura': {
        document_type_id: 'accounting.fattura',
        canonical_name: 'fattura',
        family: 'accounting',
        priority: 'P1',
        schema_state: 'EXTRACTION_SCHEMA_DRAFT',
        evidence_basis: 'LEGACY_REGISTRY+AI_PROPOSED',
        required_fields: [],
        core_fields: ['document.number', 'document.issue_date'],
        optional_fields: ['money.total'],
        conditional_fields: [],
        field_provenance: {
          'document.number': 'AI_PROPOSED_FAMILY',
          'document.issue_date': 'AI_PROPOSED_FAMILY'
        },
        confusables: ['accounting.autofattura'],
        literal_evidence_required: true,
        unknown_value_policy: 'LEAVE_EMPTY',
        review_policy: 'REVIEW_LOW_CONFIDENCE_MISSING_REQUIRED_CONFLICTS_ONLY',
        notes: 'Generated proposal.'
      },
      'hr.unilav': {
        document_type_id: 'hr.unilav',
        canonical_name: 'unilav',
        family: 'hr',
        schema_state: 'EXTRACTION_SCHEMA_READY_FOR_FIELD_TEST',
        evidence_basis: 'REAL_DOCUMENT_EVIDENCE',
        required_fields: ['employment.employee_name'],
        core_fields: [],
        optional_fields: [],
        conditional_fields: [],
        literal_evidence_required: true,
        unknown_value_policy: 'LEAVE_EMPTY',
        review_policy: 'REVIEW_LOW_CONFIDENCE_MISSING_REQUIRED_CONFLICTS_ONLY'
      }
    }
  }
}

function hints(): HintsFile {
  return {
    version: '2.0.0',
    hints: {
      'document.number': {
        labels: ['Numero documento'],
        regexes: [],
        scope: 'whole_document',
        candidate_limit: 10
      }
    }
  }
}

const REASON = { documents: 12, confirmed: 0, corrected: 0, manual: 0 }

function input(overrides: Partial<ProfileEditInput>): ProfileEditInput {
  return {
    profiles: profiles(),
    hints: hints(),
    reason: REASON,
    field: { label: 'IBAN', aliases: ['Coordinate bancarie'] },
    edit: { kind: 'REMOVE_FIELD', documentType: 'accounting.fattura', fieldId: 'document.number' },
    ...overrides
  }
}

describe('togliere un campo che non appartiene al tipo', () => {
  const result = applyProfileEdit(input({}))
  const profile = result.profiles.profiles['accounting.fattura']!

  it('lo toglie dalla sua lista e dalla provenienza, senza toccare il resto', () => {
    expect(profile.core_fields).toEqual(['document.issue_date'])
    expect(profile.optional_fields).toEqual(['money.total'])
    expect(profile.field_provenance).toEqual({ 'document.issue_date': 'AI_PROPOSED_FAMILY' })
    // Le chiavi che il codice non conosce restano dov'erano.
    expect(profile.confusables).toEqual(['accounting.autofattura'])
    expect(profile.notes).toBe('Generated proposal.')
    expect(result.profiles.active_registry_source).toBe('Document Brain 496 active classes')
  })

  it('non perde gli altri profili e non tocca gli hint', () => {
    expect(Object.keys(result.profiles.profiles)).toEqual(['accounting.fattura', 'hr.unilav'])
    expect(result.profiles.profiles['hr.unilav']).toEqual(profiles().profiles['hr.unilav'])
    expect(result.changedHints).toBe(false)
    expect(result.hints).toEqual(hints())
  })

  it('scrive il messaggio di commit della task, coi numeri', () => {
    expect(result.commit.subject).toBe(
      'profile(accounting.fattura): rimuove document.number, mai usato su 12 documenti'
    )
    expect(result.commit.body).toContain('Numeri su 12 documenti annotati:')
    expect(result.commit.body).toContain('era principale nel profilo')
  })

  it('non lascia l’oggetto di partenza modificato', () => {
    const before = profiles()
    const source = profiles()
    applyProfileEdit(input({ profiles: source }))
    expect(source).toEqual(before)
  })

  it('rifiuta di togliere un campo che il profilo non chiede', () => {
    expect(() =>
      applyProfileEdit(
        input({
          edit: { kind: 'REMOVE_FIELD', documentType: 'accounting.fattura', fieldId: 'bank.iban' }
        })
      )
    ).toThrow(ProfileEditError)
  })
})

describe('aggiungere un campo che il revisore mette sempre a mano', () => {
  const result = applyProfileEdit(
    input({
      edit: {
        kind: 'ADD_FIELD',
        documentType: 'accounting.fattura',
        fieldId: 'bank.iban',
        role: 'optional'
      },
      reason: { documents: 12, confirmed: 0, corrected: 0, manual: 9 }
    })
  )

  it('lo mette nella lista del ruolo scelto, in coda, con la provenienza giusta', () => {
    const profile = result.profiles.profiles['accounting.fattura']!
    expect(profile.optional_fields).toEqual(['money.total', 'bank.iban'])
    expect(profile.field_provenance!['bank.iban']).toBe(REVIEWER_PROVENANCE)
  })

  it('semina gli hint se il campo non ne aveva, partendo dall’ontologia', () => {
    expect(result.changedHints).toBe(true)
    expect(result.hints.hints['bank.iban']).toEqual({
      labels: ['IBAN', 'Coordinate bancarie'],
      regexes: [],
      scope: 'whole_document',
      candidate_limit: 10
    })
  })

  it('dice quante volte il revisore lo aveva chiesto', () => {
    expect(result.commit.subject).toBe(
      'profile(accounting.fattura): aggiunge bank.iban come opzionale, richiesto su 9 documenti'
    )
  })

  it('rifiuta un campo che non sta nell’ontologia: romperebbe l’avvio', () => {
    expect(() =>
      applyProfileEdit(
        input({
          field: null,
          edit: {
            kind: 'ADD_FIELD',
            documentType: 'accounting.fattura',
            fieldId: 'inventato.campo',
            role: 'core'
          }
        })
      )
    ).toThrow(/non è un campo dell'ontologia/)
  })

  it('rifiuta un campo che il profilo prevede già', () => {
    expect(() =>
      applyProfileEdit(
        input({
          edit: {
            kind: 'ADD_FIELD',
            documentType: 'accounting.fattura',
            fieldId: 'money.total',
            role: 'core'
          }
        })
      )
    ).toThrow(/prevede già/)
  })
})

describe('cambiare il peso di un campo', () => {
  it('lo sposta di lista e lo dice nel commit', () => {
    const result = applyProfileEdit(
      input({
        edit: {
          kind: 'SET_ROLE',
          documentType: 'accounting.fattura',
          fieldId: 'document.number',
          role: 'required'
        }
      })
    )
    const profile = result.profiles.profiles['accounting.fattura']!
    expect(profile.required_fields).toEqual(['document.number'])
    expect(profile.core_fields).toEqual(['document.issue_date'])
    expect(result.commit.subject).toBe(
      'profile(accounting.fattura): document.number da principale a obbligatorio'
    )
  })

  it('rifiuta un ruolo che il campo ha già', () => {
    expect(() =>
      applyProfileEdit(
        input({
          edit: {
            kind: 'SET_ROLE',
            documentType: 'accounting.fattura',
            fieldId: 'document.number',
            role: 'core'
          }
        })
      )
    ).toThrow(/è già principale/)
  })
})

describe('aggiungere un’etichetta agli hint', () => {
  const result = applyProfileEdit(
    input({
      edit: {
        kind: 'ADD_HINT_LABEL',
        documentType: 'accounting.fattura',
        fieldId: 'document.number',
        label: 'Fattura n.'
      },
      reason: { documents: 10, confirmed: 0, corrected: 0, manual: 7 }
    })
  )

  it('tocca solo gli hint, in coda alle etichette che c’erano', () => {
    expect(result.changedProfiles).toBe(false)
    expect(result.profiles).toEqual(profiles())
    expect(result.hints.hints['document.number']!.labels).toEqual([
      'Numero documento',
      'Fattura n.'
    ])
  })

  it('il commit parla di hint, non di profilo', () => {
    expect(result.commit.subject).toBe("hints(document.number): aggiunge l'etichetta «Fattura n.»")
    expect(result.commit.body).toContain('accounting.fattura')
  })

  it('rifiuta un’etichetta doppia, anche con maiuscole diverse', () => {
    expect(() =>
      applyProfileEdit(
        input({
          edit: {
            kind: 'ADD_HINT_LABEL',
            documentType: 'accounting.fattura',
            fieldId: 'document.number',
            label: 'numero DOCUMENTO'
          }
        })
      )
    ).toThrow(/è già fra le etichette/)
  })

  it('rifiuta un’etichetta per un campo che il profilo non chiede', () => {
    expect(() =>
      applyProfileEdit(
        input({
          edit: {
            kind: 'ADD_HINT_LABEL',
            documentType: 'accounting.fattura',
            fieldId: 'bank.iban',
            label: 'IBAN'
          }
        })
      )
    ).toThrow(/non servirebbe a niente/)
  })
})

describe('tipi senza profilo esplicito', () => {
  const fallback: RawProfile = {
    document_type_id: 'other.verbale',
    canonical_name: 'other.verbale',
    family: 'other',
    schema_state: 'EXTRACTION_SCHEMA_LEGACY_FALLBACK',
    evidence_basis: 'CURRENT_REVIEWER_V1_1_0_REGISTRY',
    required_fields: [],
    core_fields: ['document.number', 'document.issue_date'],
    optional_fields: [],
    conditional_fields: [],
    literal_evidence_required: true,
    unknown_value_policy: 'LEAVE_EMPTY',
    review_policy: 'REVIEW_LOW_CONFIDENCE_MISSING_REQUIRED_CONFLICTS_ONLY'
  }

  it('la prima correzione materializza il profilo, marcato come non verificato', () => {
    const result = applyProfileEdit(
      input({
        fallbackProfile: fallback,
        edit: { kind: 'REMOVE_FIELD', documentType: 'other.verbale', fieldId: 'document.number' }
      })
    )
    const profile = result.profiles.profiles['other.verbale']!
    expect(profile.schema_state).toBe(REVIEWER_EDITED_SCHEMA_STATE)
    expect(profile.evidence_basis).toBe('REVIEWER_ANNOTATIONS+LEGACY_REGISTRY')
    expect(profile.core_fields).toEqual(['document.issue_date'])
    // Gli altri due restano.
    expect(Object.keys(result.profiles.profiles)).toHaveLength(3)
  })

  it('senza nemmeno uno schema v1 la correzione si ferma con una frase chiara', () => {
    expect(() =>
      applyProfileEdit(
        input({
          fallbackProfile: null,
          edit: { kind: 'REMOVE_FIELD', documentType: 'ignoto.tipo', fieldId: 'document.number' }
        })
      )
    ).toThrow(/non ha un profilo da correggere/)
  })
})
