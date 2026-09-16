import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // I componenti React si provano con react-dom/server: JSX col runtime automatico.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/renderer/**/*.test.tsx'],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
