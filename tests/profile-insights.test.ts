import type { ClassExtractionProfile, FieldOntologyEntry } from '@shared/extraction-v2'
import { afterEach, describe, expect, it } from 'vitest'
import type { FieldInput } from '../src/main/db/dao/fields'
import type { Repository } from '../src/main/db/repository'
import type { ExtractionRegistryV2, ProfileSource } from '../src/main/extract/v2/profile-loader'
import { collectTypeMap, collectTypeMeasure, profileFieldsOf } from '../src/main/profile-insights'
import { createTestRepository, seedDocument } from './helpers/db'

/**
 * Le misure lette dal database, con un caso per ogni segnale: confermato, corretto,
 * a mano, mai usato, richiesto ma assente dal profilo. Il registry è finto apposta —
 * quello vero ha 500 profili e qui serve sapere esattamente cosa chiede il profilo.
 */

const FATTURA = 'accounting.fattura'

function profile(overrides: Partial<ClassExtractionProfile> = {}): ClassExtractionProfile {
  return {
    document_type_id: FATTURA,
    canonical_name: 'fattura',
    family: 'accounting',
    schema_state: 'EXTRACTION_SCHEMA_DRAFT',
    evidence_basis: 'LEGACY_REGISTRY+AI_PROPOSED',
    required_fields: ['document.issue_date'],
    core_fields: ['document.number', 'issuer.name'],
    optional_fields: ['line_items'],
    conditional_fields: [],
    literal_evidence_required: true,
    unknown_value_policy: 'LEAVE_EMPTY',
    review_policy: 'REVIEW_LOW_CONFIDENCE_MISSING_REQUIRED_CONFLICTS_ONLY',
    ...overrides
  }
}

const LABELS: Record<string, string> = {
  'document.number': 'Numero documento',
  'document.issue_date': 'Data emissione',
  'issuer.name': 'Emittente',
  'bank.iban': 'IBAN',
  line_items: 'Righe documento'
}

function fakeRegistry(profiles: Record<string, ClassExtractionProfile>): ExtractionRegistryV2 {
  const field = (fieldId: string) =>
    LABELS[fieldId] ? ({ id: fieldId, label_it: LABELS[fieldId] } as FieldOntologyEntry) : null

  return {
    profile: (documentType) => profiles[documentType] ?? null,
    sections: () => [],
    baseProfile: (documentType) => profiles[documentType] ?? null,
    field,
    allFields: () =>
      Object.keys(LABELS)
        .map(field)
        .filter((entry): entry is FieldOntologyEntry => entry !== null),
    hints: () => [],
    profileSource: (documentType): ProfileSource =>
      profiles[documentType] ? 'V2_EXPLICIT' : 'MISSING',
    legacyNames: () => [],
    schemaVersion: () => '2.0.0'
  }
}

let open: Repository & { close: () => void }
afterEach(() => open?.close())

interface Seeded {
  filename: string
  fields: FieldInput[]
  /** Correzioni del revisore, per nome campo. `null` svuota una proposta. */
  corrections?: Record<string, string | null>
  status?: 'REVIEWED' | 'DISCARDED' | 'NEEDS_REVIEW'
  documentType?: string | null
}

function seed(repo: Repository, documents: Seeded[]): string[] {
  return documents.map((document, index) => {
    const id = seedDocument(repo, {
      driveFileId: `drive-${index}`,
      filename: document.filename
    })
    repo.documents.setType(id, document.documentType ?? FATTURA, 0.9)
    repo.fields.replaceForDocument(id, document.fields)
    for (const [name, value] of Object.entries(document.corrections ?? {})) {
      const field = repo.fields.listForDocument(id).find((row) => row.name === name)!
      repo.fields.setCorrectedValue(field.id, value)
    }
    const status = document.status ?? 'REVIEWED'
    if (status === 'NEEDS_REVIEW') repo.documents.setStatus(id, status)
    else repo.documents.setReviewOutcome(id, status, `2026-09-1${index}T10:00:00.000Z`)
    return id
  })
}

/** Un campo proposto dal motore, o vuoto se `value` è `null`. */
function field(name: string, value: string | null): FieldInput {
  return {
    name,
    label: LABELS[name] ?? name,
    value,
    confidence: value === null ? 0 : 0.85,
    role: 'core',
    cardinality: 'one'
  }
}

/** I tre documenti annotati del caso di prova, più il rumore che non deve votare. */
function scenario() {
  const repo = createTestRepository()
  open = repo
  seed(repo, [
    {
      filename: 'fattura-1.pdf',
      // «numero» chiesto dal profilo e mai trovato; emittente proposto e confermato.
      fields: [
        field('document.issue_date', '2026-09-14'),
        field('document.number', null),
        field('issuer.name', 'Alfa Costruzioni S.r.l.')
      ]
    },
    {
      filename: 'fattura-2.pdf',
      fields: [
        field('document.issue_date', '2026-09-15'),
        field('document.number', null),
        field('issuer.name', 'Beta Servizi'),
        // Il revisore lo aggiunge, il profilo non lo prevede.
        field('bank.iban', null)
      ],
      corrections: {
        'issuer.name': 'Beta Servizi S.p.A.',
        'bank.iban': 'IT60X0542811101000000123456'
      }
    },
    {
      filename: 'fattura-3.pdf',
      fields: [
        field('document.issue_date', '2026-09-16'),
        field('document.number', null),
        field('issuer.name', null),
        field('bank.iban', null)
      ],
      corrections: {
        'issuer.name': 'Gamma Immobiliare S.r.l.',
        'bank.iban': 'IT60X0542811101000000999999'
      }
    },
    // Scartato: il «numero» ce l'ha, ma non vota.
    {
      filename: 'fattura-scartata.pdf',
      fields: [field('document.number', '999/2026')],
      status: 'DISCARDED'
    },
    // Ancora in coda: nemmeno lui.
    {
      filename: 'fattura-in-coda.pdf',
      fields: [field('document.number', '888/2026')],
      status: 'NEEDS_REVIEW'
    }
  ])

  return {
    repo,
    deps: {
      repo,
      registry: fakeRegistry({ [FATTURA]: profile() }),
      typeLabel: () => 'fattura'
    }
  }
}

