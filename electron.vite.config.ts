import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * Credenziali OAuth cucite nel bundle del main a build time.
 *
 * Restano confinate al processo main: il renderer non le vede mai (D1). Se non sono
 * presenti nell'ambiente di compilazione vale `null`, e l'app chiede all'avvio di
 * creare un `.env`, come prima.
 */
const bakedGoogleCredentials =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET }
    : null

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __BAKED_GOOGLE_CREDENTIALS__: JSON.stringify(bakedGoogleCredentials)
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'ocr-worker': resolve(__dirname, 'src/main/extract/ocr-worker.ts')
        },
        output: {
          // Il worker OCR viene lanciato per path: i nomi dei bundle devono restare stabili.
          entryFileNames: '[name].js'
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
