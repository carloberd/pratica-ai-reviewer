import { describe, expect, it } from 'vitest'
import type { ClassExtractionProfile } from '../src/shared/extraction-v2'
import {
  type ProfileEdit,
  ProfileEditError,
  type ProfileEditInput,
  type ProfileEditReason,
  planProfileEdit
} from '../src/shared/profile-edit'
import type { TypeOverrides } from '../src/shared/profile-overlay'

/**
 * Le regole di una correzione alla mappa, senza database e senza UI.
 *
 * Qui non si scrive niente: si controlla che una correzione impossibile si fermi con una
 * frase leggibile, che quella possibile dica cosa cambia, e soprattutto che sappia
 * sempre cosa rimettere se la si annulla — è l'unica cosa che la cronologia non può
 * ricostruire da sola.
 */

const TYPE = 'accounting.fattura'

function profile(overrides: Partial<ClassExtractionProfile> = {}): ClassExtractionProfile {
  return {
    document_type_id: TYPE,
    canonical_name: 'fattura',
    family: 'accounting',
    schema_state: 'EXTRACTION_SCHEMA_DRAFT',
    evidence_basis: 'AI_PROPOSED',
    required_fields: ['document.number'],
    core_fields: ['issuer.name'],
    optional_fields: [],
    conditional_fields: ['procurement.cig'],
    literal_evidence_required: true,
    unknown_value_policy: 'LEAVE_EMPTY',
    review_policy: 'REVIEW_LOW_CONFIDENCE_MISSING_REQUIRED_CONFLICTS_ONLY',
    ...overrides
  }
}

const NUMBERS: ProfileEditReason = { documents: 4, confirmed: 0, corrected: 0, manual: 0 }

function plan(edit: ProfileEdit, input: Partial<ProfileEditInput> = {}) {
  return planProfileEdit({
    edit,
    profile: profile(),
    overrides: {},
    hintLabels: ['Numero'],
    field: { id: edit.fieldId, label: 'Numero documento', aliases: ['N.'] },
    reason: NUMBERS,
    ...input
  })
}

describe('segnare un campo non utile', () => {
  it('lo porta a «non utile» e dice su quanti documenti non è mai servito', () => {
    const result = plan({ kind: 'REMOVE_FIELD', documentType: TYPE, fieldId: 'procurement.cig' })

    expect(result.after).toBe('excluded')
    expect(result.override).toBe('excluded')
    expect(result.before).toBe('conditional')
    expect(result.previousOverride).toBeNull()
    expect(result.detail).toContain('segnato non utile')
    expect(result.detail).toContain('4 documenti annotati')
  })

  it('con dei valori raccolti non dice «mai usato»: sarebbe falso', () => {
    const result = plan(
      { kind: 'REMOVE_FIELD', documentType: TYPE, fieldId: 'document.number' },
      { reason: { documents: 4, confirmed: 3, corrected: 0, manual: 1 } }
    )

    expect(result.detail).toContain('viene scartato lo stesso')
    expect(result.detail).toContain('4 documenti')
    expect(result.detail).not.toContain('mai avuto un valore')
  })

  it('un campo che la mappa non chiede non si può scartare', () => {
    expect(() =>
      plan({ kind: 'REMOVE_FIELD', documentType: TYPE, fieldId: 'bank.iban' })
    ).toThrowError(ProfileEditError)
  })

  it('due volte no: la seconda lo dice invece di riscrivere la stessa decisione', () => {
    expect(() =>
      plan(
        { kind: 'REMOVE_FIELD', documentType: TYPE, fieldId: 'procurement.cig' },
        { overrides: { 'procurement.cig': 'excluded' } }
      )
    ).toThrowError(/già segnato non utile/)
  })
})

