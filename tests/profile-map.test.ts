import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/db'
import { createRepository } from '../src/main/db/repository'
import { createReloadableExtractionRegistry } from '../src/main/extract/v2/profile-loader'
import { updateFieldValue } from '../src/main/field-edits'
import { createDocumentProcessor } from '../src/main/pipeline'
import { collectTypeMeasure } from '../src/main/profile-insights'
import {
  collectActivity,
  editProfileMap,
  exportProfileBundle,
  revertProfileAction
} from '../src/main/profile-map'
import { editMapFromDocument, type RefinementDeps } from '../src/main/profile-refinement'
import { submitReview } from '../src/main/review'
import {
  CHANGELOG_FILE,
  DOCUMENT_FIELDS_FILE,
  type DocumentFieldsFile,
  FIELDS_FILE,
  type FieldsFile,
  SCHEMAS_FILE
} from '../src/shared/profile-bundle'
import { fixture, REGISTRY_DIR } from './helpers/registry'

/**
 * Il tipo di una fixture, come lo sceglierebbe il revisore aprendola: senza tipo non c'è
 * una mappa di campi, e il documento resterebbe vuoto.
 */
const TYPE_OF: Record<string, string> = {
  'fattura-nativa.pdf': 'accounting.fattura',
  'fattura-righe.pdf': 'accounting.fattura',
  'fattura-riepilogo-iva.pdf': 'accounting.fattura',
  'contratto-consulenza.docx': 'contracts_general.contratto_consulenza',
  'durc-scansionato.pdf': 'payroll_contributions.durc',
  'promemoria-ignoto.pdf': 'payments_treasury.richiesta_pagamento'
}

/**
 * Il ciclo intero su documenti veri: si annota, si misura, si corregge la mappa dal
 * documento aperto, che si rielabora dalla cache, e si guardano i numeri. Poi si annulla,
 * e alla fine si esporta.
 *
 * La cartella del registry qui è quella vera del repo, e resta intatta: è il punto della
 * migrazione 0008. Le correzioni stanno nel database in memoria di questo test, e i file
 * escono solo dall'export, in una cartella temporanea.
 */

const PDF = 'application/pdf'
const FATTURA = 'accounting.fattura'

const workdirs: string[] = []
afterAll(() => {
  for (const directory of workdirs) rmSync(directory, { recursive: true, force: true })
})

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'reviewer-export-'))
  workdirs.push(directory)
  return directory
}

async function setup() {
  const db = openDatabase({ file: ':memory:' })
  let registry: ReturnType<typeof createReloadableExtractionRegistry>
  const repo = createRepository(db, {
    requiredFields: (type) => (type ? (registry.baseProfile(type)?.required_fields ?? []) : []),
    typeLabel: (type) => (type ? (registry.baseProfile(type)?.canonical_name ?? null) : null)
  })
  registry = createReloadableExtractionRegistry(REGISTRY_DIR, () => repo.profileMap.overlay())
  const extractionRegistry = registry
  const process = createDocumentProcessor({ repo, extractionRegistry })

  const deps: RefinementDeps = {
    repo,
    registry: extractionRegistry,
    registryDirectory: REGISTRY_DIR,
    typeLabel: (type) => registry.baseProfile(type)?.canonical_name ?? null,
    process
  }

  /** Scarica (dalla cartella delle fixture) ed elabora, come farebbe l'apertura da Drive. */
  async function open(filename: string) {
    const { id } = repo.documents.upsertFromDrive({
      driveFileId: `drive-${filename}`,
      filename,
      mime: PDF,
      receivedAt: '2026-09-10T08:00:00.000Z'
    })
    repo.documents.setCachedPath(id, fixture(filename))
    if (TYPE_OF[filename]) repo.documents.setType(id, TYPE_OF[filename]!, null)
    await process({ documentId: id, cachedPath: fixture(filename), mime: PDF, filename })
    return id
  }

  const field = (id: string, name: string) =>
    repo.getReviewDocument(id)!.fields.find((candidate) => candidate.name === name)!

  const measure = () => collectTypeMeasure(deps, FATTURA)!
  const measured = (fieldId: string) => measure().fields.find((entry) => entry.fieldId === fieldId)

  return { repo, db, deps, open, field, measure, measured }
}

