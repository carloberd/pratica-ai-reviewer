import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { createAuthService } from './auth/service'
import { openDatabase } from './db'
import { createRepository } from './db/repository'
import { logError } from './errors'
import { LEGACY_FIELD_MAP } from './extract/legacy-field-map'
import { createOcrService } from './extract/ocr'
import { createReloadableExtractionRegistry } from './extract/v2/profile-loader'
import { validateFieldValue } from './extract/v2/validators'
import { registerIpcHandlers } from './ipc'
import {
  cacheDir,
  databaseFile,
  ocrWorkerPath,
  registryDir,
  tessdataCacheDir,
  tessdataDir
} from './paths'
import { createDocumentProcessor, EXTRACTION_ENGINE_V2_VERSION } from './pipeline'
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

  const db = openDatabase({ file: databaseFile() })
  teardown.push(() => db.close())

  const repo = createRepository(db, {
    requiredFields: (documentType) =>
      documentType ? (registry.baseProfile(documentType)?.required_fields ?? []) : [],
    typeLabel: (documentType) =>
      documentType ? (registry.baseProfile(documentType)?.canonical_name ?? null) : null,
    validateField: (documentType, fieldName, value) =>
      validateFieldValue(registry, documentType, fieldName, value)
  })

  // Il registry arriva dopo il database perché le correzioni del revisore stanno lì: i
  // due file restano quelli, e quello che il motore legge è il registry con sopra le
  // decisioni prese dalla scheda «Campi da estrarre» della revisione.
  const registry = createReloadableExtractionRegistry(registryDir(), () =>
    repo.profileMap.overlay()
  )

  mkdirSync(tessdataCacheDir(), { recursive: true })
  const ocr = createOcrService({
    workerPath: ocrWorkerPath(),
    tessdataDir: tessdataDir(),
    cachePath: tessdataCacheDir()
  })
  teardown.push(() => ocr.dispose())

  const processDocument = createDocumentProcessor({ repo, ocr, extractionRegistry: registry })

  registerIpcHandlers({
    repo,
    auth: createAuthService(),
    registryTypes: () => registry.documentTypes(),
    process: processDocument,
    ocr,
    sender: () => mainWindow?.webContents ?? null,
    dataset: {
      manifest: () => ({
        app: { name: app.getName(), version: app.getVersion() },
        engines: {
          extractionEngineVersion: EXTRACTION_ENGINE_V2_VERSION,
          schemaVersion: registry.schemaVersion()
        }
      }),
      choosePath: (defaultName) => chooseSavePath('Esporta il dataset annotato', defaultName),
      chooseXlsxPath: (defaultName) =>
        chooseSavePath('Esporta il dataset annotato in Excel', defaultName),
      chooseBundleDirectory: (defaultName) =>
        chooseExportFolder('Dove salvare il dataset completo', defaultName)
    },
    learning: { legacyFieldMap: LEGACY_FIELD_MAP },
    profiles: {
      refinement: {
        registry,
        registryDirectory: registryDir(),
        typeLabel: (documentType: string) =>
          registry.baseProfile(documentType)?.canonical_name ?? null
      },
      manifest: () => ({
        app: { name: app.getName(), version: app.getVersion() },
        schemaVersion: registry.schemaVersion()
      }),
      chooseDirectory: (defaultName: string) =>
        chooseExportFolder('Dove salvare la mappa corretta', defaultName)
    }
  })

  mainWindow = createMainWindow()

  // I documenti in cache estratti con una versione precedente del motore si rielaborano
  // in sottofondo, uno per volta: la finestra è già utilizzabile e i dati si aggiornano
  // man mano.
  void reprocessCachedDocuments({
    repo,
    process: processDocument,
    isStale: needsV2Extraction(repo, registry)
  }).catch((error) => logError('app.reprocess', error))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
    }
  })
}

/**
 * Finestra «scegli la cartella», per gli export fatti di più file: la mappa corretta sono
 * quattro file che vanno insieme, il dataset completo è due file più i documenti copiati.
 * In tutti e due i casi si sceglie dove creare la cartella, non un file per volta.
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
