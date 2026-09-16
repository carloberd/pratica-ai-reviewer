import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HINTS_FILE,
  PROFILES_FILE,
  parseHintsFile,
  parseProfilesFile,
  profileStoreStatus,
  readRegistrySourceFiles,
  serializeRegistryJson,
  writeProfileFiles
} from '../src/main/profile-store'
import { REGISTRY_V2_DIR } from './helpers/registry'

/**
 * La scrittura dei JSON e il commit che li versiona, su un repo git vero creato per
 * l'occasione: una `git` finta proverebbe che il codice chiama le funzioni che chiama,
 * non che il commit esce pulito.
 */

const created: string[] = []
afterEach(() => {
  for (const directory of created.splice(0)) {
    chmodSync(directory, 0o755)
    rmSync(directory, { recursive: true, force: true })
  }
})

const PROFILES = {
  version: '2.0.0',
  active_registry_source: 'Document Brain 496 active classes',
  profiles: {
    'accounting.fattura': {
      document_type_id: 'accounting.fattura',
      canonical_name: 'fattura',
      family: 'accounting',
      schema_state: 'EXTRACTION_SCHEMA_DRAFT',
      evidence_basis: 'LEGACY_REGISTRY+AI_PROPOSED',
      required_fields: [],
      core_fields: ['document.number', 'document.issue_date'],
      optional_fields: [],
      conditional_fields: [],
      literal_evidence_required: true,
      unknown_value_policy: 'LEAVE_EMPTY',
      review_policy: 'REVIEW_LOW_CONFIDENCE_MISSING_REQUIRED_CONFLICTS_ONLY'
    },
    'hr.unilav': {
      document_type_id: 'hr.unilav',
      canonical_name: 'unilav',
      family: 'hr',
      schema_state: 'EXTRACTION_SCHEMA_READY_FOR_FIELD_TEST',
      evidence_basis: 'REAL_DOCUMENT_EVIDENCE',
      required_fields: ['employment.employee_name'],
      core_fields: [],
      optional_fields: [],
      conditional_fields: [],
      literal_evidence_required: true,
      unknown_value_policy: 'LEAVE_EMPTY',
      review_policy: 'REVIEW_LOW_CONFIDENCE_MISSING_REQUIRED_CONFLICTS_ONLY'
    }
  }
}

const HINTS = {
  version: '2.0.0',
  hints: { 'document.number': { labels: ['Numero documento'], regexes: [] } }
}

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'reviewer-profiles-'))
  created.push(directory)
  writeFileSync(join(directory, PROFILES_FILE), serializeRegistryJson(PROFILES), 'utf8')
  writeFileSync(join(directory, HINTS_FILE), serializeRegistryJson(HINTS), 'utf8')
  return directory
}

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim()
}

function makeRepository(): string {
  const directory = makeDirectory()
  git(directory, 'init', '--quiet', '--initial-branch=main')
  git(directory, 'config', 'user.email', 'test@example.com')
  git(directory, 'config', 'user.name', 'Test')
  git(directory, 'config', 'commit.gpgsign', 'false')
  // Un file che nessuna correzione tocca: serve a provare che il commit non se lo porta.
  writeFileSync(join(directory, 'NOTE.md'), 'appunti\n', 'utf8')
  git(directory, 'add', '.')
  git(directory, 'commit', '--quiet', '-m', 'snapshot iniziale')
  return directory
}

const COMMIT = {
  subject: 'profile(accounting.fattura): rimuove document.number, mai usato su 12 documenti',
  body: 'Numeri su 12 documenti annotati: 0 confermati, 0 corretti, 0 a mano.'
}

function corrected() {
  const profiles = structuredClone(PROFILES)
  profiles.profiles['accounting.fattura'].core_fields = ['document.issue_date']
  return [{ name: PROFILES_FILE, content: serializeRegistryJson(profiles) }]
}

