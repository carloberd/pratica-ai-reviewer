import { join } from 'node:path'
import { BrowserWindow, shell } from 'electron'

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#f4f6f8',
    title: 'PraticaAI Reviewer',
    // Su macOS la barra del titolo sparisce e il contenuto arriva fino in cima: le
    // zone trascinabili le dichiara la UI con `-webkit-app-region: drag`, altrimenti
    // la finestra non si potrebbe più spostare.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 24 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // D1: nessun token e nessuna credenziale possono raggiungere il renderer.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  window.once('ready-to-show', () => window.show())

  // Nessuna navigazione fuori dall'app: i link esterni vanno al browser di sistema.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}
