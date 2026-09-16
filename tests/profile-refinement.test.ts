import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
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
  editTypeProfile,
  type RefinementDeps,
  rerunTypeExtraction
} from '../src/main/profile-refinement'
import { readRegistrySourceFiles } from '../src/main/profile-store'
import { submitReview } from '../src/main/review'
import {
  fixture,
  REGISTRY_DIR,
  REGISTRY_V2_DIR,
  testClassifierConfigV2,
  testLegacyFieldMap,
  testRegistry
} from './helpers/registry'

/**
 * Il ciclo intero su documenti veri: si annota, si misura, si corregge l'istruzione con
 * un commit, si rielabora dalla cache e si guarda il prima/dopo.
 *
 * I JSON del registry vengono copiati in un repo git usa e getta: le correzioni sono
 * scritture vere su file veri, e il commit lo fa git.
 */

const PDF = 'application/pdf'
const FATTURA = 'accounting.fattura'
/** I quattro file che il caricatore dei profili legge dalla cartella v2. */
const V2_FILES = [
  'class_extraction_profiles_v2.json',
  'field_ontology_v2.json',
  'extraction_hints_v2.json',
  'legacy_field_map_v2.json'
]

const workdirs: string[] = []
afterAll(() => {
  for (const directory of workdirs) rmSync(directory, { recursive: true, force: true })
})

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim()
}

function registryCopy(): string {
  const directory = mkdtempSync(join(tmpdir(), 'reviewer-registry-'))
  workdirs.push(directory)
  for (const file of V2_FILES) {
    copyFileSync(join(REGISTRY_V2_DIR, file), join(directory, file))
  }
  git(directory, 'init', '--quiet', '--initial-branch=main')
  git(directory, 'config', 'user.email', 'test@example.com')
  git(directory, 'config', 'user.name', 'Test')
  git(directory, 'config', 'commit.gpgsign', 'false')
  git(directory, 'add', '.')
  git(directory, 'commit', '--quiet', '-m', 'snapshot del registry')
  return directory
}

