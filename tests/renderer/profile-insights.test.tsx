import { describe, expect, it } from 'vitest'
import ProfileFields from '../../src/renderer/src/components/profile-fields'
import ProfileInsights, { ConfirmEdit } from '../../src/renderer/src/components/profile-insights'
import type { ProfileFieldMeasure, ProfileTypeMeasure } from '../../src/shared/profile-metrics'
import type { ProfileWorkspace, TypeRerunResult } from '../../src/shared/profile-workspace'
import { count, html, text } from './render'

/**
 * La schermata deve essere leggibile da chi non ha scritto il codice: numeri, prima e
 * dopo, niente gergo. Qui si verifica proprio quello — le parole e i numeri a schermo.
 */

function fieldMeasure(overrides: Partial<ProfileFieldMeasure> = {}): ProfileFieldMeasure {
  const base: ProfileFieldMeasure = {
    fieldId: 'document.issue_date',
    label: 'Data emissione',
    role: 'required',
    inProfile: true,
    confirmed: 12,
    corrected: 0,
    manual: 0,
    empty: 0,
    filled: 12,
    documents: 12,
    confirmedRate: 1,
    correctedRate: 0,
    manualRate: 0,
    signal: 'OK'
  }
  return { ...base, ...overrides }
}

const NEVER_USED = fieldMeasure({
  fieldId: 'document.number',
  label: 'Numero documento',
  role: 'core',
  confirmed: 0,
  filled: 0,
  empty: 12,
  confirmedRate: 0,
  signal: 'NEVER_USED'
})

const MISSING = fieldMeasure({
  fieldId: 'bank.iban',
  label: 'IBAN',
  role: null,
  inProfile: false,
  confirmed: 0,
  manual: 9,
  filled: 9,
  empty: 3,
  confirmedRate: 0,
  manualRate: 0.75,
  signal: 'MISSING_FROM_PROFILE'
})

function measure(overrides: Partial<ProfileTypeMeasure> = {}): ProfileTypeMeasure {
  return {
    documentType: 'accounting.fattura',
    label: 'fattura',
    profileOrigin: 'V2_EXPLICIT',
    schemaState: 'EXTRACTION_SCHEMA_DRAFT',
    fieldTested: false,
    totals: {
      documents: 12,
      confirmed: 12,
      corrected: 3,
      manual: 9,
      outcomes: 24,
      confirmedRate: 0.5,
      correctedRate: 0.125,
      manualRate: 0.375
    },
    fields: [fieldMeasure(), NEVER_USED, MISSING],
    documents: [
      {
        documentId: 'doc-1',
        driveFileId: 'drive-1',
        filename: 'Fattura 114.pdf',
        reviewedAt: '2026-09-16T10:00:00.000Z',
        confirmed: 2,
        corrected: 0,
        manual: 1
      }
    ],
    ...overrides
  }
}

function workspace(overrides: Partial<ProfileWorkspace> = {}): ProfileWorkspace {
  return {
    types: [measure()],
    store: {
      directory: '/registry/v2',
      writable: true,
      repositoryRoot: '/repo',
      mode: 'COMMITTED'
    },
    ...overrides
  }
}

const props = {
  loading: false,
  busy: false,
  selected: null,
  rerun: null,
  onSelect: () => {},
  onEdit: () => {},
  onRerun: () => {},
  onExport: () => {},
  onOpenDocument: () => {}
}

describe('schermata «Istruzioni per tipo»', () => {
  it('dice in parole quanto aiuta la precompilazione, con i numeri accanto', () => {
    const view = text(<ProfileInsights {...props} workspace={workspace()} />)
    expect(view).toContain('Su 24 valori raccolti in 12 documenti')
    expect(view).toContain('50% arrivati dal motore e confermati')
    expect(view).toContain('13% proposti e corretti')
    expect(view).toContain('38% scritti a mano dal revisore')
    expect(view).toContain('Rielabora i 12 documenti')
    expect(view).toContain('Ogni correzione riscrive i JSON del registry')
  })

  it('il campo mai usato è segnalato col numero di documenti e col pulsante per toglierlo', () => {
    const markup = html(<ProfileInsights {...props} workspace={workspace()} />)
    const view = text(<ProfileInsights {...props} workspace={workspace()} />)
    expect(markup).toContain('data-field="document.number" data-signal="NEVER_USED"')
    expect(view).toContain('Mai usato: su 12 documenti di questo tipo non ha mai avuto un valore')
    expect(view).toContain('Togli dal profilo')
  })

  it('il campo che il revisore aggiunge sempre è proposto per l’aggiunta, con quante volte', () => {
    const markup = html(<ProfileInsights {...props} workspace={workspace()} />)
    const view = text(<ProfileInsights {...props} workspace={workspace()} />)
    expect(markup).toContain('data-field="bank.iban" data-signal="MISSING_FROM_PROFILE"')
    expect(view).toContain('Campi che il revisore aggiunge e il profilo non prevede')
    expect(view).toContain('9 su 12 (75%)')
    expect(view).toContain('Aggiungi al profilo')
  })

  it('marca i profili verificati su documenti reali e quelli senza profilo esplicito', () => {
    expect(text(<ProfileInsights {...props} workspace={workspace()} />)).toContain(
      'Schema proposto, mai verificato'
    )

    const verified = workspace({ types: [measure({ fieldTested: true })] })
    expect(text(<ProfileInsights {...props} workspace={verified} />)).toContain(
      'Verificato su documenti reali'
    )

    const legacy = workspace({
      types: [measure({ profileOrigin: 'LEGACY_FALLBACK', label: null })]
    })
    const view = text(<ProfileInsights {...props} workspace={legacy} />)
    expect(view).toContain('Senza profilo esplicito')
    expect(view).toContain('campi ricavati dallo schema v1')
    expect(view).toContain('resta marcato: non è uno schema verificato')
  })

  it('senza documenti annotati spiega da dove arrivano i numeri', () => {
    const view = text(<ProfileInsights {...props} workspace={workspace({ types: [] })} />)
    expect(view).toContain('Nessuna misura ancora')
    expect(view).toContain('gli scartati non contano')
  })

  it('elenca i documenti che alimentano i numeri', () => {
    const markup = html(<ProfileInsights {...props} workspace={workspace()} />)
    expect(markup).toContain('data-document="doc-1"')
    expect(text(<ProfileInsights {...props} workspace={workspace()} />)).toContain(
      'Fattura 114.pdf'
    )
  })
})