/** Due fatture vere, annotate: una col numero corretto a mano, una col codice fiscale scritto. */
async function annotated() {
  const context = await setup()
  const { repo, open, field } = context

  const withRows = await open('fattura-righe.pdf')
  updateFieldValue(repo, {
    documentId: withRows,
    fieldId: field(withRows, 'document.number').id,
    correctedValue: '27/2026/B'
  })
  submitReview(repo, { documentId: withRows, action: 'SAVE' })

  const native = await open('fattura-nativa.pdf')
  // Il documento porta solo «Partita IVA: 01234567890». Per una S.r.l. è anche il codice
  // fiscale, ma nessuna etichetta del campo lo dice: il motore non lo trova e il revisore
  // lo scrive a mano.
  expect(field(native, 'issuer.tax_code').value).toBe('')
  updateFieldValue(repo, {
    documentId: native,
    fieldId: field(native, 'issuer.tax_code').id,
    correctedValue: '01234567890'
  })
  submitReview(repo, { documentId: native, action: 'SAVE' })

  return { ...context, withRows, native }
}

describe('segnare non utile un campo che quel tipo non ha', () => {
  it('lo toglie al motore senza toccare i JSON, e resta scritto che è stato scartato', async () => {
    const { deps, repo, measured, db } = await annotated()

    // `procurement.cig` è nella mappa della fattura, ma su nessuna delle due compare.
    expect(measured('procurement.cig')).toMatchObject({
      signal: 'NEVER_USED',
      documents: 2,
      filled: 0,
      role: 'optional'
    })

    const before = readFileSync(join(REGISTRY_DIR, DOCUMENT_FIELDS_FILE), 'utf8')

    const action = editProfileMap(deps, {
      kind: 'REMOVE_FIELD',
      documentType: FATTURA,
      fieldId: 'procurement.cig'
    })

    expect(action.kind).toBe('REMOVE_FIELD')
    expect(action.after).toBe('excluded')
    expect(action.detail).toContain('mai avuto un valore')
    expect(action.reason).toMatchObject({ documents: 2, confirmed: 0, corrected: 0, manual: 0 })

    // Il file del registry non è stato toccato: la decisione sta nel database.
    expect(readFileSync(join(REGISTRY_DIR, DOCUMENT_FIELDS_FILE), 'utf8')).toBe(before)
    expect(repo.profileMap.forType(FATTURA)).toEqual({ 'procurement.cig': 'excluded' })

    // Ma il motore vede già la mappa corretta, senza rileggere niente.
    expect(deps.registry.profile(FATTURA)!.optional_fields).not.toContain('procurement.cig')
    expect(deps.registry.baseProfile(FATTURA)!.optional_fields).toContain('procurement.cig')

    // E il campo resta in elenco come decisione presa, non sparisce.
    expect(measured('procurement.cig')).toMatchObject({
      signal: 'EXCLUDED',
      decision: 'excluded',
      inProfile: false
    })

    db.close()
  })
})

