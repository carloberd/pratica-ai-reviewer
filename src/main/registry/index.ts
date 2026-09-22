import { join } from 'node:path'

/**
 * Dove vive il registry: accanto all'app impacchettata, nel repo in sviluppo.
 *
 * Il registry è due file — `fields.json`, i campi, e `document_fields.json`, quali campi
 * vuole ogni tipo — e li legge `@main/extract/v2/profile-loader`. Qui resta solo dove
 * cercarli, perché `paths.ts` non può importare il caricatore senza tirarsi dietro zod
 * e mezzo motore.
 */
export function registryDirectory(
  appPath: string,
  resourcesPath: string,
  packaged: boolean
): string {
  return packaged ? join(resourcesPath, 'registry') : join(appPath, 'resources', 'registry')
}
