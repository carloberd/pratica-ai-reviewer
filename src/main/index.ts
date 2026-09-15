import { mkdirSync } from 'node:fs'
import { app, BrowserWindow, dialog } from 'electron'
import { createAuthService } from './auth/service'
import { openDatabase } from './db'
import { createRepository } from './db/repository'
import { logError } from './errors'
import { createOcrService } from './extract/ocr'
import { registerIpcHandlers } from './ipc'
import {
  cacheDir,
  databaseFile,
  ocrWorkerPath,
  registryDir,
  tessdataCacheDir,
  tessdataDir
} from './paths'
import { createDocumentProcessor } from './pipeline'
import { createRegistry } from './registry'
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

  const registry = createRegistry(registryDir())
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

  registerIpcHandlers({
    repo,
    auth: createAuthService(),
    registryTypes: () => registry.types(),
    process: createDocumentProcessor({ repo, registry, ocr }),
    sender: () => mainWindow?.webContents ?? null
  })

  mainWindow = createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
    }
  })
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
