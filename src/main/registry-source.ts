import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  HINTS_FILE,
  type HintsFile,
  PROFILES_FILE,
  type ProfilesFile
} from '@shared/profile-bundle'

/**
 * I JSON del registry, letti dal disco.
 *
 * Sola lettura, sempre: i file del programmer pack sono la base da cui si parte e
 * nessuna correzione li tocca. Quello che il revisore decide sta nel database
 * (migrazione 0008) e diventa un file solo quando esporta — in una cartella che sceglie
 * lui, non qui dentro. Così l'app impacchettata, che legge il registry da
 * `process.resourcesPath` di sola lettura, si comporta esattamente come quella di
 * sviluppo.
 */

function readJsonFile(directory: string, file: string): unknown {
  const path = join(directory, file)
  if (!existsSync(path)) throw new Error(`Registry v2: manca ${file} in ${directory}.`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Registry v2: ${file} non è JSON valido (${detail}).`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * Controllo di forma minimo: solo quello che la correzione tocca davvero.
 *
 * Il caricatore del motore (`profile-loader.ts`) valida con zod e scarta le chiavi che
 * non conosce. Qui non si può: le chiavi sconosciute vanno riscritte com'erano, quindi
 * l'oggetto resta quello uscito da `JSON.parse` e si verifica solo che le liste dei
 * ruoli ci siano e siano liste di stringhe.
 */
export function parseProfilesFile(raw: unknown, file = PROFILES_FILE): ProfilesFile {
  if (!isRecord(raw) || typeof raw.version !== 'string' || !isRecord(raw.profiles)) {
    throw new Error(`Registry v2: ${file} non ha «version» e «profiles».`)
  }
  for (const [documentType, profile] of Object.entries(raw.profiles)) {
    if (!isRecord(profile)) {
      throw new Error(`Registry v2: il profilo di «${documentType}» in ${file} non è un oggetto.`)
    }
    for (const key of ['required_fields', 'core_fields', 'optional_fields', 'conditional_fields']) {
      if (!isStringList(profile[key])) {
        throw new Error(
          `Registry v2: «${documentType}.${key}» in ${file} non è una lista di campi.`
        )
      }
    }
  }
  return raw as unknown as ProfilesFile
}

export function parseHintsFile(raw: unknown, file = HINTS_FILE): HintsFile {
  if (!isRecord(raw) || typeof raw.version !== 'string' || !isRecord(raw.hints)) {
    throw new Error(`Registry v2: ${file} non ha «version» e «hints».`)
  }
  for (const [fieldId, hint] of Object.entries(raw.hints)) {
    if (!isRecord(hint) || !isStringList(hint.labels)) {
      throw new Error(`Registry v2: gli hint di «${fieldId}» in ${file} non hanno «labels».`)
    }
  }
  return raw as unknown as HintsFile
}

export interface RegistrySourceFiles {
  profiles: ProfilesFile
  hints: HintsFile
}

export function readRegistrySourceFiles(directory: string): RegistrySourceFiles {
  return {
    profiles: parseProfilesFile(readJsonFile(directory, PROFILES_FILE)),
    hints: parseHintsFile(readJsonFile(directory, HINTS_FILE))
  }
}