describe('prima e dopo la rielaborazione', () => {
  const before = measure()
  const after = measure({
    totals: {
      ...before.totals,
      manual: 2,
      confirmed: 19,
      manualRate: 0.0833,
      confirmedRate: 0.7917
    },
    fields: [fieldMeasure(), { ...NEVER_USED, confirmed: 10, filled: 10, confirmedRate: 0.8333 }]
  })

  const rerun: TypeRerunResult = {
    documentType: 'accounting.fattura',
    processed: ['doc-1'],
    skipped: [],
    failed: [],
    retyped: [],
    before,
    after,
    delta: {
      documentType: 'accounting.fattura',
      before: before.totals,
      after: after.totals,
      fields: [
        {
          fieldId: 'issuer.tax_id',
          label: 'CF/P.IVA emittente',
          before: fieldMeasure({ fieldId: 'issuer.tax_id', manual: 8, manualRate: 0.7 }),
          after: fieldMeasure({ fieldId: 'issuer.tax_id', manual: 2, manualRate: 0.2 }),
          manualRateChange: -0.5,
          confirmedRateChange: 0.5
        }
      ],
      unchanged: false
    }
  }

  it('mostra il prima/dopo del tipo e del campo migliorato', () => {
    const view = text(
      <ProfileInsights
        {...props}
        workspace={workspace()}
        rerun={rerun}
        selected="accounting.fattura"
      />
    )
    expect(view).toContain('Rielaborato 1 documento dalla cache.')
    expect(view).toContain('Scritti a mano: 38% → 8%')
    expect(view).toContain('Confermati dal motore: 50% → 79%')
    expect(view).toContain('CF/P.IVA emittente — a mano 70% → 20%')
  })

  it('il prima/dopo di un altro tipo non compare su questo', () => {
    const view = text(
      <ProfileInsights
        {...props}
        workspace={workspace()}
        rerun={{ ...rerun, documentType: 'hr.unilav' }}
        selected="accounting.fattura"
      />
    )
    expect(view).not.toContain('a mano 70% → 20%')
  })
})

describe('conferma sui profili verificati', () => {
  it('chiede un sì esplicito, dicendo cosa sta per cambiare', () => {
    const view = text(
      <ConfirmEdit
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
        action={{
          edit: {
            kind: 'REMOVE_FIELD',
            documentType: 'accounting.fattura',
            fieldId: 'document.number'
          },
          description: 'togliere document.number dal profilo di accounting.fattura'
        }}
      />
    )
    expect(view).toContain('Questo profilo è stato costruito su documenti reali')
    expect(view).toContain('togliere document.number dal profilo di accounting.fattura')
    expect(view).toContain('Sì, correggi il profilo')
    expect(view).toContain('Annulla')
  })
})

describe('tabella dei campi', () => {
  it('un profilo senza campi lo dice invece di mostrare una tabella vuota', () => {
    const view = text(
      <ProfileFields measure={measure({ fields: [] })} disabled={false} onEdit={() => {}} />
    )
    expect(view).toContain('Il profilo di questo tipo non chiede nessun campo')
    expect(view).toContain('il revisore non ha compilato campi fuori dal profilo')
  })

  it('ogni campo del profilo ha il pulsante per insegnare un’etichetta al motore', () => {
    const view = text(<ProfileFields measure={measure()} disabled={false} onEdit={() => {}} />)
    // Uno per ognuno dei due campi del profilo; il candidato all'aggiunta non ce l'ha.
    expect(count(view, "Aggiungi un'etichetta")).toBe(2)
  })

  it('i campi bloccati quando c’è un’operazione in corso', () => {
    const markup = html(<ProfileFields measure={measure()} disabled onEdit={() => {}} />)
    expect(markup).toContain('disabled=""')
  })
})
