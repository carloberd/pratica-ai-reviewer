import { resolve } from 'node:path'
import { createRegistry, type Registry } from '../../src/main/registry'

let cached: Registry | null = null

/** Lo snapshot del registry è grande: caricarlo una volta sola per l intero file di test. */
export function testRegistry(): Registry {
  cached ??= createRegistry(resolve(__dirname, '../../resources/registry'))
  return cached
}

export function fixture(name: string): string {
  return resolve(__dirname, '../fixtures', name)
}

export const TESSDATA_DIR = resolve(__dirname, '../../resources/tessdata')
