import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { createAuthService } from './auth/service'
import { type EngineSelection, loadEngines } from './config'
import { openDatabase } from './db'
import { createRepository } from './db/repository'
import { logError } from './errors'
import { createOcrService } from './extract/ocr'
import {
  createExtractionRegistryV2,
  type ExtractionRegistryV2,
  loadLegacyFieldMap
} from './extract/v2/profile-loader'
import { registerIpcHandlers } from './ipc'
import {
  cacheDir,
  databaseFile,
  ocrWorkerPath,
  registryDir,
  registryV2Dir,
  tessdataCacheDir,
  tessdataDir
} from './paths'
import { createDocumentProcessor, EXTRACTION_ENGINE_V2_VERSION } from './pipeline'
import { createRegistry } from './registry'
import { loadClassifierConfigV2 } from './registry/v2/config'
import { needsV2Extraction, reprocessCachedDocuments } from './reprocess'
import { createMainWindow } from './window'

// Istanza singola: due processi sullo stesso file SQLite non hanno senso.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
const teardown: Array<() => unknown> = []

app.whenReady().then(start).catch(fatal)

function start(): void {
  app.setAppUserModelId('com.praticaai.reviewer')

  mkdirSync(cacheDir(), { recursive: true })

  const engines = loadEngines()
  const registry = createRegistry(registryDir())
  const v2 = loadRegistryV2(engines)
  const db = openDatabase({ file: databaseFile() })
  teardown.push(() => db.close())

  const repo = createRepository(db, {
    requiredFields: (documentType) => registry.requiredFor(documentType),
    typeLabel: (documentType) => registry.label(documentType)
  })

  mkdirSync(tessdataCacheDir(), { recursive: true })
  const ocr = createOcrService({
    workerPath: ocrWorkerPath(),
    tessdataDir: tessdataDir(),
    cachePath: tessdataCacheDir()
  })
  teardown.push(() => ocr.dispose())

  const processDocument = createDocumentProcessor({ repo, registry, ocr, engines, ...v2 })

  registerIpcHandlers({
    repo,
    auth: createAuthService(),
    registryTypes: () => registry.types(),
    process: processDocument,
    ocr,
    sender: () => mainWindow?.webContents ?? null,
    dataset: {
      manifest: () => ({
        app: { name: app.getName(), version: app.getVersion() },
        engines: {
          classifier: engines.classifier,
          extraction: engines.extraction,
          classifierVersion: v2.classifierConfigV2?.version ?? null,
          extractionEngineVersion:
            engines.extraction === 'v2' ? EXTRACTION_ENGINE_V2_VERSION : null,
          schemaVersion: v2.extractionRegistryV2?.schemaVersion() ?? null
        }
      }),
      choosePath: async (defaultName) => {
        const options = {
          title: 'Esporta il dataset annotato',
          defaultPath: join(app.getPath('documents'), defaultName),
          filters: [{ name: 'JSON', extensions: ['json'] }]
        }
        const result = mainWindow
          ? await dialog.showSaveDialog(mainWindow, options)
          : await dialog.showSaveDialog(options)
        return result.canceled || !result.filePath ? null : result.filePath
      }
    }
  })

  mainWindow = createMainWindow()

  // I documenti in cache estratti prima del v2 si rielaborano in sottofondo, uno per
  // volta: la finestra è già utilizzabile e i dati si aggiornano man mano.
  if (v2.extractionRegistryV2) {
    void reprocessCachedDocuments({
      repo,
      process: processDocument,
      isStale: needsV2Extraction(repo, v2.extractionRegistryV2)
    }).catch((error) => logError('app.reprocess', error))
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
    }
  })
}

/**
 * Carica solo quello che i motori scelti usano: con `v1` su entrambi l'app parte anche
 * se i JSON v2 sono assenti o rotti, ed è proprio lo scopo della scappatoia. La mappa dei
 * nomi legacy serve comunque a ritrovare le correzioni cambiando motore, ma col v1 un
 * file illeggibile non deve impedire l'avvio.
 */
function loadRegistryV2(engines: EngineSelection): {
  classifierConfigV2: ReturnType<typeof loadClassifierConfigV2> | undefined
  extractionRegistryV2: ExtractionRegistryV2 | undefined
  legacyFieldMap: Record<string, string>
} {
  const usesV2 = engines.classifier === 'v2' || engines.extraction === 'v2'
  let legacyFieldMap: Record<string, string> = {}
  try {
    legacyFieldMap = loadLegacyFieldMap(registryV2Dir())
  } catch (error) {
    if (usesV2) throw error
    logError('app.start', error)
  }

  return {
    classifierConfigV2:
      engines.classifier === 'v2' ? loadClassifierConfigV2(registryV2Dir()) : undefined,
    extractionRegistryV2:
      engines.extraction === 'v2'
        ? createExtractionRegistryV2(registryV2Dir(), registryDir())
        : undefined,
    legacyFieldMap
  }
}

/**
 * Se l'avvio fallisce (database illeggibile, snapshot del registry mancante) la
 * finestra resterebbe vuota senza spiegazioni: meglio dirlo e chiudere.
 */
function fatal(error: unknown): void {
  logError('app.start', error)
  dialog.showErrorBox(
    'PraticaAI Reviewer non si è avviata',
    error instanceof Error ? error.message : String(error)
  )
  app.exit(1)
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  for (const close of teardown) {
    try {
      void close()
    } catch (error) {
      logError('app.quit', error)
    }
  }
})
