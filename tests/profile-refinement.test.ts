import { afterAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/db'
import { createRepository } from '../src/main/db/repository'
import { createReloadableExtractionRegistryV2 } from '../src/main/extract/v2/profile-loader'
import { updateFieldValue } from '../src/main/field-edits'
import { createDocumentProcessor } from '../src/main/pipeline'
import { type RefinementDeps, rerunTypeExtraction } from '../src/main/profile-refinement'
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
 * Il re-run: cosa rielabora e cosa lascia fuori.
 *
 * Solo dalla cache, solo i documenti annotati di quel tipo. Il giro completo — correggere
 * la mappa, rielaborare, guardare il delta — sta in `profile-map.test.ts`.
 */

const PDF = 'application/pdf'
const FATTURA = 'accounting.fattura'

const closers: Array<() => void> = []
afterAll(() => {
  for (const close of closers) close()
})

async function setup() {
  const registry = testRegistry()
  const db = openDatabase({ file: ':memory:' })
  closers.push(() => db.close())
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

  return { repo, db, deps, open, field }
}

/** Due fatture vere, annotate. */
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
  submitReview(repo, { documentId: native, action: 'SAVE' })

  return { ...context, withRows, native }
}

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
