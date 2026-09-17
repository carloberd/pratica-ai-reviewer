import { afterAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/db'
import { createRepository } from '../src/main/db/repository'
import { createReloadableExtractionRegistryV2 } from '../src/main/extract/v2/profile-loader'
import { createDocumentProcessor } from '../src/main/pipeline'
import {
  documentFieldMap,
  editMapFromDocument,
  type RefinementDeps,
  reprocessQueueOfType,
  revertMapFromDocument
} from '../src/main/profile-refinement'

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
 * La mappa corretta dal documento aperto: cosa si rielabora subito, cosa in sottofondo e
 * cosa resta com'è. Il giro completo sui numeri sta in `profile-map.test.ts`.
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

  async function open(filename: string, driveFileId = `drive-${filename}`) {
    const { id } = repo.documents.upsertFromDrive({
      driveFileId,
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

describe('la mappa del documento aperto', () => {
  it('c’è anche per un tipo mai revisionato, coi numeri a zero', async () => {
    const { deps, open, db } = await setup()
    const id = await open('fattura-righe.pdf')

    const map = documentFieldMap(deps, id)
    expect(map.documentType).toBe(FATTURA)
    expect(map.editable).toBe(true)
    expect(map.measure.totals.documents).toBe(0)
    expect(map.measure.fields.filter((entry) => entry.inProfile).length).toBeGreaterThan(0)
    expect(map.ontology.length).toBeGreaterThan(100)
    expect(map.undoable).toEqual([])

    db.close()
  })

  it('senza tipo non c’è una mappa: la frase manda a «Dati»', async () => {
    const { deps, repo, open, db } = await setup()
    const id = await open('fattura-righe.pdf')
    repo.documents.setType(id, null, null)

    expect(() => documentFieldMap(deps, id)).toThrow(/assegnalo in «Dati»/)

    db.close()
  })
})

describe('correggere la mappa dal documento', () => {
  it('rielabora subito il documento e lascia la correzione annullabile da lì', async () => {
    const { deps, open, db } = await setup()
    const id = await open('fattura-righe.pdf')

    const added = await editMapFromDocument(deps, id, {
      kind: 'ADD_FIELD',
      documentType: FATTURA,
      fieldId: 'document.title',
      role: 'core'
    })
    expect(added.reprocessed).toBe(true)
    expect(added.document.fields.map((entry) => entry.name)).toContain('document.title')
    expect(added.map.undoable.map((action) => action.id)).toEqual([added.action.id])

    const reverted = await revertMapFromDocument(deps, id, added.action.id)
    expect(reverted.action.kind).toBe('REVERT')
    expect(reverted.document.fields.map((entry) => entry.name)).not.toContain('document.title')
    expect(reverted.map.undoable).toEqual([])

    db.close()
  })

  it('senza copia locale la correzione vale, ma il documento resta quello di prima', async () => {
    const { deps, repo, open, db } = await setup()
    const id = await open('fattura-righe.pdf')
    repo.documents.setCachedPath(id, null)

    const result = await editMapFromDocument(deps, id, {
      kind: 'ADD_FIELD',
      documentType: FATTURA,
      fieldId: 'document.title',
      role: 'core'
    })
    expect(result.reprocessed).toBe(false)
    expect(result.document.fields.map((entry) => entry.name)).not.toContain('document.title')
    expect(deps.registry.profile(FATTURA)!.core_fields).toContain('document.title')

    db.close()
  })

  it('da un documento si corregge solo la mappa del suo tipo', async () => {
    const { deps, open, db } = await setup()
    const id = await open('fattura-righe.pdf')

    await expect(
      editMapFromDocument(deps, id, {
        kind: 'ADD_FIELD',
        documentType: 'hr.unilav',
        fieldId: 'document.title',
        role: 'core'
      })
    ).rejects.toThrow(/solo la sua mappa/)
    expect(deps.repo.profileMap.listActions()).toEqual([])

    db.close()
  })

  it('i documenti in coda dello stesso tipo si rielaborano in sottofondo, i salvati no', async () => {
    const { deps, repo, open, db } = await setup()
    const current = await open('fattura-righe.pdf')
    const queued = await open('fattura-righe.pdf', 'drive-copia-in-coda')
    const saved = await open('fattura-nativa.pdf')
    submitReview(repo, { documentId: saved, action: 'SAVE' })

    const names = (id: string) => repo.getReviewDocument(id)!.fields.map((entry) => entry.name)

    const result = await editMapFromDocument(deps, current, {
      kind: 'ADD_FIELD',
      documentType: FATTURA,
      fieldId: 'document.title',
      role: 'core'
    })
    expect(result.queued).toBe(1)

    // Il sottofondo è una coda sola: si aspetta che finisca.
    await reprocessQueueOfType(deps, 'nessun.tipo', null).done

    expect(names(queued)).toContain('document.title')
    expect(names(saved)).not.toContain('document.title')

    db.close()
  })
})
