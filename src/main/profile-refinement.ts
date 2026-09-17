import { existsSync } from 'node:fs'
import { measureDelta } from '@shared/profile-metrics'
import {
  describeRerun,
  type SkippedDocument,
  type TypeRerunResult
} from '@shared/profile-workspace'
import type { DocumentProcessor } from './drive/fetch'
import { logError, ReviewerError } from './errors'
import type { ReloadableExtractionRegistryV2 } from './extract/v2/profile-loader'
import { collectTypeMeasure } from './profile-insights'
import type { ProfileMapDeps } from './profile-map'

/**
 * La rielaborazione che chiude il giro: la mappa è cambiata, i documenti già annotati si
 * rifanno dalla cache e i numeri dicono se la correzione è servita.
 *
 * La correzione in sé non passa più di qui — sta nel database (`profile-map.ts`) e il
 * registry la applica a ogni lettura — quindi il re-run non ha niente da ricaricare:
 * elabora e basta, con la mappa che il revisore vede sullo schermo.
 */

export interface RefinementDeps extends ProfileMapDeps {
  registry: ReloadableExtractionRegistryV2
  /** Classificazione e precompilazione: serve solo al re-run. */
  process?: DocumentProcessor | undefined
  fileExists?: (path: string) => boolean
}

/**
 * Rilancia l'estrazione sui documenti già annotati di un tipo e confronta i numeri.
 *
 * Solo `REVIEWED` e solo dalla cache: nessun file viene riscaricato. Le correzioni umane
 * sopravvivono perché è la pipeline di sempre a rielaborare — `replaceForDocument` tiene
 * le correzioni per nome del campo, esattamente come quando si cambia tipo a mano.
 *
 * Un errore su un documento non ferma gli altri: finisce nel log e nella lista dei
 * falliti, e il delta si calcola su quello che è passato.
 */
export async function rerunTypeExtraction(
  deps: RefinementDeps,
  documentType: string
): Promise<TypeRerunResult> {
  if (!deps.process) {
    throw new ReviewerError('UNSUPPORTED', 'Rielaborazione non disponibile su questa istanza.')
  }

  const before = collectTypeMeasure(deps, documentType)
  if (!before) {
    throw new ReviewerError(
      'NOT_FOUND',
      `Nessun documento annotato di tipo «${documentType}»: non c'è niente da rielaborare.`
    )
  }

  const fileExists = deps.fileExists ?? existsSync
  const processed: string[] = []
  const skipped: SkippedDocument[] = []
  const failed: SkippedDocument[] = []

  for (const row of deps.repo.documents.list({ status: 'REVIEWED', documentType })) {
    if (!row.cached_path || !fileExists(row.cached_path)) {
      skipped.push({
        documentId: row.id,
        filename: row.filename,
        reason: 'la copia locale non c’è più: riaprilo da Drive per rielaborarlo.'
      })
      continue
    }
    try {
      await deps.process({
        documentId: row.id,
        cachedPath: row.cached_path,
        mime: row.mime,
        filename: row.filename
      })
      processed.push(row.id)
    } catch (error) {
      logError('profiles.rerun', error)
      failed.push({
        documentId: row.id,
        filename: row.filename,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const retyped = processed.filter(
    (documentId) => deps.repo.documents.get(documentId)?.document_type !== documentType
  )

  const after = collectTypeMeasure(deps, documentType) ?? {
    ...before,
    fields: [],
    documents: [],
    totals: { ...before.totals, documents: 0 }
  }

  const result: TypeRerunResult = {
    documentType,
    processed,
    skipped,
    failed,
    retyped,
    before,
    after,
    delta: measureDelta(before, after)
  }

  // Anche la rielaborazione finisce in cronologia: è quella che dice se una correzione
  // ha spostato i numeri, e senza la riga il prima/dopo resta solo sullo schermo.
  deps.repo.profileMap.addAction({
    kind: 'RERUN',
    documentType,
    detail: describeRerun(result)
  })

  return result
}
