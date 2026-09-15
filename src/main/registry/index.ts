import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRegistryField, type RegistryFieldName } from '@shared/fields'
import type { RegistryTypeOption } from '@shared/types'

/**
 * Snapshot del registry PraticaAI (511 tipi), copiato in `resources/registry/`.
 * Il repo non dipende dal monorepo PraticaAI: questi JSON sono dati, non un import.
 */
interface ExtractionSchema {
  properties?: Record<string, { type?: string }>
  required?: string[]
}

interface AliasEntry {
  canonical_name?: string
  aliases?: string[]
  synonyms?: string[]
}

interface DocumentTypeEntry {
  document_type_id?: string
  canonical_name?: string
  family?: string
}

export interface RegistryAlias {
  documentType: string
  /** Frase normalizzata da cercare nel testo o nel filename. */
  phrase: string
}

export interface Registry {
  has(documentType: string): boolean
  /** Campi dichiarati dallo schema del tipo, nell'ordine del registry. */
  fieldsFor(documentType: string | null): RegistryFieldName[]
  requiredFor(documentType: string | null): RegistryFieldName[]
  label(documentType: string | null): string | null
  types(): RegistryTypeOption[]
  aliases(): RegistryAlias[]
}

/** Minuscole, accenti conservati, spazi e punteggiatura collassati in spazio singolo. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function createRegistry(directory: string): Registry {
  const read = <T>(file: string): T => JSON.parse(readFileSync(join(directory, file), 'utf8')) as T

  const schemas = read<Record<string, ExtractionSchema>>('extraction_schemas.json')
  const aliasEntries = read<Record<string, AliasEntry>>('aliases.json')
  const typeEntries = read<DocumentTypeEntry[]>('document_types.json')

  const labels = new Map<string, string>()
  const families = new Map<string, string>()
  for (const entry of typeEntries) {
    if (!entry.document_type_id) continue
    if (entry.canonical_name) labels.set(entry.document_type_id, entry.canonical_name)
    if (entry.family) families.set(entry.document_type_id, entry.family)
  }
  for (const [documentType, entry] of Object.entries(aliasEntries)) {
    if (!labels.has(documentType) && entry.canonical_name) {
      labels.set(documentType, entry.canonical_name)
    }
  }

  const onlyKnownFields = (names: string[]): RegistryFieldName[] =>
    names.filter((name): name is RegistryFieldName => isRegistryField(name))

  // Un alias è utile solo se è una frase riconoscibile: le stringhe troppo corte
  // producono falsi positivi su qualunque documento.
  const aliasList: RegistryAlias[] = []
  const seen = new Map<string, Set<string>>()
  for (const [documentType, entry] of Object.entries(aliasEntries)) {
    const phrases = [entry.canonical_name, ...(entry.aliases ?? []), ...(entry.synonyms ?? [])]
    const already = seen.get(documentType) ?? new Set<string>()
    seen.set(documentType, already)
    for (const raw of phrases) {
      if (!raw) continue
      const phrase = normalize(raw)
      if (phrase.length < 4 || already.has(phrase)) continue
      already.add(phrase)
      aliasList.push({ documentType, phrase })
    }
  }

  return {
    has: (documentType) => Object.hasOwn(schemas, documentType),

    fieldsFor(documentType) {
      if (!documentType) return []
      const schema = schemas[documentType]
      if (!schema) return []
      return onlyKnownFields(Object.keys(schema.properties ?? {}))
    },

    requiredFor(documentType) {
      if (!documentType) return []
      return onlyKnownFields(schemas[documentType]?.required ?? [])
    },

    label: (documentType) => (documentType ? (labels.get(documentType) ?? null) : null),

    types: () =>
      Object.keys(schemas)
        .map((id) => ({
          id,
          label: labels.get(id) ?? id,
          family: families.get(id) ?? id.split('.')[0] ?? ''
        }))
        .sort((a, b) => a.label.localeCompare(b.label, 'it')),

    aliases: () => aliasList
  }
}

/** Dove vive lo snapshot: accanto all'app impacchettata, nel repo in sviluppo. */
export function registryDirectory(
  appPath: string,
  resourcesPath: string,
  packaged: boolean
): string {
  return packaged ? join(resourcesPath, 'registry') : join(appPath, 'resources', 'registry')
}
