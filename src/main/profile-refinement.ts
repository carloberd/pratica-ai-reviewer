import { existsSync } from 'node:fs'
import type { ProfileEdit } from '@shared/profile-edit'
import { type ProfileAction, revertableActions } from '@shared/profile-history'
import type { MapEditResult, TypeFieldMap } from '@shared/profile-workspace'
import type { DocumentRow } from './db/rows'
import type { DocumentProcessor } from './drive/fetch'
import { logError, ReviewerError } from './errors'
import type { ReloadableExtractionRegistryV2 } from './extract/v2/profile-loader'
import { collectTypeMap } from './profile-insights'
import { editProfileMap, type ProfileMapDeps, revertProfileAction } from './profile-map'
import { reprocessCachedDocuments } from './reprocess'

/**
 * La mappa «tipo ↔ dati da estrarre» corretta dal documento che il revisore ha aperto.
 *
 * Il giro è uno solo e non lascia la revisione: il revisore vede un campo che manca o che
 * non serve, lo corregge dalla scheda «Campi da estrarre», il documento si rielabora con la
 * mappa nuova e la scheda «Dati» mostra già i campi giusti. La correzione in sé sta nel
 * database (`profile-map.ts`) e il registry la applica a ogni lettura; qui si decide cosa
 * rielaborare dopo.
 */

export interface RefinementDeps extends ProfileMapDeps {
  registry: ReloadableExtractionRegistryV2
  /** Classificazione e precompilazione: senza, la correzione vale dal prossimo documento. */
  process?: DocumentProcessor | undefined
  fileExists?: (path: string) => boolean
}

function documentRow(deps: RefinementDeps, documentId: string): DocumentRow {
  const row = deps.repo.documents.get(documentId)
  if (!row) throw new ReviewerError('NOT_FOUND', 'Documento non trovato.')
  return row
}

/** Il tipo del documento, che è quello di cui si corregge la mappa. */
function typeOf(row: DocumentRow): string {
  if (!row.document_type) {
    throw new ReviewerError(
      'INVALID_INPUT',
      'Il documento non ha ancora un tipo: assegnalo in «Dati» e poi correggi i campi da estrarre.'
    )
  }
  return row.document_type
}

/** La mappa del tipo, pronta per la scheda. */
export function typeFieldMap(deps: RefinementDeps, documentType: string): TypeFieldMap {
  const { registry, repo } = deps
  const actions = repo.profileMap.listActions()
  const undoable = revertableActions(actions)
  return {
    documentType,
    measure: collectTypeMap(deps, documentType),
    editable: registry.baseProfile(documentType) !== null,
    // Tutti i campi dell'ontologia, non solo quelli già visti su un documento: un tipo
    // può avere bisogno di un dato che nessuna annotazione ha ancora prodotto.
    ontology: registry.allFields().map((field) => ({
      id: field.id,
      label: field.label_it,
      hint:
        field.description && field.description !== field.label_it
          ? `${field.id} · ${field.description}`
          : field.id
    })),
    undoable: actions.filter(
      (action) => action.documentType === documentType && undoable.has(action.id)
    )
  }
}

/** La mappa del tipo del documento aperto. */
export function documentFieldMap(deps: RefinementDeps, documentId: string): TypeFieldMap {
  return typeFieldMap(deps, typeOf(documentRow(deps, documentId)))
}

/** Rielabora un documento dalla cache. `false` se la copia locale non c'è più. */
async function reprocess(deps: RefinementDeps, row: DocumentRow): Promise<boolean> {
  const fileExists = deps.fileExists ?? existsSync
  if (!deps.process || !row.cached_path || !fileExists(row.cached_path)) return false
  await deps.process({
    documentId: row.id,
    cachedPath: row.cached_path,
    mime: row.mime,
    filename: row.filename
  })
  return true
}

/**
 * Le rielaborazioni in sottofondo passano una alla volta: due correzioni di fila non
 * devono elaborare lo stesso documento due volte in parallelo.
 */
let background: Promise<unknown> = Promise.resolve()

/**
 * Gli altri documenti ancora in coda dello stesso tipo si rielaborano in sottofondo, così
 * il prossimo che il revisore apre ha già i campi della mappa nuova. I documenti già
 * salvati o scartati non si toccano: il loro tipo e i loro campi sono il dato consegnato.
 */
export function reprocessQueueOfType(
  deps: RefinementDeps,
  documentType: string,
  exceptId: string | null
): { queued: number; done: Promise<unknown> } {
  const fileExists = deps.fileExists ?? existsSync
  const { process } = deps
  const ids = new Set(
    deps.repo.documents
      .list({ status: 'NEEDS_REVIEW', documentType })
      .filter((row) => row.id !== exceptId && row.cached_path && fileExists(row.cached_path))
      .map((row) => row.id)
  )
  // `done` è la coda intera, non solo questo giro: chi aspetta, aspetta tutto quello che c'è.
  if (!process || ids.size === 0) return { queued: 0, done: background }

  background = background
    .then(() =>
      reprocessCachedDocuments({
        repo: deps.repo,
        process,
        fileExists,
        // Riletto al momento: nel frattempo il revisore può aver salvato il documento o
        // avergli cambiato tipo, e allora non va più toccato.
        isStale: (row) =>
          ids.has(row.id) && row.status === 'NEEDS_REVIEW' && row.document_type === documentType
      })
    )
    .catch((error) => logError('profiles.queue', error))
  return { queued: ids.size, done: background }
}

async function afterMapChange(
  deps: RefinementDeps,
  documentId: string,
  documentType: string,
  action: ProfileAction
): Promise<MapEditResult> {
  const reprocessed = await reprocess(deps, documentRow(deps, documentId))
  const { queued } = reprocessQueueOfType(deps, documentType, documentId)
  const document = deps.repo.getReviewDocument(documentId)
  if (!document) throw new ReviewerError('NOT_FOUND', 'Documento non trovato.')
  return { action, document, map: typeFieldMap(deps, documentType), reprocessed, queued }
}

/**
 * Una correzione alla mappa del tipo del documento aperto, e subito la rielaborazione di
 * quel documento: il revisore torna a «Dati» e trova i campi della mappa nuova, con le
 * correzioni che aveva già fatto.
 */
export async function editMapFromDocument(
  deps: RefinementDeps,
  documentId: string,
  edit: ProfileEdit
): Promise<MapEditResult> {
  const documentType = typeOf(documentRow(deps, documentId))
  if (edit.documentType !== documentType) {
    throw new ReviewerError(
      'INVALID_INPUT',
      `Il documento è di tipo «${documentType}»: da qui si corregge solo la sua mappa.`
    )
  }
  const action = editProfileMap(deps, edit)
  return afterMapChange(deps, documentId, documentType, action)
}

/** Annulla una correzione dal documento aperto, e lo rielabora con la mappa di prima. */
export async function revertMapFromDocument(
  deps: RefinementDeps,
  documentId: string,
  actionId: string
): Promise<MapEditResult> {
  const documentType = typeOf(documentRow(deps, documentId))
  const target = deps.repo.profileMap.getAction(actionId)
  if (target && target.documentType !== documentType) {
    throw new ReviewerError(
      'INVALID_INPUT',
      `Questa correzione riguarda «${target.documentType}»: annullala dalla Cronologia.`
    )
  }
  const action = revertProfileAction(deps, actionId)
  return afterMapChange(deps, documentId, documentType, action)
}
