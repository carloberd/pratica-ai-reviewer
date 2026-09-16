import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HintsFile, ProfilesFile, RawHint, RawProfile } from '@shared/profile-edit'
import type { ProfileStoreStatus, ProfileWriteMode } from '@shared/profile-workspace'

/**
 * I JSON dei profili sul disco, e il commit che li versiona.
 *
 * I file restano quelli del repo — niente copia locale, niente fork: una correzione è un
 * commit su `resources/registry/v2/`, così chi guarda la storia vede perché
 * un'istruzione è cambiata. Se la cartella non è scrivibile (l'app impacchettata legge
 * il registry da `process.resourcesPath`, di sola lettura) la correzione non è un errore:
 * il JSON corretto si esporta e si sostituisce a mano. La degradazione è dichiarata,
 * non nascosta.
 */

export const PROFILES_FILE = 'class_extraction_profiles_v2.json'
export const HINTS_FILE = 'extraction_hints_v2.json'

/**
 * Due spazi di indentazione e nessun a capo finale: è esattamente la forma in cui i file
 * arrivano dal programmer pack, e riscriverli così tiene il diff alle righe cambiate
 * invece di toccarne 30.000.
 */
export function serializeRegistryJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

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

// ---------------------------------------------------------------------------
// Scrittura e commit
// ---------------------------------------------------------------------------

/** Un file del registry riscritto: nome e contenuto, prima di toccare il disco. */
export interface ChangedFile {
  name: string
  content: string
}

/**
 * L'esito interno della scrittura. Diventa `ProfileWriteOutcome` (il contratto della
 * schermata) solo dopo che l'export è stato gestito: il contenuto dei JSON, quasi un
 * megabyte, non attraversa il ponte IPC.
 */
export type ProfileWriteResult =
  | { mode: 'COMMITTED'; paths: string[]; commit: string; subject: string }
  | { mode: 'WRITTEN'; paths: string[]; subject: string; reason: string }
  | { mode: 'EXPORT_REQUIRED'; files: ChangedFile[]; subject: string; reason: string }

function canWrite(path: string): boolean {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

function git(cwd: string, args: string[]): GitResult {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    // `error` copre il caso in cui git non sia nemmeno installato.
    stderr: (result.stderr ?? '').trim() || (result.error ? result.error.message : '')
  }
}

/** La radice del repo che versiona la cartella, `null` se non è versionata. */
export function repositoryRootOf(directory: string): string | null {
  const result = git(directory, ['rev-parse', '--show-toplevel'])
  return result.ok && result.stdout !== '' ? result.stdout : null
}

function writeMode(writable: boolean, repositoryRoot: string | null): ProfileWriteMode {
  if (!writable) return 'EXPORT_REQUIRED'
  return repositoryRoot ? 'COMMITTED' : 'WRITTEN'
}

export function profileStoreStatus(directory: string): ProfileStoreStatus {
  const writable =
    canWrite(directory) &&
    [PROFILES_FILE, HINTS_FILE].every((file) => canWrite(join(directory, file)))
  const repositoryRoot = writable ? repositoryRootOf(directory) : null
  return {
    directory,
    writable,
    repositoryRoot,
    mode: writeMode(writable, repositoryRoot)
  }
}

export interface WriteProfileFilesInput {
  directory: string
  files: ChangedFile[]
  commit: { subject: string; body: string }
}

/**
 * Scrive i file cambiati e li committa da soli.
 *
 * Il commit porta come pathspec solo i file toccati: quello che c'era già in staging
 * resta dov'è, e il commit dei profili non si tira dietro il lavoro in corso di
 * qualcun altro. Se git non c'è, non è configurato o rifiuta, i file restano scritti e
 * l'esito lo dice: un commit mancato non deve far perdere la correzione.
 */
export function writeProfileFiles(input: WriteProfileFilesInput): ProfileWriteResult {
  const { directory, files, commit } = input
  const status = profileStoreStatus(directory)

  if (!status.writable) {
    return {
      mode: 'EXPORT_REQUIRED',
      files,
      subject: commit.subject,
      reason: `La cartella ${directory} è di sola lettura: l'app sta girando impacchettata.`
    }
  }

  const paths = files.map((file) => join(directory, file.name))
  for (const file of files) {
    writeFileSync(join(directory, file.name), file.content, 'utf8')
  }

  if (!status.repositoryRoot) {
    return {
      mode: 'WRITTEN',
      paths,
      subject: commit.subject,
      reason: `${directory} non sta in un repository git: i JSON sono aggiornati ma non versionati.`
    }
  }

  const names = files.map((file) => file.name)
  const added = git(directory, ['add', '--', ...names])
  if (!added.ok) {
    return { mode: 'WRITTEN', paths, subject: commit.subject, reason: gitReason(added) }
  }

  const committed = git(directory, [
    'commit',
    '-m',
    commit.subject,
    '-m',
    commit.body,
    '--',
    ...names
  ])
  if (!committed.ok) {
    return { mode: 'WRITTEN', paths, subject: commit.subject, reason: gitReason(committed) }
  }

  const head = git(directory, ['rev-parse', '--short', 'HEAD'])
  return {
    mode: 'COMMITTED',
    paths,
    commit: head.ok ? head.stdout : '',
    subject: commit.subject
  }
}

function gitReason(result: GitResult): string {
  return `git non ha completato il commit: ${result.stderr || 'nessun dettaglio'}. I JSON sono comunque aggiornati sul disco.`
}

/** Il profilo grezzo di un tipo, per la correzione: `null` se il file non lo prevede. */
export function rawProfileOf(file: ProfilesFile, documentType: string): RawProfile | null {
  return file.profiles[documentType] ?? null
}

export function rawHintOf(file: HintsFile, fieldId: string): RawHint | null {
  return file.hints[fieldId] ?? null
}
