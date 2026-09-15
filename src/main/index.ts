import { mkdirSync } from 'node:fs'
import { app, BrowserWindow } from 'electron'
import { createAuthService } from './auth/service'
import { openDatabase } from './db'
import { createRepository } from './db/repository'
import { logError } from './errors'
import { registerIpcHandlers } from './ipc'
import { cacheDir, databaseFile } from './paths'
import { createMainWindow } from './window'

// Istanza singola: due processi sullo stesso file SQLite non hanno senso.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let closeDatabase: (() => void) | null = null

app.whenReady().then(() => {
  app.setAppUserModelId('com.praticaai.reviewer')

  mkdirSync(cacheDir(), { recursive: true })
  const db = openDatabase({ file: databaseFile() })
  closeDatabase = () => db.close()

  const repo = createRepository(db)
  const auth = createAuthService()

  registerIpcHandlers({
    repo,
    auth,
    sender: () => mainWindow?.webContents ?? null
  })

  mainWindow = createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
    }
  })
})

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
  try {
    closeDatabase?.()
  } catch (error) {
    logError('app.quit', error)
  }
})
