import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Cardinality } from '@shared/extraction-v2'
import {
  buildProfileBundle,
  type ProfileBundle,
  type ProfileBundleManifestInput,
  type RawProfile
} from '@shared/profile-bundle'
import {
  type ProfileEdit,
  ProfileEditError,
  type ProfileEditReason,
  planProfileEdit,
  stateOf
} from '@shared/profile-edit'
import {
  type ActivityEntry,
  actionTrack,
  buildActivity,
  type ProfileAction
} from '@shared/profile-history'
import type { ProfileTypeMeasure } from '@shared/profile-metrics'
import type { FieldState, MapValue, ProfileOverlay } from '@shared/profile-overlay'
import { ReviewerError } from './errors'
import { collectTypeMeasure, type ProfileInsightsDeps } from './profile-insights'
import { readRegistrySourceFiles } from './registry-source'

/**
 * Le correzioni alla mappa «tipo documento ↔ dati da estrarre», applicate al database.
 *
 * Una correzione qui non scrive nessun file e non fa nessun commit: scrive una riga di
 * decisione, una riga di cronologia, e da quel momento il motore vede la mappa corretta
 * (l'overlay in `@shared/profile-overlay`, che il registry applica a ogni lettura). I
 * file per pratica-ai si producono quando il revisore esporta, e l'export non cambia
 * niente di quello che c'è qui dentro.
 *
 * Le regole di cosa sia una correzione valida stanno nel modulo puro
 * (`@shared/profile-edit`): questo file mette insieme il database, i numeri delle
 * annotazioni e l'ontologia, e scrive.
 */

export interface ProfileMapDeps extends ProfileInsightsDeps {
  /** La cartella del registry v2, letta e mai scritta. */
  registryDirectory: string
}

const NO_NUMBERS: ProfileEditReason = { documents: 0, confirmed: 0, corrected: 0, manual: 0 }

/** I numeri di un campo al momento della correzione: finiscono in cronologia con lei. */
export function reasonFor(measure: ProfileTypeMeasure | null, fieldId: string): ProfileEditReason {
  if (!measure) return NO_NUMBERS
  const field = measure.fields.find((candidate) => candidate.fieldId === fieldId)
  return {
    documents: measure.totals.documents,
    confirmed: field?.confirmed ?? 0,
    corrected: field?.corrected ?? 0,
    manual: field?.manual ?? 0
  }
}

function fieldRef(deps: ProfileMapDeps, fieldId: string) {
  const spec = deps.registry.field(fieldId)
  return spec
    ? {
        id: spec.id,
        label: spec.label_it,
        aliases: spec.label_aliases_it,
        cardinality: spec.default_cardinality
      }
    : null
}

/**
 * Scrive (o toglie, con `null`) la decisione su un campo: il peso su `profile_overrides`,
 * la cardinalità sulla sua tabella. Le due non si toccano mai a vicenda.
 */
function writeDecision(
  deps: ProfileMapDeps,
  cardinality: boolean,
  documentType: string,
  fieldId: string,
  decision: { value: MapValue | null; at: string }
): void {
  const map = deps.repo.profileMap
  if (decision.value === null) {
    if (cardinality) map.clearCardinality(documentType, fieldId)
    else map.clearOverride(documentType, fieldId)
  } else if (cardinality) {
    map.setCardinality(documentType, fieldId, decision.value as Cardinality, decision.at)
  } else {
    map.setOverride(documentType, fieldId, decision.value as FieldState, decision.at)
  }
}

/**
 * Applica una correzione e la registra.
 *
 * Decisione e cronologia in una transazione sola: una mappa cambiata senza la riga che
 * dice perché sarebbe peggio di una correzione non fatta.
 */
export function editProfileMap(deps: ProfileMapDeps, edit: ProfileEdit): ProfileAction {
  const { repo, registry } = deps
  const base = registry.baseProfile(edit.documentType)
  if (!base) {
    throw new ReviewerError(
      'NOT_FOUND',
      `Il tipo «${edit.documentType}» non ha un profilo nel registry: non c'è una mappa da correggere.`
    )
  }

  const measure = collectTypeMeasure(deps, edit.documentType)
  const overrides = repo.profileMap.forType(edit.documentType)

  let plan: ReturnType<typeof planProfileEdit>
  try {
    plan = planProfileEdit({
      edit,
      profile: base,
      overrides,
      cardinality: repo.profileMap.cardinalityForType(edit.documentType),
      hintLabels: registry.hints(edit.fieldId),
      field: fieldRef(deps, edit.fieldId),
      reason: reasonFor(measure, edit.fieldId)
    })
  } catch (error) {
    if (error instanceof ProfileEditError) throw new ReviewerError('INVALID_INPUT', error.message)
    throw error
  }

  const at = new Date().toISOString()
  return repo.transaction(() => {
    if (edit.kind === 'ADD_HINT_LABEL' && plan.label) {
      repo.profileMap.addHintLabel(edit.fieldId, plan.label, edit.documentType, at)
    } else {
      writeDecision(deps, edit.kind === 'SET_CARDINALITY', edit.documentType, edit.fieldId, {
        value: plan.override,
        at
      })
    }

    return repo.profileMap.addAction({
      kind: edit.kind,
      at,
      documentType: edit.documentType,
      fieldId: edit.fieldId,
      label: plan.label,
      before: plan.before,
      after: plan.after,
      previousOverride: plan.previousOverride,
      detail: plan.detail,
      reason: plan.reason
    })
  })
}

/**
 * Annulla un'azione della cronologia, rimettendo lo stato che c'era prima di lei.
 *
 * L'azione annullata resta dov'è, marcata: la cronologia non si riscrive, ci si aggiunge
 * sopra. Si annulla solo l'ultima azione su un campo — controllato qui, non solo nella
 * UI — perché rimettere uno stato vecchio sotto una decisione più recente lascerebbe la
 * mappa a dire una cosa e la cronologia un'altra.
 */