describe('misure sui profili dal database', () => {
  it('votano solo i documenti revisionati: scartati e in coda restano fuori', () => {
    const { deps } = scenario()

    const measure = collectTypeMeasure(deps, FATTURA)!
    expect(measure.totals.documents).toBe(3)
    expect(measure.documents.map((document) => document.filename)).toEqual([
      'fattura-3.pdf',
      'fattura-2.pdf',
      'fattura-1.pdf'
    ])
  })

  it('confermato, corretto e a mano finiscono ognuno nella sua colonna', () => {
    const { deps } = scenario()
    const measure = collectTypeMeasure(deps, FATTURA)!

    const date = measure.fields.find((entry) => entry.fieldId === 'document.issue_date')!
    expect(date).toMatchObject({ role: 'required', confirmed: 3, corrected: 0, manual: 0 })

    const issuer = measure.fields.find((entry) => entry.fieldId === 'issuer.name')!
    expect(issuer).toMatchObject({
      role: 'core',
      confirmed: 1,
      corrected: 1,
      manual: 1,
      manualRate: 0.3333
    })

    expect(measure.totals).toMatchObject({
      confirmed: 4,
      corrected: 1,
      manual: 3,
      outcomes: 8,
      confirmedRate: 0.5
    })
  })

  it('il «numero» mai usato è un candidato alla rimozione, col numero di documenti giusto', () => {
    const { deps } = scenario()
    const number = collectTypeMeasure(deps, FATTURA)!.fields.find(
      (entry) => entry.fieldId === 'document.number'
    )!

    expect(number.signal).toBe('NEVER_USED')
    expect(number.filled).toBe(0)
    expect(number.empty).toBe(3)
    expect(number.documents).toBe(3)
  })

  it('un campo del profilo che nessun documento porta conta come mai usato', () => {
    const { deps } = scenario()
    // `line_items` è nel profilo ma nessun documento ne ha nemmeno la riga.
    const lines = collectTypeMeasure(deps, FATTURA)!.fields.find(
      (entry) => entry.fieldId === 'line_items'
    )!
    expect(lines).toMatchObject({ signal: 'NEVER_USED', inProfile: true, empty: 3 })
  })

  it('l’IBAN che il revisore aggiunge sempre è un candidato all’aggiunta', () => {
    const { deps } = scenario()
    const iban = collectTypeMeasure(deps, FATTURA)!.fields.find(
      (entry) => entry.fieldId === 'bank.iban'
    )!
    expect(iban).toMatchObject({
      signal: 'MISSING_FROM_PROFILE',
      inProfile: false,
      role: null,
      manual: 2,
      label: 'IBAN'
    })
  })

  it('senza documenti annotati di quel tipo non ci sono misure da mostrare', () => {
    const { deps } = scenario()
    expect(collectTypeMeasure(deps, 'hr.unilav')).toBeNull()
  })

  it('la mappa di un tipo mai revisionato ha i campi del profilo, coi numeri a zero', () => {
    const { repo } = scenario()
    const deps = { repo, registry: fakeRegistry({ 'hr.unilav': profile() }) }
    const map = collectTypeMap(deps, 'hr.unilav')
    expect(map.totals.documents).toBe(0)
    expect(map.fields.map((entry) => entry.fieldId)).toEqual([
      'document.issue_date',
      'document.number',
      'issuer.name',
      'line_items'
    ])
    expect(map.fields.every((entry) => entry.inProfile && entry.signal === 'OK')).toBe(true)
  })

  it('la descrizione di un campo su un tipo arriva alla sua scheda', () => {
    const { repo } = scenario()
    const deps = {
      repo,
      registry: fakeRegistry({
        'hr.unilav': profile({
          field_description_overrides: { 'document.number': 'Il numero della comunicazione' }
        })
      })
    }
    const map = collectTypeMap(deps, 'hr.unilav')
    const note = (fieldId: string) => map.fields.find((f) => f.fieldId === fieldId)?.note
    expect(note('document.number')).toBe('Il numero della comunicazione')
    // Gli altri campi non hanno niente da aggiungere all'etichetta.
    expect(note('issuer.name')).toBeNull()
  })

  it('i profili verificati su documenti reali sono marcati', () => {
    const { repo } = scenario()
    const deps = {
      repo,
      registry: fakeRegistry({
        [FATTURA]: profile({ schema_state: 'EXTRACTION_SCHEMA_READY_FOR_FIELD_TEST' })
      })
    }
    expect(collectTypeMeasure(deps, FATTURA)!.fieldTested).toBe(true)
  })

  it('i campi del profilo escono nell’ordine dei ruoli', () => {
    const registry = fakeRegistry({ [FATTURA]: profile() })
    expect(profileFieldsOf(registry, FATTURA)).toEqual([
      { fieldId: 'document.issue_date', label: 'Data emissione', role: 'required' },
      { fieldId: 'document.number', label: 'Numero documento', role: 'core' },
      { fieldId: 'issuer.name', label: 'Emittente', role: 'core' },
      { fieldId: 'line_items', label: 'Righe documento', role: 'optional' }
    ])
    expect(profileFieldsOf(registry, 'ignoto.tipo')).toEqual([])
  })
})