describe('aggiungere un campo che nessun documento ha mai portato', () => {
  it('entra nella mappa e il motore comincia a cercarlo', async () => {
    const { deps, measured, native, db } = await annotated()

    expect(measured('document.title')).toBeUndefined()

    const result = await editMapFromDocument(deps, native, {
      kind: 'ADD_FIELD',
      documentType: FATTURA,
      fieldId: 'document.title',
      role: 'optional'
    })

    expect(result.action.after).toBe('optional')
    expect(deps.registry.profile(FATTURA)!.optional_fields).toContain('document.title')

    // Il documento da cui è partita la correzione ha già il campo nuovo.
    expect(result.reprocessed).toBe(true)
    expect(result.document.fields.map((entry) => entry.name)).toContain('document.title')
    expect(
      result.map.measure.fields.find((entry) => entry.fieldId === 'document.title')
    ).toMatchObject({ inProfile: true, role: 'optional' })

    db.close()
  })

  it('un campo che l’ontologia non conosce si ferma, con una frase leggibile', async () => {
    const { deps, db } = await annotated()

    expect(() =>
      editProfileMap(deps, {
        kind: 'ADD_FIELD',
        documentType: FATTURA,
        fieldId: 'campo.inventato',
        role: 'optional'
      })
    ).toThrow(/non è un campo dell'ontologia/)
    expect(deps.repo.profileMap.listActions()).toEqual([])

    db.close()
  })
})

describe('insegnare al motore l’etichetta che gli manca', () => {
  it('porta il campo da «scritto a mano» a «confermato» sul documento aperto', async () => {
    const { deps, measured, repo, native, field, db } = await annotated()

    expect(measured('issuer.tax_code')).toMatchObject({
      manual: 1,
      confirmed: 0,
      manualRate: 0.5
    })

    // Una correzione su un altro campo, che la rielaborazione non deve perdere.
    const number = field(native, 'document.number')
    updateFieldValue(repo, { documentId: native, fieldId: number.id, correctedValue: '99/2026' })

    const result = await editMapFromDocument(deps, native, {
      kind: 'ADD_HINT_LABEL',
      documentType: FATTURA,
      fieldId: 'issuer.tax_code',
      label: 'Partita IVA'
    })

    expect(deps.registry.hints('issuer.tax_code')).toContain('Partita IVA')

    // Ora il motore lo trova, e propone proprio il valore che il revisore aveva scritto:
    // quella non è più una correzione.
    expect(field(native, 'issuer.tax_code').value).toBe('01234567890')
    expect(
      result.map.measure.fields.find((entry) => entry.fieldId === 'issuer.tax_code')
    ).toMatchObject({ manual: 0, confirmed: 1, corrected: 0 })

    // Le correzioni del revisore sopravvivono alla rielaborazione.
    const after = result.document.fields.find((entry) => entry.name === 'document.number')!
    expect(after.value).toBe(number.value)
    expect(after.correctedValue).toBe('99/2026')

    db.close()
  })
})

describe('uno o più valori', () => {
  it('il campo cambia forma sul documento aperto, senza perdere quello che il revisore aveva scritto', async () => {
    const { deps, repo, open, field, db } = await setup()
    const id = await open('fattura-nativa.pdf')

    expect(field(id, 'document.number')).toMatchObject({ cardinality: 'one', value: '114/2026' })
    updateFieldValue(repo, {
      documentId: id,
      fieldId: field(id, 'document.number').id,
      correctedValue: '114/2026/A'
    })

    const toMany = await editMapFromDocument(deps, id, {
      kind: 'SET_CARDINALITY',
      documentType: FATTURA,
      fieldId: 'document.number',
      cardinality: 'many'
    })

    expect(toMany.action).toMatchObject({ kind: 'SET_CARDINALITY', before: 'one', after: 'many' })
    expect(toMany.action.detail).toBe(
      '«Numero documento» (document.number) passa da un solo valore a più valori su accounting.fattura.'
    )
    expect(repo.profileMap.cardinalityForType(FATTURA)).toEqual({ 'document.number': 'many' })
    // Il peso non c'entra: la mappa dei campi resta quella del registry.
    expect(repo.profileMap.forType(FATTURA)).toEqual({})
    expect(deps.registry.profile(FATTURA)!.field_cardinality).toEqual({ 'document.number': 'many' })

    // Il documento si è rielaborato: il numero è un elenco, e la correzione è sulla sua riga.
    const many = toMany.document.fields.find((entry) => entry.name === 'document.number')!
    expect(many.cardinality).toBe('many')
    expect(many.items.map((item) => [item.value, item.correctedValue])).toEqual([
      ['114/2026', '114/2026/A']
    ])
    expect(
      toMany.map.measure.fields.find((entry) => entry.fieldId === 'document.number')
    ).toMatchObject({ cardinality: 'many', cardinalityDecision: 'many' })
    expect(toMany.map.undoable.map((action) => action.id)).toEqual([toMany.action.id])

    // Il revisore aggiunge un secondo numero, poi ci ripensa: il campo ne chiede uno solo.
    repo.fields.addItem(many.id, '115/2026')
    const toOne = await editMapFromDocument(deps, id, {
      kind: 'SET_CARDINALITY',
      documentType: FATTURA,
      fieldId: 'document.number',
      cardinality: 'one'
    })

    expect(toOne.action.detail).toContain("come dice l'ontologia")
    expect(repo.profileMap.cardinalityForType(FATTURA)).toEqual({})
    // Nessun valore sparisce: le due righe finiscono nella correzione, da sistemare in «Dati».
    expect(field(id, 'document.number')).toMatchObject({
      cardinality: 'one',
      value: '114/2026',
      correctedValue: '114/2026/A; 115/2026'
    })

    // Tutto in cronologia, e si annulla solo l'ultima decisione sul numero di valori.
    expect(repo.profileMap.countStandingEdits()).toBe(2)
    const titles = collectActivity(deps)
      .filter((entry) => entry.source === 'MAP')
      .map((entry) => [entry.title, entry.revertable])
    expect(titles).toEqual([
      ['Numero di valori cambiato', true],
      ['Numero di valori cambiato', false]
    ])
    expect(() => revertProfileAction(deps, toMany.action.id)).toThrow(/decisione più recente/)

    const undo = revertProfileAction(deps, toOne.action.id)
    expect(undo).toMatchObject({ kind: 'REVERT', before: 'one', after: 'many' })
    expect(repo.profileMap.cardinalityForType(FATTURA)).toEqual({ 'document.number': 'many' })
    revertProfileAction(deps, toMany.action.id)
    expect(repo.profileMap.cardinalityForType(FATTURA)).toEqual({})
    expect(repo.profileMap.countStandingEdits()).toBe(0)

    db.close()
  })

  it('un peso cambiato dopo non blocca l’annullamento del numero di valori', async () => {
    const { deps, repo, db } = await setup()

    const cardinality = editProfileMap(deps, {
      kind: 'SET_CARDINALITY',
      documentType: FATTURA,
      fieldId: 'bank.iban',
      cardinality: 'many'
    })
    editProfileMap(deps, {
      kind: 'SET_ROLE',
      documentType: FATTURA,
      fieldId: 'bank.iban',
      role: 'optional'
    })

    revertProfileAction(deps, cardinality.id)
    expect(repo.profileMap.cardinalityForType(FATTURA)).toEqual({})
    expect(repo.profileMap.forType(FATTURA)).toEqual({ 'bank.iban': 'optional' })

    db.close()
  })

  it('un campo fuori dalla mappa non ha un numero di valori da decidere', async () => {
    const { deps, db } = await setup()

    expect(() =>
      editProfileMap(deps, {
        kind: 'SET_CARDINALITY',
        documentType: FATTURA,
        fieldId: 'document.title',
        cardinality: 'many'
      })
    ).toThrow(/prima va aggiunto/)
    expect(deps.repo.profileMap.listActions()).toEqual([])

    db.close()
  })
})

describe('annullare una correzione', () => {
  it('rimette quello che diceva il registry e resta scritto che è successo', async () => {
    const { deps, repo, measured, db } = await annotated()

    const removed = editProfileMap(deps, {
      kind: 'REMOVE_FIELD',
      documentType: FATTURA,
      fieldId: 'procurement.cig'
    })
    const revert = revertProfileAction(deps, removed.id)

    expect(revert.kind).toBe('REVERT')
    expect(revert.revertsId).toBe(removed.id)
    expect(repo.profileMap.forType(FATTURA)).toEqual({})
    expect(deps.registry.profile(FATTURA)!.optional_fields).toContain('procurement.cig')
    expect(measured('procurement.cig')).toMatchObject({ role: 'optional', decision: null })

    // L'azione annullata resta in cronologia, marcata.
    expect(repo.profileMap.getAction(removed.id)!.revertedAt).not.toBeNull()
    expect(repo.profileMap.countStandingEdits()).toBe(0)

    db.close()
  })

  it('un peso cambiato torna al peso del registry, non a «nessuna decisione»', async () => {
    const { deps, repo, db } = await annotated()

    const first = editProfileMap(deps, {
      kind: 'SET_ROLE',
      documentType: FATTURA,
      fieldId: 'money.taxable',
      role: 'required'
    })
    expect(deps.registry.profile(FATTURA)!.required_fields).toContain('money.taxable')

    revertProfileAction(deps, first.id)

    expect(repo.profileMap.forType(FATTURA)).toEqual({})
    expect(deps.registry.profile(FATTURA)!.optional_fields).toContain('money.taxable')

    db.close()
  })

  it('la stessa azione non si annulla due volte, e non si scavalca una più recente', async () => {
    const { deps, db } = await annotated()

    const removed = editProfileMap(deps, {
      kind: 'REMOVE_FIELD',
      documentType: FATTURA,
      fieldId: 'procurement.cig'
    })
    revertProfileAction(deps, removed.id)
    expect(() => revertProfileAction(deps, removed.id)).toThrow(/già stata annullata/)

    const older = editProfileMap(deps, {
      kind: 'REMOVE_FIELD',
      documentType: FATTURA,
      fieldId: 'procurement.cup'
    })
    editProfileMap(deps, {
      kind: 'ADD_FIELD',
      documentType: FATTURA,
      fieldId: 'procurement.cup',
      role: 'optional'
    })
    expect(() => revertProfileAction(deps, older.id)).toThrow(/decisione più recente/)

    db.close()
  })
})

describe('la cronologia', () => {
  it('mette le correzioni accanto alle annotazioni che le hanno motivate', async () => {
    const { deps, db } = await annotated()

    editProfileMap(deps, {
      kind: 'REMOVE_FIELD',
      documentType: FATTURA,
      fieldId: 'procurement.cig'
    })

    const activity = collectActivity(deps)
    const sources = new Set(activity.map((entry) => entry.source))
    expect(sources).toEqual(new Set(['MAP', 'DOCUMENT']))

    const map = activity.filter((entry) => entry.source === 'MAP')
    expect(map.map((entry) => entry.title)).toContain('Campo segnato non utile')

    const documents = activity.filter((entry) => entry.source === 'DOCUMENT')
    expect(documents.some((entry) => entry.filename === 'fattura-nativa.pdf')).toBe(true)

    // In ordine di tempo, dal più recente.
    const times = activity.map((entry) => entry.at)
    expect([...times].sort((a, b) => b.localeCompare(a))).toEqual(times)

    db.close()
  })
})

describe('l’export della mappa corretta', () => {
  it('scrive i quattro file nella cartella scelta e lascia intatto il registry', async () => {
    const { deps, db } = await annotated()
    const before = readFileSync(join(REGISTRY_DIR, FIELDS_FILE), 'utf8')

    editProfileMap(deps, {
      kind: 'REMOVE_FIELD',
      documentType: FATTURA,
      fieldId: 'procurement.cig'
    })
    editProfileMap(deps, {
      kind: 'ADD_HINT_LABEL',
      documentType: FATTURA,
      fieldId: 'issuer.tax_code',
      label: 'Partita IVA'
    })

    const directory = join(tempDir(), 'mappa-tipi-2026-09-17')
    const bundle = await exportProfileBundle(
      deps,
      {
        app: { name: 'praticaai-reviewer', version: '1.3.0' },
        schemaVersion: '2.0.0',
        exportedAt: '2026-09-17T09:00:00.000Z'
      },
      directory
    )

    expect(bundle.paths).toHaveLength(4)
    expect(bundle.types).toBe(1)
    expect(bundle.edits).toBe(2)

    const map = JSON.parse(
      readFileSync(join(directory, DOCUMENT_FIELDS_FILE), 'utf8')
    ) as DocumentFieldsFile
    expect(map.document_types[FATTURA]!.optional_fields).not.toContain('procurement.cig')
    expect(map.document_types[FATTURA]!.x_reviewer_excluded_fields).toEqual(['procurement.cig'])

    const catalog = JSON.parse(readFileSync(join(directory, FIELDS_FILE), 'utf8')) as FieldsFile
    expect(catalog.fields['issuer.tax_code']!.label_aliases_it).toContain('Partita IVA')

    const schemas = JSON.parse(readFileSync(join(directory, SCHEMAS_FILE), 'utf8')) as Record<
      string,
      { properties: Record<string, unknown> }
    >
    expect(Object.keys(schemas[FATTURA]!.properties)).not.toContain('procurement.cig')
    // Le chiavi che il pack non ha escono con la loro forma, e quelle che hanno sostituito no.
    expect(schemas[FATTURA]!.properties['issuer.vat_number']).toMatchObject({
      type: 'string',
      'x-praticaai-validators': ['vat_number_format']
    })
    expect(Object.keys(schemas[FATTURA]!.properties)).not.toContain('issuer.tax_id')

    const changelog = JSON.parse(readFileSync(join(directory, CHANGELOG_FILE), 'utf8')) as {
      changes: Array<{ documentType: string; excluded: string[] }>
      actions: Array<{ kind: string }>
    }
    expect(changelog.changes[0]).toMatchObject({
      documentType: FATTURA,
      excluded: ['procurement.cig']
    })
    expect(changelog.actions.map((entry) => entry.kind)).toEqual(['REMOVE_FIELD', 'ADD_HINT_LABEL'])

    // Il registry del repo non è stato toccato, e l'export è finito in cronologia.
    expect(readFileSync(join(REGISTRY_DIR, FIELDS_FILE), 'utf8')).toBe(before)
    expect(deps.repo.profileMap.listActions()[0]!.kind).toBe('EXPORT')

    db.close()
  })
})
