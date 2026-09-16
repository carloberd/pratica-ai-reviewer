import { resolve } from 'node:path'
import {
  createExtractionRegistryV2,
  type ExtractionRegistryV2,
  loadLegacyFieldMap
} from '../../src/main/extract/v2/profile-loader'
import { createRegistry, type Registry } from '../../src/main/registry'
import { type ClassifierConfigV2, loadClassifierConfigV2 } from '../../src/main/registry/v2/config'

export const REGISTRY_DIR = resolve(__dirname, '../../resources/registry')
export const REGISTRY_V2_DIR = resolve(REGISTRY_DIR, 'v2')

let cached: Registry | null = null
let cachedV2: ExtractionRegistryV2 | null = null
let cachedConfig: ClassifierConfigV2 | null = null
let cachedLegacyMap: Record<string, string> | null = null

/** Lo snapshot del registry è grande: caricarlo una volta sola per l intero file di test. */
export function testRegistry(): Registry {
  cached ??= createRegistry(REGISTRY_DIR)
  return cached
}

/** Profili v2 reali, col registry v1 per i LEGACY_FALLBACK. */
export function testRegistryV2(): ExtractionRegistryV2 {
  cachedV2 ??= createExtractionRegistryV2(REGISTRY_V2_DIR, REGISTRY_DIR)
  return cachedV2
}

export function testClassifierConfigV2(): ClassifierConfigV2 {
  cachedConfig ??= loadClassifierConfigV2(REGISTRY_V2_DIR)
  return cachedConfig
}

export function testLegacyFieldMap(): Record<string, string> {
  cachedLegacyMap ??= loadLegacyFieldMap(REGISTRY_V2_DIR)
  return cachedLegacyMap
}

export function fixture(name: string): string {
  return resolve(__dirname, '../fixtures', name)
}

export const TESSDATA_DIR = resolve(__dirname, '../../resources/tessdata')