describe('aggiungere un campo', () => {
  it('entra col peso scelto, anche se nessun documento lo porta', () => {
    const result = plan({
      kind: 'ADD_FIELD',
      documentType: TYPE,
      fieldId: 'bank.iban',
      role: 'optional'
    })

    expect(result.after).toBe('optional')
    expect(result.before).toBeNull()
    expect(result.detail).toContain('aggiunto alla mappa')
    expect(result.detail).toContain('opzionale')
  })

  it('quando il revisore lo compilava a mano, il perché lo dice la frase', () => {
    const result = plan(
      { kind: 'ADD_FIELD', documentType: TYPE, fieldId: 'bank.iban', role: 'core' },
      { reason: { documents: 4, confirmed: 0, corrected: 0, manual: 3 } }
    )

    expect(result.detail).toContain('il revisore lo ha messo lui su 3 documenti')
  })

  it('un campo già scartato rientra, e la frase dice da dove viene', () => {
    const overrides: TypeOverrides = { 'procurement.cig': 'excluded' }
    const result = plan(
      { kind: 'ADD_FIELD', documentType: TYPE, fieldId: 'procurement.cig', role: 'core' },
      { overrides }
    )

    expect(result.before).toBe('excluded')
    expect(result.previousOverride).toBe('excluded')
    expect(result.detail).toContain('era segnato non utile')
  })

  it('un campo che la mappa già chiede non si aggiunge due volte', () => {
    expect(() =>
      plan({ kind: 'ADD_FIELD', documentType: TYPE, fieldId: 'issuer.name', role: 'core' })
    ).toThrowError(/prevede già/)
  })

  it('un id che l’ontologia non conosce si ferma qui', () => {
    expect(() =>
      plan(
        { kind: 'ADD_FIELD', documentType: TYPE, fieldId: 'campo.inventato', role: 'core' },
        { field: null }
      )
    ).toThrowError(/non è un campo dell'ontologia/)
  })
})

describe('cambiare peso', () => {
  it('dice da cosa a cosa', () => {
    const result = plan({
      kind: 'SET_ROLE',
      documentType: TYPE,
      fieldId: 'issuer.name',
      role: 'required'
    })

    expect(result.before).toBe('core')
    expect(result.after).toBe('required')
    expect(result.detail).toContain('da principale a obbligatorio')
  })

  it('allo stesso peso non è una correzione', () => {
    expect(() =>
      plan({ kind: 'SET_ROLE', documentType: TYPE, fieldId: 'issuer.name', role: 'core' })
    ).toThrowError(/è già principale/)
  })
})

describe('ripristinare quello che dice il registry', () => {
  it('toglie la decisione e riporta il campo al ruolo del registry', () => {
    const result = plan(
      { kind: 'RESTORE_FIELD', documentType: TYPE, fieldId: 'issuer.name' },
      { overrides: { 'issuer.name': 'required' } }
    )

    expect(result.override).toBeNull()
    expect(result.after).toBe('core')
    expect(result.previousOverride).toBe('required')
    expect(result.detail).toContain('come dice il registry')
  })

  it('un campo aggiunto dal revisore torna fuori dalla mappa', () => {
    const result = plan(
      { kind: 'RESTORE_FIELD', documentType: TYPE, fieldId: 'bank.iban' },
      { overrides: { 'bank.iban': 'optional' } }
    )

    expect(result.after).toBeNull()
    expect(result.detail).toContain('torna fuori dalla mappa')
  })

  it('senza nessuna decisione da togliere non fa niente e lo dice', () => {
    expect(() =>
      plan({ kind: 'RESTORE_FIELD', documentType: TYPE, fieldId: 'issuer.name' })
    ).toThrowError(/nessuna decisione da togliere/)
  })
})

describe('insegnare un’etichetta', () => {
  it('la registra senza cambiare la mappa', () => {
    const result = plan({
      kind: 'ADD_HINT_LABEL',
      documentType: TYPE,
      fieldId: 'document.number',
      label: '  Fattura n.  '
    })

    expect(result.label).toBe('Fattura n.')
    expect(result.before).toBe('required')
    expect(result.after).toBe('required')
    expect(result.override).toBeNull()
    expect(result.detail).toContain("Insegnata l'etichetta «Fattura n.»")
  })

  it('un’etichetta che il motore già cerca non si aggiunge di nuovo', () => {
    expect(() =>
      plan({
        kind: 'ADD_HINT_LABEL',
        documentType: TYPE,
        fieldId: 'document.number',
        label: 'numero'
      })
    ).toThrowError(/è già fra le etichette/)
  })

  it('a un campo fuori dalla mappa non servirebbe a niente', () => {
    expect(() =>
      plan({
        kind: 'ADD_HINT_LABEL',
        documentType: TYPE,
        fieldId: 'bank.iban',
        label: 'IBAN'
      })
    ).toThrowError(/non chiede/)
  })

  it('vuota no', () => {
    expect(() =>
      plan({
        kind: 'ADD_HINT_LABEL',
        documentType: TYPE,
        fieldId: 'document.number',
        label: '   '
      })
    ).toThrowError(/non può essere vuota/)
  })
})
