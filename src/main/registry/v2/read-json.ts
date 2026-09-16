import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { z } from 'zod'

/**
 * Legge un JSON del registry v2 e ne controlla la forma.
 *
 * I motori v2 girano sul percorso normale: un file mancante o scritto male deve
 * fermare l'avvio con un messaggio che dica quale file e cosa non va, non esplodere
 * alla prima estrazione con un `Cannot read properties of undefined`.
 */
export function readRegistryJson<T>(directory: string, file: string, schema: z.ZodType<T>): T {
  const path = join(directory, file)
  if (!existsSync(path)) {
    throw new Error(`Registry v2: manca ${file} in ${directory}.`)
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Registry v2: ${file} non è JSON valido (${detail}).`)
  }

  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? issue.path.join('.') : 'radice'
    throw new Error(
      `Registry v2: ${file} ha una struttura inattesa in «${where}»: ${issue?.message ?? 'non valido'}.`
    )
  }
  return parsed.data
}
