import { resolve } from 'node:path'
import { LEGACY_FIELD_MAP } from '../../src/main/extract/legacy-field-map'
import {
  createExtractionRegistry,
  type ExtractionRegistry
} from '../../src/main/extract/v2/profile-loader'

export const REGISTRY_DIR = resolve(__dirname, '../../resources/registry')

let cached: ExtractionRegistry | null = null

/** Il registry è grande: caricarlo una volta sola per l'intero file di test. */
export function testExtractionRegistry(): ExtractionRegistry {
  cached ??= createExtractionRegistry(REGISTRY_DIR)
  return cached
}

export function testLegacyFieldMap(): Record<string, string> {
  return LEGACY_FIELD_MAP
}

export function fixture(name: string): string {
  return resolve(__dirname, '../fixtures', name)
}

export const TESSDATA_DIR = resolve(__dirname, '../../resources/tessdata')
