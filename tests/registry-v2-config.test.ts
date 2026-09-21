import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CLASSIFIER_SIGNALS_FILE, loadClassifierConfigV2 } from '../src/main/registry/v2/config'
import { readRegistryJson } from '../src/main/registry/v2/read-json'
import { REGISTRY_V2_DIR } from './helpers/registry'

const dirs: string[] = []

function tempDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'registry-v2-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('configurazione del classificatore v2', () => {
  it('carica il file reale con soglie e 17 classi', () => {
    const config = loadClassifierConfigV2(REGISTRY_V2_DIR)
    expect(config.defaults.auto_assign_threshold).toBe(0.74)
    expect(config.defaults.minimum_margin).toBe(0.08)
    expect(Object.keys(config.classes)).toHaveLength(17)
  })

  it('un file mancante ferma l’avvio dicendo quale', () => {
    const dir = tempDir()
    expect(() => loadClassifierConfigV2(dir)).toThrow(
      `Registry v2: manca ${CLASSIFIER_SIGNALS_FILE} in ${dir}.`
    )
  })

  it('un JSON rotto ferma l’avvio dicendo quale file', () => {
    const dir = tempDir({ [CLASSIFIER_SIGNALS_FILE]: '{ "version": ' })
    expect(() => loadClassifierConfigV2(dir)).toThrow(
      new RegExp(`^Registry v2: ${CLASSIFIER_SIGNALS_FILE} non è JSON valido`)
    )
  })

  it('una struttura inattesa indica il percorso della chiave sbagliata', () => {
    const dir = tempDir({
      [CLASSIFIER_SIGNALS_FILE]: JSON.stringify({
        version: '1',
        defaults: { auto_assign_threshold: 'alta' },
        classes: {}
      })
    })
    expect(() => loadClassifierConfigV2(dir)).toThrow(
      /struttura inattesa in «defaults\.auto_assign_threshold»/
    )
  })
})

describe('lettura dei JSON del registry', () => {
  it('restituisce il dato validato', () => {
    const dir = tempDir({ 'x.json': '{"version":"2"}' })
    expect(readRegistryJson(dir, 'x.json', z.object({ version: z.string() }))).toEqual({
      version: '2'
    })
  })

  it('un errore sulla radice non lascia il percorso vuoto', () => {
    const dir = tempDir({ 'x.json': '[]' })
    expect(() => readRegistryJson(dir, 'x.json', z.object({ version: z.string() }))).toThrow(
      /in «radice»/
    )
  })
})