export function revertProfileAction(deps: ProfileMapDeps, actionId: string): ProfileAction {
  const { repo } = deps
  const action = repo.profileMap.getAction(actionId)
  if (!action) throw new ReviewerError('NOT_FOUND', 'Questa azione non è più in cronologia.')
  if (action.revertedAt) {
    throw new ReviewerError('INVALID_INPUT', 'Questa azione è già stata annullata.')
  }
  if (!action.documentType || !action.fieldId) {
    throw new ReviewerError('INVALID_INPUT', 'Questa azione non ha cambiato la mappa.')
  }

  // Le azioni arrivano dalla più recente: quelle che si incontrano prima di questa sono
  // più nuove di lei. Non si confrontano i timestamp — due correzioni di fila cadono
  // nello stesso millisecondo — ma l'ordine in cui sono state scritte. Conta solo la
  // stessa decisione: un peso cambiato dopo non blocca l'annullamento di una cardinalità.
  const track = actionTrack(action.kind)
  const newer: ProfileAction[] = []
  for (const candidate of repo.profileMap.listActions()) {
    if (candidate.id === action.id) break
    if (
      candidate.documentType === action.documentType &&
      candidate.fieldId === action.fieldId &&
      track !== 'HINT' &&
      actionTrack(candidate.kind) === track &&
      candidate.revertedAt === null
    ) {
      newer.push(candidate)
    }
  }
  if (action.kind !== 'ADD_HINT_LABEL' && newer.length > 0) {
    throw new ReviewerError(
      'INVALID_INPUT',
      `Su questo campo c'è una decisione più recente: annulla prima quella. (${newer[0]?.detail})`
    )
  }

  const at = new Date().toISOString()
  return repo.transaction(() => {
    if (action.kind === 'ADD_HINT_LABEL' && action.label) {
      repo.profileMap.removeHintLabel(action.fieldId as string, action.label)
    } else {
      // Esattamente la riga che c'era prima: nessuna, se il campo seguiva il registry.
      writeDecision(
        deps,
        action.kind === 'SET_CARDINALITY',
        action.documentType as string,
        action.fieldId as string,
        { value: action.previousOverride, at }
      )
    }

    repo.profileMap.markReverted(action.id, at)
    return repo.profileMap.addAction({
      kind: 'REVERT',
      at,
      documentType: action.documentType,
      fieldId: action.fieldId,
      label: action.label,
      before: action.after,
      after: action.before,
      previousOverride: action.after ?? null,
      detail: `Annullata: ${action.detail}`,
      revertsId: action.id,
      reason: action.reason
    })
  })
}

// ---------------------------------------------------------------------------
// Cronologia
// ---------------------------------------------------------------------------

/** La cronologia unica: azioni sulla mappa ed eventi dei documenti, dal più recente. */
export function collectActivity(deps: ProfileMapDeps, limit = 400): ActivityEntry[] {
  const actions = deps.repo.profileMap.listActions(limit)
  const events = deps.repo.events.listRecent(limit).map((row) => ({
    id: row.id,
    at: row.at,
    documentId: row.document_id,
    filename: row.filename,
    documentType: row.document_type,
    title: row.title,
    detail: row.detail
  }))
  return buildActivity(actions, events).slice(0, limit)
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ProfileBundleResult extends ProfileBundle {
  directory: string
  paths: string[]
}

/**
 * Scrive i file della mappa corretta nella cartella scelta dal revisore.
 *
 * I JSON del registry si rileggono adesso dal disco — non si riusa quello che il motore
 * ha in memoria — così l'export dice sempre cosa c'è sul disco più cosa c'è nel
 * database, e due export di fila danno gli stessi byte.
 */
export async function exportProfileBundle(
  deps: ProfileMapDeps,
  manifest: ProfileBundleManifestInput,
  directory: string
): Promise<ProfileBundleResult> {
  const { repo, registry } = deps
  const source = readRegistrySourceFiles(deps.registryDirectory)
  const overlay: ProfileOverlay = repo.profileMap.overlay()

  // I tipi corretti che il file dei profili non prevede: senza il profilo sintetizzato
  // le loro correzioni non uscirebbero da nessuna parte.
  const fallbackProfiles: Record<string, RawProfile> = {}
  for (const documentType of repo.profileMap.touchedTypes()) {
    if (source.profiles.profiles[documentType]) continue
    const base = registry.baseProfile(documentType)
    if (base) fallbackProfiles[documentType] = base as unknown as RawProfile
  }

  const ontology = Object.fromEntries(registry.allFields().map((field) => [field.id, field]))

  const bundle = buildProfileBundle({
    manifest,
    profiles: source.profiles,
    hints: source.hints,
    overlay,
    ontology,
    fallbackProfiles,
    actions: repo.profileMap.allActions()
  })

  await mkdir(directory, { recursive: true })
  const paths: string[] = []
  for (const file of bundle.files) {
    const path = join(directory, file.name)
    await writeFile(path, file.content, 'utf8')
    paths.push(path)
  }

  repo.profileMap.addAction({
    kind: 'EXPORT',
    detail: `Mappa esportata in ${directory}: ${bundle.types} tipi corretti, ${bundle.fields} campi decisi.`
  })

  return { ...bundle, directory, paths }
}

/** Lo stato di un campo per un tipo, come lo vede il revisore adesso. */
export function fieldStateOf(
  deps: ProfileMapDeps,
  documentType: string,
  fieldId: string
): FieldState | null {
  return stateOf(
    deps.registry.baseProfile(documentType),
    deps.repo.profileMap.forType(documentType),
    fieldId
  )
}
