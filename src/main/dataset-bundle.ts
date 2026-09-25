import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AnnotatedDataset } from '@shared/dataset'
import {
  BUNDLE_DOCUMENTS_DIR,
  BUNDLE_FILES_MANIFEST,
  type BundleFileEntry,
  type BundleFileInput,
  buildFilesManifest,
  planBundleFiles,
  serializeFilesManifest
} from '@shared/dataset-bundle'
import type { DatasetBundleResult } from '@shared/types'
import { writeDatasetFile } from './dataset-export'
import type { Repository } from './db/repository'
import { logError } from './errors'
import { collectXlsxRows, writeXlsxFile, type XlsxCollectDeps } from './xlsx-export'

/**
 * L'export completo: il dataset annotato e i documenti da cui è uscito, in una cartella
 * sola.
 *
 * I due file di dati sono gli stessi degli altri due export — `dataset.json` è quello
 * della voce «JSON», `dataset.xlsx` quello della voce «Excel» — più una cartella
 * `documenti/` con una copia dei file chiusi dal revisore e `documenti.json` che lega
 * ogni copia alla sua riga del dataset. La forma di quel legame sta in
 * `@shared/dataset-bundle`; qui ci sono solo il database e il disco.
 *
 * Niente rete: un file tolto dalla cache non si riscarica da Drive, si dichiara mancante.
 * Vale la regola dell'export XLSX, e per lo stesso motivo — un export non deve dipendere
 * dal fatto che Drive risponda.
 */

export const BUNDLE_DATASET_FILE = 'dataset.json'
export const BUNDLE_XLSX_FILE = 'dataset.xlsx'

export interface DatasetBundleDeps {
  repo: Repository
  /**
   * Il dataset già raccolto (`collectDataset`): è lo stesso dell'export JSON, e chi chiama
   * lo ha in mano perché è da lì che sa se c'è qualcosa da esportare.
   */
  dataset: AnnotatedDataset
  /** La cartella da creare, già scelta dal revisore. */
  directory: string
  xlsx?: XlsxCollectDeps
}

/** Sha-256 della copia, letta a blocchi: un PDF grosso non va tenuto in memoria. */
async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** I documenti chiusi dal revisore, nella forma che serve a pianificare le copie. */
function bundleInputs(repo: Repository): BundleFileInput[] {
  const inputs: BundleFileInput[] = []
  for (const row of repo.documents.list()) {
    if (row.status === 'NEEDS_REVIEW') continue
    inputs.push({
      driveFileId: row.drive_file_id,
      filename: row.filename,
      mime: row.mime,
      status: row.status,
      contentSha256: row.content_sha256,
      cachedPath: row.cached_path
    })
  }
  return inputs
}

/**
 * Copia i documenti nella cartella e ne verifica l'impronta.
 *
 * Ogni copia viene riletta per il suo sha-256 e confrontata con quello registrato quando
 * il documento è stato elaborato: se non coincidono, il file su Drive è cambiato dopo la
 * revisione e i valori annotati non sono di questo file. Non è un errore da fermare
 * l'export — è un fatto da scrivere nel manifest, perché chi lo riceve possa guardarlo.
 */
async function copyDocuments(
  inputs: BundleFileInput[],
  directory: string
): Promise<BundleFileEntry[]> {
  const planned = planBundleFiles(inputs)
  if (planned.some((file) => file.file !== null)) {
    await mkdir(join(directory, BUNDLE_DOCUMENTS_DIR), { recursive: true })
  }

  const entries: BundleFileEntry[] = []
  for (const file of planned) {
    const base = {
      driveFileId: file.driveFileId,
      filename: file.filename,
      mime: file.mime,
      status: file.status,
      contentSha256: file.contentSha256
    }

    if (!file.file || !file.cachedPath) {
      entries.push({
        ...base,
        file: null,
        bytes: null,
        sha256: null,
        matchesAnnotated: null,
        missing: file.missing ?? 'NO_LOCAL_COPY'
      })
      continue
    }

    const target = join(directory, ...file.file.split('/'))
    try {
      await copyFile(file.cachedPath, target)
      const [{ size }, sha256] = await Promise.all([stat(target), sha256Of(target)])
      entries.push({
        ...base,
        file: file.file,
        bytes: size,
        sha256,
        matchesAnnotated: file.contentSha256 ? file.contentSha256 === sha256 : null,
        missing: null
      })
    } catch (error) {
      // Path nel database ma file sparito, o disco che rifiuta: il documento resta nel
      // dataset e il manifest dice che il file non c'è. L'export non si ferma per questo.
      logError('dataset.bundle.copy', error)
      entries.push({
        ...base,
        file: null,
        bytes: null,
        sha256: null,
        matchesAnnotated: null,
        missing: 'FILE_GONE'
      })
    }
  }
  return entries
}

/** Scrive la cartella completa e dice com'è andata. */
export async function exportDatasetBundle(deps: DatasetBundleDeps): Promise<DatasetBundleResult> {
  const { repo, dataset, directory } = deps

  const rows = await collectXlsxRows(repo, deps.xlsx ?? {})

  await mkdir(directory, { recursive: true })
  await writeDatasetFile(join(directory, BUNDLE_DATASET_FILE), dataset)
  await writeXlsxFile(join(directory, BUNDLE_XLSX_FILE), rows)

  const files = await copyDocuments(bundleInputs(repo), directory)
  const manifest = buildFilesManifest(dataset.manifest.exportedAt, files)
  await writeFile(join(directory, BUNDLE_FILES_MANIFEST), serializeFilesManifest(manifest), 'utf8')

  return {
    saved: true,
    directory,
    documents: dataset.manifest.counts.documents,
    corrections: dataset.manifest.counts.corrections,
    copied: manifest.counts.copied,
    missing: manifest.counts.missing,
    mismatched: manifest.counts.mismatched,
    bytes: manifest.counts.bytes
  }
}