describe('i JSON del registry in un repo git', () => {
  it('riscrive il file e ne fa un commit dedicato, senza tirarsi dietro nient’altro', () => {
    const directory = makeRepository()
    // Lavoro in corso di qualcun altro, già in staging: non deve finire nel commit.
    writeFileSync(join(directory, 'NOTE.md'), 'appunti modificati\n', 'utf8')
    git(directory, 'add', 'NOTE.md')

    const outcome = writeProfileFiles({ directory, files: corrected(), commit: COMMIT })

    expect(outcome.mode).toBe('COMMITTED')
    expect(git(directory, 'log', '-1', '--format=%s')).toBe(COMMIT.subject)
    expect(git(directory, 'log', '-1', '--format=%b')).toContain('Numeri su 12 documenti')
    expect(git(directory, 'show', '--name-only', '--format=', 'HEAD')).toBe(PROFILES_FILE)
    // Il lavoro in corso è ancora lì, ancora in staging.
    expect(git(directory, 'diff', '--cached', '--name-only')).toBe('NOTE.md')
  })

  it('lascia un JSON valido, con la correzione fatta e nessun profilo perso', () => {
    const directory = makeRepository()
    writeProfileFiles({ directory, files: corrected(), commit: COMMIT })

    const source = readRegistrySourceFiles(directory)
    expect(Object.keys(source.profiles.profiles)).toEqual(['accounting.fattura', 'hr.unilav'])
    expect(source.profiles.profiles['accounting.fattura']!.core_fields).toEqual([
      'document.issue_date'
    ])
    expect(source.profiles.profiles['hr.unilav']).toEqual(PROFILES.profiles['hr.unilav'])
    expect(source.profiles.active_registry_source).toBe('Document Brain 496 active classes')
    expect(source.hints).toEqual(HINTS)
  })

  it('il diff è solo la riga cambiata, non tutto il file', () => {
    const directory = makeRepository()
    writeProfileFiles({ directory, files: corrected(), commit: COMMIT })
    const diff = git(directory, 'show', '--format=', '--unified=0', 'HEAD')
      .split('\n')
      .filter((line) => /^[+-][^+-]/.test(line))
    expect(diff).toEqual(['-        "document.number",'])
  })

  it('dichiara in anticipo che la correzione diventerà un commit', () => {
    const status = profileStoreStatus(makeRepository())
    expect(status).toMatchObject({ writable: true, mode: 'COMMITTED' })
    expect(status.repositoryRoot).not.toBeNull()
  })
})

describe('fuori da un repo git', () => {
  it('scrive comunque il file e lo dice, invece di perdere la correzione', () => {
    const directory = makeDirectory()
    expect(profileStoreStatus(directory).mode).toBe('WRITTEN')

    const outcome = writeProfileFiles({ directory, files: corrected(), commit: COMMIT })
    expect(outcome.mode).toBe('WRITTEN')
    if (outcome.mode !== 'WRITTEN') throw new Error('atteso WRITTEN')
    expect(outcome.reason).toContain('non sta in un repository git')
    expect(
      readRegistrySourceFiles(directory).profiles.profiles['accounting.fattura']!.core_fields
    ).toEqual(['document.issue_date'])
  })
})

describe('cartella di sola lettura, come nell’app impacchettata', () => {
  it('non scrive niente e restituisce il JSON corretto da sostituire a mano', () => {
    const directory = makeDirectory()
    const before = readFileSync(join(directory, PROFILES_FILE), 'utf8')
    chmodSync(join(directory, PROFILES_FILE), 0o444)
    chmodSync(join(directory, HINTS_FILE), 0o444)
    chmodSync(directory, 0o555)

    expect(profileStoreStatus(directory).mode).toBe('EXPORT_REQUIRED')

    const outcome = writeProfileFiles({ directory, files: corrected(), commit: COMMIT })
    expect(outcome.mode).toBe('EXPORT_REQUIRED')
    if (outcome.mode !== 'EXPORT_REQUIRED') throw new Error('atteso EXPORT_REQUIRED')
    expect(outcome.reason).toContain('sola lettura')
    expect(outcome.files[0]!.name).toBe(PROFILES_FILE)
    expect(
      JSON.parse(outcome.files[0]!.content).profiles['accounting.fattura'].core_fields
    ).toEqual(['document.issue_date'])
    // Il file sul disco non è stato toccato.
    expect(readFileSync(join(directory, PROFILES_FILE), 'utf8')).toBe(before)
  })
})

describe('lettura dei JSON sorgente', () => {
  it('riscrive i file veri del registry byte per byte', () => {
    const source = readRegistrySourceFiles(REGISTRY_V2_DIR)
    expect(serializeRegistryJson(source.profiles)).toBe(
      readFileSync(join(REGISTRY_V2_DIR, PROFILES_FILE), 'utf8')
    )
    expect(serializeRegistryJson(source.hints)).toBe(
      readFileSync(join(REGISTRY_V2_DIR, HINTS_FILE), 'utf8')
    )
  })

  it('un file senza le liste dei ruoli si ferma con un messaggio che dice dove', () => {
    expect(() =>
      parseProfilesFile({ version: '1', profiles: { 'a.b': { required_fields: [] } } })
    ).toThrow(/«a.b.core_fields»/)
    expect(() => parseProfilesFile({ version: '1' })).toThrow(/«version» e «profiles»/)
    expect(() => parseHintsFile({ version: '1', hints: { 'a.b': {} } })).toThrow(/«labels»/)
  })
})
