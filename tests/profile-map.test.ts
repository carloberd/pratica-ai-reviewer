import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/db'
import { createRepository } from '../src/main/db/repository'
import { createReloadableExtractionRegistryV2 } from '../src/main/extract/v2/profile-loader'
import { updateFieldValue } from '../src/main/field-edits'
import { createDocumentProcessor } from '../src/main/pipeline'
import { collectTypeMeasure } from '../src/main/profile-insights'
import {
  collectActivity,
  editProfileMap,
  exportProfileBundle,
  revertProfileAction
} from '../src/main/profile-map'
import { type RefinementDeps, rerunTypeExtraction } from '../src/main/profile-refinement'
import { submitReview } from '../src/main/review'
import {
  CHANGELOG_FILE,
  HINTS_FILE,
  type HintsFile,
  PROFILES_FILE,
  type ProfilesFile,
  SCHEMAS_FILE
} from '../src/shared/profile-bundle'
import {
  fixture,
  REGISTRY_DIR,
  REGISTRY_V2_DIR,
  testClassifierConfigV2,
  testLegacyFieldMap,
  testRegistry
} from './helpers/registry'

/**
 * Il ciclo intero su documenti veri: si annota, si misura, si corregge la mappa, si
 * rielabora dalla cache e si guarda il prima/dopo. Poi si annulla, e alla fine si
 * esporta.
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
  const registry = testRegistry()
  const db = openDatabase({ file: ':memory:' })
  const repo = createRepository(db, {
    requiredFields: (type) => registry.requiredFor(type),
    typeLabel: (type) => registry.label(type)
  })
  const extractionRegistryV2 = createReloadableExtractionRegistryV2(
    REGISTRY_V2_DIR,
    REGISTRY_DIR,
    () => repo.profileMap.overlay()
  )
  const process = createDocumentProcessor({
    repo,
    registry,
    engines: { classifier: 'v2', extraction: 'v2' },
    classifierConfigV2: testClassifierConfigV2(),
    extractionRegistryV2,
    legacyFieldMap: testLegacyFieldMap()
  })

  const deps: RefinementDeps = {
    repo,
    registry: extractionRegistryV2,
    registryDirectory: REGISTRY_V2_DIR,
    typeLabel: (type) => registry.label(type),
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
    await process({ documentId: id, cachedPath: fixture(filename), mime: PDF, filename })
    return id
  }

  const field = (id: string, name: string) =>
    repo.getReviewDocument(id)!.fields.find((candidate) => candidate.name === name)!

  const measure = () => collectTypeMeasure(deps, FATTURA)!
  const measured = (fieldId: string) => measure().fields.find((entry) => entry.fieldId === fieldId)

  return { repo, db, deps, open, field, measure, measured }
}

/** Due fatture vere, annotate: una col numero corretto a mano, una con la P.IVA scritta. */
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
  // Il documento porta «Partita IVA: 01234567890», che gli hint del campo non conoscono:
  // il motore non lo trova e il revisore lo scrive a mano.
  expect(field(native, 'issuer.tax_id').value).toBe('')
  updateFieldValue(repo, {
    documentId: native,
    fieldId: field(native, 'issuer.tax_id').id,
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
      role: 'conditional'
    })

    const before = readFileSync(join(REGISTRY_V2_DIR, PROFILES_FILE), 'utf8')

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
    expect(readFileSync(join(REGISTRY_V2_DIR, PROFILES_FILE), 'utf8')).toBe(before)
    expect(repo.profileMap.forType(FATTURA)).toEqual({ 'procurement.cig': 'excluded' })

    // Ma il motore vede già la mappa corretta, senza rileggere niente.
    expect(deps.registry.profile(FATTURA)!.conditional_fields).not.toContain('procurement.cig')
    expect(deps.registry.baseProfile(FATTURA)!.conditional_fields).toContain('procurement.cig')

    // E il campo resta in elenco come decisione presa, non sparisce.
    expect(measured('procurement.cig')).toMatchObject({
      signal: 'EXCLUDED',
      decision: 'excluded',
      inProfile: false
    })

    const rerun = await rerunTypeExtraction(deps, FATTURA)
    expect(rerun.processed).toHaveLength(2)
    expect(rerun.failed).toEqual([])
    expect(rerun.after.fields.find((entry) => entry.fieldId === 'procurement.cig')).toMatchObject({
      inProfile: false
    })

    db.close()
  })
})

