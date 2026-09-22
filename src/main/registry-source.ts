import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DOCUMENT_FIELDS_FILE,
  type DocumentFieldsFile,
  FIELDS_FILE,
  type FieldsFile
} from '@shared/profile-bundle'

/**
 * I due JSON del registry, letti dal disco.
 *
 * Sola lettura, sempre: `fields.json` e `document_fields.json` sono la base da cui si
 * parte e nessuna correzione li tocca. Quello che il revisore decide sta nel database
 * (migrazione 0008) e diventa un file solo quando esporta — in una cartella che sceglie
 * lui, non qui dentro. Così l'app impacchettata, che legge il registry da
 * `process.resourcesPath` di sola lettura, si comporta esattamente come quella di
 * sviluppo.
 */

function readJsonFile(directory: string, file: string): unknown {
  const path = join(directory, file)
  if (!existsSync(path)) throw new Error(`Registry: manca ${file} in ${directory}.`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Registry: ${file} non è JSON valido (${detail}).`)
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
export function parseDocumentFieldsFile(
  raw: unknown,
  file = DOCUMENT_FIELDS_FILE
): DocumentFieldsFile {
  if (!isRecord(raw) || typeof raw.version !== 'string' || !isRecord(raw.document_types)) {
    throw new Error(`Registry: ${file} non ha «version» e «document_types».`)
  }
  for (const [documentType, entry] of Object.entries(raw.document_types)) {
    if (!isRecord(entry)) {
      throw new Error(`Registry: la mappa di «${documentType}» in ${file} non è un oggetto.`)
    }
    for (const key of ['required_fields', 'optional_fields']) {
      if (!isStringList(entry[key])) {
        throw new Error(`Registry: «${documentType}.${key}» in ${file} non è una lista di campi.`)
      }
    }
  }
  return raw as unknown as DocumentFieldsFile
}

export function parseFieldsFile(raw: unknown, file = FIELDS_FILE): FieldsFile {
  if (!isRecord(raw) || typeof raw.version !== 'string' || !isRecord(raw.fields)) {
    throw new Error(`Registry: ${file} non ha «version» e «fields».`)
  }
  for (const [fieldId, field] of Object.entries(raw.fields)) {
    if (!isRecord(field) || !isStringList(field.label_aliases_it)) {
      throw new Error(`Registry: il campo «${fieldId}» in ${file} non ha «label_aliases_it».`)
    }
  }
  return raw as unknown as FieldsFile
}

export interface RegistrySourceFiles {
  catalog: FieldsFile
  map: DocumentFieldsFile
}

export function readRegistrySourceFiles(directory: string): RegistrySourceFiles {
  return {
    catalog: parseFieldsFile(readJsonFile(directory, FIELDS_FILE)),
    map: parseDocumentFieldsFile(readJsonFile(directory, DOCUMENT_FIELDS_FILE))
  }
}
