import { writeFile } from 'node:fs/promises'
import {
  type AnnotatedDataset,
  buildDataset,
  type DatasetManifestInput,
  type DatasetSource,
  serializeDataset
} from '@shared/dataset'
import type { Repository } from './db/repository'
import { learningSnapshot } from './learning-workspace'

/**
 * Raccoglie dal database i documenti chiusi dal revisore e li passa al formato del
 * dataset (`@shared/dataset`). Nessuna dipendenza da Electron: la finestra per scegliere
 * dove salvare la apre il canale IPC.
 */
export function collectDataset(repo: Repository, manifest: DatasetManifestInput): AnnotatedDataset {
  const sources: DatasetSource[] = []
  for (const row of repo.documents.list()) {
    if (row.status === 'NEEDS_REVIEW') continue
    const document = repo.getReviewDocument(row.id)
    if (!document) continue
    const [run] = repo.extractionRuns.listForDocument(row.id)
    sources.push({
      document,
      extraction: run
        ? {
            engineVersion: run.engine_version,
            schemaVersion: run.schema_version,
            status: run.status,
            completedAt: run.completed_at
          }
        : null
    })
  }
  // L'apprendimento dichiarato è quello del momento dell'export, non di chi lo chiede.
  return buildDataset({ ...manifest, learning: learningSnapshot(repo) }, sources)
}

export async function writeDatasetFile(path: string, dataset: AnnotatedDataset): Promise<void> {
  await writeFile(path, serializeDataset(dataset), 'utf8')
}
