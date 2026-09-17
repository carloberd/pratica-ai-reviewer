import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ProfileOverlay } from '@shared/profile-overlay'
import { app, BrowserWindow, dialog } from 'electron'
import { createAuthService } from './auth/service'
import { type EngineSelection, loadEngines } from './config'
import { openDatabase } from './db'
import { createRepository } from './db/repository'
import { logError } from './errors'
import { createOcrService } from './extract/ocr'
import {
  createReloadableExtractionRegistryV2,
  loadLegacyFieldMap,
  type ReloadableExtractionRegistryV2
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
  const db = openDatabase({ file: databaseFile() })
  teardown.push(() => db.close())

  const repo = createRepository(db, {
    requiredFields: (documentType) => registry.requiredFor(documentType),
    typeLabel: (documentType) => registry.label(documentType)
  })

  // Il registry v2 arriva dopo il database perché le correzioni del revisore stanno lì:
  // i profili del pack restano quelli, e quello che il motore legge è il pack con sopra
  // le decisioni prese nella schermata «Mappa tipi ↔ dati».
  const v2 = loadRegistryV2(engines, () => repo.profileMap.overlay())

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
      choosePath: (defaultName) => chooseSavePath('Esporta il dataset annotato', defaultName),
      chooseXlsxPath: (defaultName) =>
        chooseSavePath('Esporta il dataset annotato in Excel', defaultName)
    },
    // Senza profili v2 non c'è niente da misurare: la voce di menu resta, e i canali
    // rispondono che la schermata non è disponibile su questa istanza.
    ...(v2.extractionRegistryV2
      ? {
          profiles: {
            refinement: {
              registry: v2.extractionRegistryV2,
              registryDirectory: registryV2Dir(),
              typeLabel: (documentType: string) => registry.label(documentType)
            },
            manifest: () => ({
              app: { name: app.getName(), version: app.getVersion() },
              schemaVersion: v2.extractionRegistryV2?.schemaVersion() ?? null
            }),
            choosePath: (defaultName: string) =>
              chooseSavePath('Esporta il report delle istruzioni per tipo', defaultName),
            chooseDirectory: (defaultName: string) =>
              chooseExportFolder('Dove salvare la mappa corretta', defaultName)
          }
        }
      : {})
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
function loadRegistryV2(
  engines: EngineSelection,
  overlay: () => ProfileOverlay
): {
  classifierConfigV2: ReturnType<typeof loadClassifierConfigV2> | undefined
  extractionRegistryV2: ReloadableExtractionRegistryV2 | undefined
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
        ? createReloadableExtractionRegistryV2(registryV2Dir(), registryDir(), overlay)
        : undefined,
    legacyFieldMap
  }
}

/**
 * Finestra «scegli la cartella», per l'export della mappa: i file della mappa corretta
 * sono quattro e vanno insieme, quindi si sceglie dove crearne la cartella e non un file
 * per volta.
 */
async function chooseExportFolder(title: string, folderName: string): Promise<string | null> {
  const options = {
    title,
    defaultPath: app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    buttonLabel: 'Esporta qui'
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)
  const parent = result.canceled ? undefined : result.filePaths[0]
  return parent ? join(parent, folderName) : null
}

/** Finestra «salva con nome», sulla finestra principale quando c'è. */
async function chooseSavePath(title: string, defaultName: string): Promise<string | null> {
  const extension = defaultName.split('.').pop() ?? 'json'
  const options = {
    title,
    defaultPath: join(app.getPath('documents'), defaultName),
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
  }
  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, options)
    : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
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