describe('aggiungere un campo che nessun documento ha mai portato', () => {
  it('entra nella mappa e il motore comincia a cercarlo', async () => {
    const { deps, measured, db } = await annotated()

    expect(measured('document.title')).toBeUndefined()

    const action = editProfileMap(deps, {
      kind: 'ADD_FIELD',
      documentType: FATTURA,
      fieldId: 'document.title',
      role: 'optional'
    })

    expect(action.after).toBe('optional')
    expect(deps.registry.profile(FATTURA)!.optional_fields).toContain('document.title')

    const rerun = await rerunTypeExtraction(deps, FATTURA)
    expect(rerun.after.fields.map((entry) => entry.fieldId)).toContain('document.title')

    db.close()
  })

  it('un campo che l’ontologia non conosce si ferma, con una frase leggibile', async () => {
    const { deps, db } = await annotated()

    expect(() =>
      editProfileMap(deps, {
        kind: 'ADD_FIELD',
        documentType: FATTURA,
        fieldId: 'campo.inventato',
        role: 'core'
      })
    ).toThrow(/non è un campo dell'ontologia/)
    expect(deps.repo.profileMap.listActions()).toEqual([])

    db.close()
  })
})

describe('insegnare al motore l’etichetta che gli manca', () => {
  it('porta il campo da «scritto a mano» a «confermato», e il delta lo dimostra', async () => {
    const { deps, measured, repo, native, field, db } = await annotated()

    expect(measured('issuer.tax_id')).toMatchObject({ manual: 1, confirmed: 0, manualRate: 0.5 })

    editProfileMap(deps, {
      kind: 'ADD_HINT_LABEL',
      documentType: FATTURA,
      fieldId: 'issuer.tax_id',
      label: 'Partita IVA'
    })

    expect(deps.registry.hints('issuer.tax_id')).toContain('Partita IVA')

    const rerun = await rerunTypeExtraction(deps, FATTURA)

    // Ora il motore lo trova, e propone proprio il valore che il revisore aveva scritto:
    // quella non è più una correzione.
    expect(field(native, 'issuer.tax_id').value).toBe('01234567890')
    expect(rerun.after.fields.find((entry) => entry.fieldId === 'issuer.tax_id')).toMatchObject({
      manual: 0,
      confirmed: 1,
      corrected: 0
    })

    const moved = rerun.delta.fields.find((entry) => entry.fieldId === 'issuer.tax_id')!
    expect(moved.before!.manualRate).toBe(0.5)
    expect(moved.after!.manualRate).toBe(0)
    expect(rerun.delta.unchanged).toBe(false)

    // Le correzioni del revisore sopravvivono al re-run: il numero corretto è ancora lì.
    const number = repo
      .getReviewDocument(rerun.processed.find((id) => id !== native)!)!
      .fields.find((entry) => entry.name === 'document.number')!
    expect(number.value).toBe('27/2026')
    expect(number.correctedValue).toBe('27/2026/B')

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
    expect(deps.registry.profile(FATTURA)!.conditional_fields).toContain('procurement.cig')
    expect(measured('procurement.cig')).toMatchObject({ role: 'conditional', decision: null })

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
      fieldId: 'issuer.tax_id',
      role: 'required'
    })
    expect(deps.registry.profile(FATTURA)!.required_fields).toContain('issuer.tax_id')

    revertProfileAction(deps, first.id)

    expect(repo.profileMap.forType(FATTURA)).toEqual({})
    expect(deps.registry.profile(FATTURA)!.core_fields).toContain('issuer.tax_id')

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
      role: 'core'
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
    await rerunTypeExtraction(deps, FATTURA)

    const activity = collectActivity(deps)
    const sources = new Set(activity.map((entry) => entry.source))
    expect(sources).toEqual(new Set(['MAP', 'DOCUMENT']))

    const map = activity.filter((entry) => entry.source === 'MAP')
    expect(map.map((entry) => entry.title)).toContain('Campo segnato non utile')
    expect(map.map((entry) => entry.title)).toContain('Documenti rielaborati')

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
    const before = readFileSync(join(REGISTRY_V2_DIR, HINTS_FILE), 'utf8')

    editProfileMap(deps, {
      kind: 'REMOVE_FIELD',
      documentType: FATTURA,
      fieldId: 'procurement.cig'
    })
    editProfileMap(deps, {
      kind: 'ADD_HINT_LABEL',
      documentType: FATTURA,
      fieldId: 'issuer.tax_id',
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

    const profiles = JSON.parse(
      readFileSync(join(directory, PROFILES_FILE), 'utf8')
    ) as ProfilesFile
    expect(profiles.profiles[FATTURA]!.conditional_fields).not.toContain('procurement.cig')
    expect(profiles.profiles[FATTURA]!.x_reviewer_excluded_fields).toEqual(['procurement.cig'])

    const hints = JSON.parse(readFileSync(join(directory, HINTS_FILE), 'utf8')) as HintsFile
    expect(hints.hints['issuer.tax_id']!.labels).toContain('Partita IVA')

    const schemas = JSON.parse(readFileSync(join(directory, SCHEMAS_FILE), 'utf8')) as Record<
      string,
      { properties: Record<string, unknown> }
    >
    expect(Object.keys(schemas[FATTURA]!.properties)).not.toContain('procurement.cig')

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
    expect(readFileSync(join(REGISTRY_V2_DIR, HINTS_FILE), 'utf8')).toBe(before)
    expect(deps.repo.profileMap.listActions()[0]!.kind).toBe('EXPORT')

    db.close()
  })
})