async function setup() {
  const directory = registryCopy()
  const registry = testRegistry()
  const extractionRegistryV2 = createReloadableExtractionRegistryV2(directory, REGISTRY_DIR)
  const db = openDatabase({ file: ':memory:' })
  const repo = createRepository(db, {
    requiredFields: (type) => registry.requiredFor(type),
    typeLabel: (type) => registry.label(type)
  })
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
    registryDirectory: directory,
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

  return { directory, repo, db, deps, open, field, measure, measured }
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

describe('togliere un campo che quel tipo non ha', () => {
  it('lo segnala come mai usato, lo toglie con un commit e lo fa sparire dai documenti', async () => {
    const { directory, deps, measured, db } = await annotated()

    // `procurement.cig` è nel profilo della fattura, ma su nessuna delle due compare.
    expect(measured('procurement.cig')).toMatchObject({
      signal: 'NEVER_USED',
      documents: 2,
      filled: 0,
      role: 'conditional'
    })

    const outcome = await editTypeProfile(deps, {
      kind: 'REMOVE_FIELD',
      documentType: FATTURA,
      fieldId: 'procurement.cig'
    })

    expect(outcome.write.mode).toBe('COMMITTED')
    expect(git(directory, 'log', '-1', '--format=%s')).toBe(
      'profile(accounting.fattura): rimuove procurement.cig, mai usato su 2 documenti'
    )
    expect(git(directory, 'show', '--name-only', '--format=', 'HEAD')).toBe(
      'class_extraction_profiles_v2.json'
    )

    // Il JSON resta valido e completo: 500 profili, meno un campo.
    const source = readRegistrySourceFiles(directory)
    expect(Object.keys(source.profiles.profiles)).toHaveLength(500)
    expect(source.profiles.profiles[FATTURA]!.conditional_fields).not.toContain('procurement.cig')

    // Il registry è stato riletto: il re-run lavora col profilo nuovo.
    expect(deps.registry.profile(FATTURA)!.conditional_fields).not.toContain('procurement.cig')

    const rerun = await rerunTypeExtraction(deps, FATTURA)
    expect(rerun.processed).toHaveLength(2)
    expect(rerun.failed).toEqual([])
    expect(rerun.after.fields.map((entry) => entry.fieldId)).not.toContain('procurement.cig')

    const gone = rerun.delta.fields.find((entry) => entry.fieldId === 'procurement.cig')!
    expect(gone.before).not.toBeNull()
    expect(gone.after).toBeNull()

    db.close()
  })
})

describe('insegnare al motore l’etichetta che gli manca', () => {
  it('porta il campo da «scritto a mano» a «confermato», e il delta lo dimostra', async () => {
    const { directory, deps, measured, repo, native, field, db } = await annotated()

    expect(measured('issuer.tax_id')).toMatchObject({ manual: 1, confirmed: 0, manualRate: 0.5 })

    const outcome = await editTypeProfile(deps, {
      kind: 'ADD_HINT_LABEL',
      documentType: FATTURA,
      fieldId: 'issuer.tax_id',
      label: 'Partita IVA'
    })

    expect(outcome.write.mode).toBe('COMMITTED')
    expect(git(directory, 'log', '-1', '--format=%s')).toBe(
      "hints(issuer.tax_id): aggiunge l'etichetta «Partita IVA»"
    )
    // Tocca solo gli hint: il profilo non c'entra.
    expect(git(directory, 'show', '--name-only', '--format=', 'HEAD')).toBe(
      'extraction_hints_v2.json'
    )

    const rerun = await rerunTypeExtraction(deps, FATTURA)

    // Ora il motore lo trova, e propone proprio il valore che il revisore aveva scritto:
    // quella non è più una correzione.
    expect(field(native, 'issuer.tax_id').value).toBe('01234567890')
    const after = rerun.after.fields.find((entry) => entry.fieldId === 'issuer.tax_id')!
    expect(after).toMatchObject({ manual: 0, confirmed: 1, corrected: 0 })

    const moved = rerun.delta.fields.find((entry) => entry.fieldId === 'issuer.tax_id')!
    expect(moved.before!.manualRate).toBe(0.5)
    expect(moved.after!.manualRate).toBe(0)
    expect(moved.manualRateChange).toBe(-0.5)
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

describe('il giro completo: togliere, rielaborare, rimettere', () => {
  it('la correzione del revisore sopravvive e il campo torna candidato all’aggiunta', async () => {
    const { directory, deps, repo, withRows, field, measured, db } = await annotated()

    // Il revisore corregge l'imponibile: il motore aveva letto 5500,00, lui mette altro.
    updateFieldValue(repo, {
      documentId: withRows,
      fieldId: field(withRows, 'money.taxable').id,
      correctedValue: '5500.50'
    })
    expect(measured('money.taxable')).toMatchObject({
      inProfile: true,
      role: 'core',
      confirmed: 1,
      corrected: 1
    })

    // 1. Si toglie dal profilo. Il campo era usato, e il commit non dice il contrario.
    await editTypeProfile(deps, {
      kind: 'REMOVE_FIELD',
      documentType: FATTURA,
      fieldId: 'money.taxable'
    })
    expect(git(directory, 'log', '-1', '--format=%s')).toBe(
      'profile(accounting.fattura): rimuove money.taxable, usato su 2 di 2 documenti'
    )
    expect(git(directory, 'log', '-1', '--format=%b')).toContain('la decisione è del revisore')

    // 2. Si rielabora: il motore non chiede più il campo, ma la correzione resta.
    await rerunTypeExtraction(deps, FATTURA)
    const kept = field(withRows, 'money.taxable')
    expect(kept.correctedValue).toBe('5500.50')
    expect(measured('money.taxable')).toMatchObject({
      inProfile: false,
      role: null,
      signal: 'MISSING_FROM_PROFILE',
      filled: 1
    })

    // 3. Era un errore: si rimette, col peso scelto.
    await editTypeProfile(deps, {
      kind: 'ADD_FIELD',
      documentType: FATTURA,
      fieldId: 'money.taxable',
      role: 'optional'
    })
    expect(git(directory, 'log', '-1', '--format=%s')).toBe(
      'profile(accounting.fattura): aggiunge money.taxable come opzionale, richiesto su 1 documento'
    )
    expect(
      readRegistrySourceFiles(directory).profiles.profiles[FATTURA]!.optional_fields
    ).toContain('money.taxable')

    const back = await rerunTypeExtraction(deps, FATTURA)
    expect(back.after.fields.find((entry) => entry.fieldId === 'money.taxable')).toMatchObject({
      inProfile: true,
      role: 'optional',
      confirmed: 1,
      corrected: 1
    })
    expect(field(withRows, 'money.taxable').correctedValue).toBe('5500.50')

    db.close()
  })
})

describe('re-run: cosa resta fuori', () => {
  it('salta i documenti senza copia locale invece di riscaricarli', async () => {
    const { deps, repo, native, db } = await annotated()
    repo.documents.setCachedPath(native, null)

    const rerun = await rerunTypeExtraction(deps, FATTURA)
    expect(rerun.processed).toHaveLength(1)
    expect(rerun.skipped).toHaveLength(1)
    expect(rerun.skipped[0]!.filename).toBe('fattura-nativa.pdf')
    expect(rerun.skipped[0]!.reason).toContain('copia locale')
    expect(rerun.retyped).toEqual([])

    db.close()
  })

  it('un tipo senza documenti annotati non si rielabora', async () => {
    const { deps, db } = await setup()
    await expect(rerunTypeExtraction(deps, FATTURA)).rejects.toThrow(/Nessun documento annotato/)
    db.close()
  })
})

describe('correzioni impossibili', () => {
  it('si fermano con una frase leggibile, senza toccare i file', async () => {
    const { directory, deps, db } = await annotated()
    const head = git(directory, 'rev-parse', 'HEAD')

    await expect(
      editTypeProfile(deps, {
        kind: 'REMOVE_FIELD',
        documentType: FATTURA,
        fieldId: 'insurance.premium'
      })
    ).rejects.toThrow(/non chiede «insurance.premium»/)

    expect(git(directory, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(directory, 'status', '--porcelain')).toBe('')
    db.close()
  })
})
